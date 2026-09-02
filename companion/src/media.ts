import type { DownloadProgress } from './protocol.js';

export interface ProbeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  bit_rate?: string;
}

export interface ProbeResult {
  streams?: ProbeStream[];
  format?: {
    duration?: string;
  };
}

function numericBitrate(stream: ProbeStream): number {
  const bitrate = Number(stream.bit_rate ?? 0);
  return Number.isFinite(bitrate) ? bitrate : 0;
}

export function chooseBestStreams(probe: ProbeResult): {
  videoIndex: number;
  audioIndex?: number;
  durationMs?: number;
} {
  const streams = probe.streams ?? [];
  const videos = streams.filter((stream) => stream.codec_type === 'video');
  const video = videos.toSorted((left, right) => {
    const leftPixels = (left.width ?? 0) * (left.height ?? 0);
    const rightPixels = (right.width ?? 0) * (right.height ?? 0);
    return rightPixels - leftPixels || numericBitrate(right) - numericBitrate(left);
  })[0];

  if (video === undefined) {
    throw new Error('NO_VIDEO_STREAM');
  }

  const audio = streams
    .filter((stream) => stream.codec_type === 'audio')
    .toSorted((left, right) => numericBitrate(right) - numericBitrate(left))[0];
  const durationSeconds = Number(probe.format?.duration);
  const durationMs = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? durationSeconds * 1000
    : undefined;

  return {
    videoIndex: video.index,
    ...(audio === undefined ? {} : { audioIndex: audio.index }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

export function parseProgressBlock(
  block: string,
  durationMs?: number,
): DownloadProgress {
  const values = new Map<string, string>();
  for (const line of block.split(/\r?\n/u)) {
    const separator = line.indexOf('=');
    if (separator > 0) {
      values.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }

  // Despite its name, FFmpeg reports out_time_ms in microseconds.
  const outTimeRaw = Number(values.get('out_time_ms'));
  const totalSizeRaw = Number(values.get('total_size'));
  const speedRaw = Number.parseFloat(values.get('speed')?.replace(/x$/u, '') ?? '');
  const outTimeMs = Number.isFinite(outTimeRaw) ? outTimeRaw / 1000 : undefined;
  const progress: DownloadProgress = {
    ...(outTimeMs === undefined ? {} : { outTimeMs }),
    ...(Number.isFinite(totalSizeRaw) ? { totalSize: totalSizeRaw } : {}),
    ...(Number.isFinite(speedRaw) ? { speed: speedRaw } : {}),
  };

  if (outTimeMs !== undefined && durationMs !== undefined && durationMs > 0) {
    progress.percent = Math.min(100, Math.max(0, (outTimeMs / durationMs) * 100));
  }

  return progress;
}
