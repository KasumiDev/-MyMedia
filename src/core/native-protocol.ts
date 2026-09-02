export const NATIVE_HOST_NAME = "com.fansly.mymedia_companion";

export interface CloudFrontAuth {
  keyPairId: string;
  policy: string;
  signature: string;
}

export interface NativeDownloadJob {
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
  | { type: "hello"; requestId: string }
  | { type: "download.start"; requestId: string; job: NativeDownloadJob }
  | { type: "download.cancel"; requestId: string; jobId: string };

export interface NativeCapabilities {
  hls?: boolean;
  dash?: boolean;
  cancel?: boolean;
  [name: string]: boolean | undefined;
}

export type NativeHostMessage =
  | {
      type: "response";
      requestId: string;
      ok: boolean;
      error?: string;
      version?: string;
      capabilities?: NativeCapabilities;
    }
  | {
      type: "download.progress";
      jobId: string;
      progress: {
        outTimeMs?: number;
        totalSize?: number;
        speed?: number;
        percent?: number;
      };
    }
  | { type: "download.completed"; jobId: string; outputFilename: string }
  | { type: "download.failed"; jobId: string; error: string }
  | { type: "download.cancelled"; jobId: string };

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isNativeHostMessage(value: unknown): value is NativeHostMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "response") {
    return SAFE_ID.test(stringValue(value.requestId))
      && typeof value.ok === "boolean"
      && optionalShortString(value.error)
      && optionalShortString(value.version)
      && isCapabilities(value.capabilities);
  }

  if (value.type === "download.progress") {
    return SAFE_ID.test(stringValue(value.jobId)) && isProgress(value.progress);
  }

  if (value.type === "download.completed") {
    return SAFE_ID.test(stringValue(value.jobId))
      && isSafeOutputFilename(value.outputFilename);
  }

  if (value.type === "download.failed") {
    return SAFE_ID.test(stringValue(value.jobId))
      && typeof value.error === "string"
      && value.error.length > 0
      && value.error.length <= 500;
  }

  return value.type === "download.cancelled"
    && SAFE_ID.test(stringValue(value.jobId));
}

export function isApprovedManifestUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8_192) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && /^cdn[1-5]\.fansly\.com$/u.test(url.hostname)
      && (/\.m3u8$/iu.test(url.pathname) || /\.mpd$/iu.test(url.pathname));
  } catch {
    return false;
  }
}

function isProgress(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const allowedKeys = new Set(["outTimeMs", "totalSize", "speed", "percent"]);
  return Object.entries(value).every(([key, item]) =>
    allowedKeys.has(key) && typeof item === "number" && Number.isFinite(item) && item >= 0
  );
}

function isCapabilities(value: unknown): boolean {
  return value === undefined || (isRecord(value)
    && Object.values(value).every((item) => typeof item === "boolean"));
}

function optionalShortString(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length <= 500);
}

function isSafeOutputFilename(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 240
    && !/[<>:"/\\|?*\r\n]/u.test(value)
    && !value.includes("..")
    && !/^\.+$/u.test(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
