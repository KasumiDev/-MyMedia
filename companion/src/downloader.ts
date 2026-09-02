import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { redactDiagnostic } from './logger.js';
import { chooseBestStreams, parseProgressBlock, type ProbeResult } from './media.js';
import type { DownloadJob, DownloadProgress } from './protocol.js';
import type { ToolPaths } from './tools.js';

interface DownloadCallbacks {
  progress: (jobId: string, progress: DownloadProgress) => void;
  completed: (jobId: string, outputFilename: string) => void;
  failed: (jobId: string, error: string) => void;
  cancelled: (jobId: string) => void;
  diagnostic: (event: string, details?: Record<string, unknown>) => void;
}

interface ActiveJob {
  job: DownloadJob;
  child: ChildProcessWithoutNullStreams | undefined;
  cancelled: boolean;
  outputDirectory: string;
  partialPath: string;
}

type SpawnProcess = typeof spawn;

const MAX_PROBE_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_MANIFEST_CAPTURE_BYTES = 64 * 1024;
const FANSLY_ORIGIN = 'https://fansly.com';
const FANSLY_REFERER = `${FANSLY_ORIGIN}/`;

export function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message === 'NO_VIDEO_STREAM') {
    return 'NO_VIDEO_STREAM: The manifest contains no downloadable video stream.';
  }

  if (/encrypt|decrypt|sample-aes|drm|crypto/iu.test(message)) {
    return 'ENCRYPTED_MEDIA: Encrypted or DRM-protected media is not supported.';
  }

  if (/ENOENT/iu.test(message)) {
    return 'MEDIA_TOOL_NOT_FOUND: FFmpeg or FFprobe could not be started.';
  }

  if (/OUTPUT_EXISTS/iu.test(message)) {
    return 'OUTPUT_EXISTS: A file with this name already exists.';
  }

  if (/HTTP error 40[13]|Forbidden|Unauthorized/iu.test(message)) {
    return 'CDN_AUTHORIZATION_FAILED: CloudFront authorization expired or was rejected.';
  }

  return 'DOWNLOAD_FAILED: FFmpeg could not download this manifest.';
}

