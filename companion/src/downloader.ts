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
  partialPath: string;
}

type SpawnProcess = typeof spawn;

const MAX_PROBE_OUTPUT_BYTES = 4 * 1024 * 1024;

function safeFailure(error: unknown): string {
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
    private readonly outputRoot = path.join(os.homedir(), 'Downloads', 'Fansly MyMedia'),
  ) {}

  get activeJobId(): string | undefined {
    return this.active?.job.jobId;
  }

  start(job: DownloadJob): void {
    if (this.active !== undefined) {
      throw new Error('BUSY');
    }

    const finalPath = path.join(this.outputRoot, job.outputFilename);
    const active: ActiveJob = {
      job,
      cancelled: false,
      child: undefined,
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
      await mkdir(this.outputRoot, { recursive: true });
      if (await fileExists(finalPath)) {
        throw new Error('OUTPUT_EXISTS');
      }
      await rm(active.partialPath, { force: true });

      if (active.cancelled) {
        await this.finishCancelled(active);
        return;
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
      'error',
      '-show_entries',
      'stream=index,codec_type,codec_name,width,height,bit_rate:format=duration',
      '-of',
      'json',
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
        safeDiagnostic += chunk.toString('utf8').slice(0, 1024);
      });
      child.once('error', reject);
      child.once('close', (code) => {
        active.child = undefined;
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
      'error',
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
        safeDiagnostic += chunk.toString('utf8').slice(0, 2048);
      });
      child.once('error', reject);
      child.once('close', (code) => {
        active.child = undefined;
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

  private async finishCancelled(active: ActiveJob): Promise<void> {
    await rm(active.partialPath, { force: true });
    this.callbacks.cancelled(active.job.jobId);
  }
}
