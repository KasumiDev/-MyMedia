export interface CloudFrontAuth {
  keyPairId: string;
  policy: string;
  signature: string;
}

export interface DownloadJob {
  jobId: string;
  manifestUrl: string;
  downloadDirectory: string;
  outputFilename: string;
  originalFilename: string;
  createdAt: number;
  likeCount: number;
  price: number;
  previewUrl?: string;
  debug?: boolean;
  userAgent: string;
  cloudFrontAuth?: CloudFrontAuth;
}

export type NativeRequest =
  | { type: 'hello'; requestId: string }
  | { type: 'download.start'; requestId: string; job: DownloadJob }
  | { type: 'download.cancel'; requestId: string; jobId: string };

export interface DownloadProgress {
  outTimeMs?: number;
  totalSize?: number;
  speed?: number;
  percent?: number;
}

export interface NativeCapabilities {
  hls: boolean;
  dash: boolean;
  cancel: boolean;
  streamCopy: boolean;
  progress: boolean;
}

export type NativeMessage =
  | {
      type: 'response';
      requestId: string;
      ok: boolean;
      error?: string;
      version?: string;
      capabilities?: NativeCapabilities;
    }
  | { type: 'download.progress'; jobId: string; progress: DownloadProgress }
  | { type: 'download.completed'; jobId: string; outputFilename: string }
  | { type: 'download.failed'; jobId: string; error: string }
  | { type: 'download.cancelled'; jobId: string };
