import process from 'node:process';

import { Downloader } from './downloader.js';
import { encodeNativeMessage, NativeMessageDecoder } from './framing.js';
import { createDiagnosticLogger } from './logger.js';
import type { NativeMessage } from './protocol.js';
import { resolveToolPaths } from './tools.js';
import { validateRequest, ValidationError } from './validation.js';

const VERSION = '0.1.0';
const CAPABILITIES = {
  hls: true,
  dash: true,
  cancel: true,
  streamCopy: true,
  progress: true,
};
const decoder = new NativeMessageDecoder();
const logger = createDiagnosticLogger();
const tools = resolveToolPaths();
let shuttingDown = false;

logger.log('host.started', {
  version: VERSION,
  executable: process.execPath,
  ffmpeg: tools.ffmpeg,
  ffprobe: tools.ffprobe,
  processId: process.pid,
});

function send(message: NativeMessage): void {
  process.stdout.write(encodeNativeMessage(message));
}

const downloader = new Downloader(tools, {
  progress(jobId, progress) {
    send({ type: 'download.progress', jobId, progress });
  },
  completed(jobId, outputFilename) {
    send({ type: 'download.completed', jobId, outputFilename });
  },
  failed(jobId, error) {
    send({ type: 'download.failed', jobId, error });
  },
  cancelled(jobId) {
    send({ type: 'download.cancelled', jobId });
  },
  diagnostic(event, details) {
    logger.log(event, details);
  },
});

function handleRequest(value: unknown): void {
  let requestId = 'invalid-request';
  if (
    typeof value === 'object' &&
    value !== null &&
    'requestId' in value &&
    typeof value.requestId === 'string'
  ) {
    requestId = value.requestId;
  }

  try {
    const request = validateRequest(value);
    requestId = request.requestId;

    if (request.type === 'hello') {
      logger.log('browser.handshake', { requestId });
      send({
        type: 'response',
        requestId,
        ok: true,
        version: VERSION,
        capabilities: CAPABILITIES,
      });
      return;
    }

    if (request.type === 'download.start') {
      try {
        downloader.start(request.job);
        send({ type: 'response', requestId, ok: true });
      } catch {
        logger.log('download.rejected', {
          jobId: request.job.jobId,
          reason: 'busy',
        });
        send({
          type: 'response',
          requestId,
          ok: false,
          error: 'BUSY: Another download is already active.',
        });
      }
      return;
    }

    const accepted = downloader.cancel(request.jobId);
    logger.log('download.cancel-requested', {
      jobId: request.jobId,
      accepted,
    });
    send({
      type: 'response',
      requestId,
      ok: accepted,
      ...(!accepted ? { error: 'NOT_ACTIVE: The requested job is not active.' } : {}),
    });
  } catch (error) {
    logger.log('request.rejected', { error });
    send({
      type: 'response',
      requestId,
      ok: false,
      error: error instanceof ValidationError
        ? `INVALID_REQUEST: ${error.message}`
        : 'INVALID_REQUEST: The request could not be processed.',
    });
  }
}

process.stdin.on('data', (chunk: Buffer) => {
  try {
    for (const value of decoder.push(chunk)) {
      handleRequest(value);
    }
  } catch {
    logger.log('protocol.invalid-frame');
    process.stderr.write('The browser sent an invalid native-messaging frame.\n');
    process.exitCode = 1;
    process.stdin.pause();
  }
});

function shutdown(): void {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.log('host.stopping');
  downloader.shutdown();
}

process.stdin.once('end', shutdown);
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.once('exit', shutdown);