async function fileExists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export class Downloader {
  private active: ActiveJob | undefined;

  constructor(
    private readonly tools: ToolPaths,
    private readonly callbacks: DownloadCallbacks,
    private readonly spawnProcess: SpawnProcess = spawn,
    private readonly downloadsRoot = path.join(os.homedir(), 'Downloads'),
  ) {}

  get activeJobId(): string | undefined {
    return this.active?.job.jobId;
  }

  start(job: DownloadJob): void {
    if (this.active !== undefined) {
      throw new Error('BUSY');
    }

    const outputDirectory = path.join(this.downloadsRoot, job.downloadDirectory);
    const finalPath = path.join(outputDirectory, job.outputFilename);
    const active: ActiveJob = {
      job,
      cancelled: false,
      child: undefined,
      outputDirectory,
      partialPath: `${finalPath}.partial`,
    };
    this.active = active;
    this.callbacks.diagnostic('download.queued', {
      jobId: job.jobId,
      outputFilename: job.outputFilename,
    });
    void this.run(active, finalPath);
  }

  cancel(jobId: string): boolean {
    if (this.active?.job.jobId !== jobId) {
      return false;
    }

    this.active.cancelled = true;
    this.callbacks.diagnostic('download.cancelling', { jobId });
    this.active.child?.kill();
    return true;
  }

  shutdown(): void {
    if (this.active !== undefined) {
      this.active.cancelled = true;
      this.active.child?.kill();
    }
  }

  private async run(active: ActiveJob, finalPath: string): Promise<void> {
    try {
      await mkdir(active.outputDirectory, { recursive: true });
      if (await fileExists(finalPath)) {
        throw new Error('OUTPUT_EXISTS');
      }
      await rm(active.partialPath, { force: true });

      if (active.cancelled) {
        await this.finishCancelled(active);
        return;
      }

      if (active.job.debug === true) {
        await this.inspectManifest(active);
      }

      this.callbacks.diagnostic('probe.started', { jobId: active.job.jobId });
      const probe = await this.probe(active);
      if (active.cancelled) {
        await this.finishCancelled(active);
        return;
      }

      const selection = chooseBestStreams(probe);
      this.callbacks.diagnostic('probe.completed', {
        jobId: active.job.jobId,
        videoIndex: selection.videoIndex,
        ...(selection.audioIndex === undefined
          ? {}
          : { audioIndex: selection.audioIndex }),
        ...(selection.durationMs === undefined
          ? {}
          : { durationMs: selection.durationMs }),
      });
      this.callbacks.diagnostic('ffmpeg.started', { jobId: active.job.jobId });
      await this.download(active, selection.videoIndex, selection.audioIndex, selection.durationMs);
      if (active.cancelled) {
        await this.finishCancelled(active);
        return;
      }

      await rename(active.partialPath, finalPath);
      this.callbacks.diagnostic('download.completed', {
        jobId: active.job.jobId,
        outputFilename: active.job.outputFilename,
      });
      this.callbacks.completed(active.job.jobId, active.job.outputFilename);
    } catch (error) {
      await rm(active.partialPath, { force: true }).catch(() => undefined);
      if (active.cancelled) {
        this.callbacks.diagnostic('download.cancelled', { jobId: active.job.jobId });
        this.callbacks.cancelled(active.job.jobId);
      } else {
        this.callbacks.diagnostic('download.failed', {
          jobId: active.job.jobId,
          error: redactDiagnostic(error),
        });
        this.callbacks.failed(active.job.jobId, safeFailure(error));
      }
    } finally {
      if (this.active === active) {
        this.active = undefined;
      }
    }
  }

  private probe(active: ActiveJob): Promise<ProbeResult> {
    const args = [
      '-v',
      active.job.debug === true ? 'verbose' : 'error',
      '-show_entries',
      'stream=index,codec_type,codec_name,width,height,bit_rate:format=duration',
      '-of',
      'json',
      ...buildMediaInputOptions(active.job),
      active.job.manifestUrl,
    ];

    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(this.tools.ffprobe, args, {
        windowsHide: true,
      });
      active.child = child;
      const chunks: Buffer[] = [];
      let outputBytes = 0;
      let safeDiagnostic = '';

      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes <= MAX_PROBE_OUTPUT_BYTES) {
          chunks.push(chunk);
        } else {
          child.kill();
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        safeDiagnostic = appendDiagnostic(safeDiagnostic, chunk);
      });
      child.once('error', reject);
      child.once('close', (code) => {
        active.child = undefined;
        if (active.job.debug === true && safeDiagnostic.length > 0) {
          this.callbacks.diagnostic('probe.output', {
            jobId: active.job.jobId,
            exitCode: code,
            output: safeDiagnostic,
          });
        }
        if (active.cancelled) {
          reject(new Error('CANCELLED'));
          return;
        }
        if (outputBytes > MAX_PROBE_OUTPUT_BYTES || code !== 0) {
          reject(new Error(safeDiagnostic || 'PROBE_FAILED'));
          return;
        }

        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProbeResult);
        } catch {
          reject(new Error('PROBE_INVALID_OUTPUT'));
        }
      });
    });
  }

  private download(
    active: ActiveJob,
    videoIndex: number,
    audioIndex?: number,
    durationMs?: number,
  ): Promise<void> {
    const container = path.extname(active.job.outputFilename).toLowerCase() === '.mkv'
      ? 'matroska'
      : 'mp4';
    const args = [
      '-nostdin',
      '-v',
      active.job.debug === true ? 'verbose' : 'error',
      ...buildMediaInputOptions(active.job),
      '-i',
      active.job.manifestUrl,
      '-map',
      `0:${videoIndex}`,
      ...(audioIndex === undefined ? [] : ['-map', `0:${audioIndex}`]),
      '-c',
      'copy',
      ...(container === 'mp4' ? ['-movflags', '+faststart'] : []),
      '-progress',
      'pipe:1',
      '-nostats',
      '-f',
      container,
      '-y',
      active.partialPath,
    ];

    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(this.tools.ffmpeg, args, {
        windowsHide: true,
      });
      active.child = child;
      let progressBuffer = '';
      let safeDiagnostic = '';

      child.stdout.on('data', (chunk: Buffer) => {
        progressBuffer += chunk.toString('utf8');
        let boundary = progressBuffer.indexOf('\nprogress=');
        while (boundary >= 0) {
          const nextLine = progressBuffer.indexOf('\n', boundary + 1);
          if (nextLine < 0) {
            break;
          }
          const block = progressBuffer.slice(0, nextLine + 1);
          progressBuffer = progressBuffer.slice(nextLine + 1);
          this.callbacks.progress(active.job.jobId, parseProgressBlock(block, durationMs));
          boundary = progressBuffer.indexOf('\nprogress=');
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        safeDiagnostic = appendDiagnostic(safeDiagnostic, chunk);
      });
      child.once('error', reject);
      child.once('close', (code) => {
        active.child = undefined;
        if (active.job.debug === true && safeDiagnostic.length > 0) {
          this.callbacks.diagnostic('ffmpeg.output', {
            jobId: active.job.jobId,
            exitCode: code,
            output: safeDiagnostic,
          });
        }
        if (active.cancelled) {
          reject(new Error('CANCELLED'));
        } else if (code === 0) {
          resolve();
        } else {
          reject(new Error(safeDiagnostic || 'FFMPEG_FAILED'));
        }
      });
    });
  }

  private async inspectManifest(active: ActiveJob): Promise<void> {
    try {
      const response = await fetch(active.job.manifestUrl, {
        headers: {
          Accept: '*/*',
          ...(active.job.cloudFrontAuth
            ? { Cookie: buildCloudFrontCookie(active.job.cloudFrontAuth) }
            : {}),
          Origin: FANSLY_ORIGIN,
          Range: `bytes=0-${MAX_MANIFEST_CAPTURE_BYTES - 1}`,
          Referer: FANSLY_REFERER,
          'User-Agent': active.job.userAgent,
        },
      });
      const body = await readLimitedResponse(response, MAX_MANIFEST_CAPTURE_BYTES);
      this.callbacks.diagnostic('manifest.response', {
        jobId: active.job.jobId,
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get('content-type') ?? '',
        contentLength: response.headers.get('content-length') ?? '',
        contentRange: response.headers.get('content-range') ?? '',
        finalUrl: response.url,
        truncated: body.truncated,
        body: body.text,
      });
    } catch (error) {
      this.callbacks.diagnostic('manifest.response-failed', {
        jobId: active.job.jobId,
        error: redactDiagnostic(error),
      });
    }
  }

  private async finishCancelled(active: ActiveJob): Promise<void> {
    await rm(active.partialPath, { force: true });
    this.callbacks.cancelled(active.job.jobId);
  }
}

export function buildMediaInputOptions(
  job: Pick<DownloadJob, 'cloudFrontAuth' | 'userAgent'>,
): string[] {
  const cloudFrontCookie = job.cloudFrontAuth
    ? `Cookie: ${buildCloudFrontCookie(job.cloudFrontAuth)}\r\n`
    : '';
  return [
    '-headers',
    `Origin: ${FANSLY_ORIGIN}\r\nAccept: */*\r\n${cloudFrontCookie}`,
    '-referer',
    FANSLY_REFERER,
    '-user_agent',
    job.userAgent,
  ];
}

function buildCloudFrontCookie(auth: NonNullable<DownloadJob['cloudFrontAuth']>): string {
  return [
    `CloudFront-Key-Pair-Id=${auth.keyPairId}`,
    `CloudFront-Policy=${auth.policy}`,
    `CloudFront-Signature=${auth.signature}`,
  ].join('; ');
}

function appendDiagnostic(current: string, chunk: Buffer): string {
  if (current.length >= MAX_DIAGNOSTIC_BYTES) {
    return current;
  }

  return `${current}${chunk.toString('utf8')}`.slice(0, MAX_DIAGNOSTIC_BYTES);
}

async function readLimitedResponse(
  response: Response,
  maximumBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    return { text: '', truncated: false };
  }

  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let text = '';
  let bytesRead = 0;
  let truncated = false;

  try {
    while (bytesRead < maximumBytes) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      const remaining = maximumBytes - bytesRead;
      const chunk = result.value.subarray(0, remaining);
      bytesRead += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      if (chunk.byteLength < result.value.byteLength) {
        truncated = true;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  text += decoder.decode();
  return { text, truncated };
}
