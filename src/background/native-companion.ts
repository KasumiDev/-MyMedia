import {
  isApprovedManifestUrl,
  isNativeHostMessage,
  NATIVE_HOST_NAME,
  type NativeCapabilities,
  type NativeHostMessage,
  type NativeRequest
} from "../core/native-protocol";
import { isValidDownloadFilename } from "../core/filenames";
import {
  updateDownloadByMediaId,
  upsertDownloadRecord
} from "../storage/download-index";
import { createAndStoreThumbnail } from "../storage/thumbnail-generator";

const RESPONSE_TIMEOUT_MS = 10_000;
const DOWNLOAD_REVISION_KEY = "fansly-mymedia:download-revision";

export interface CompanionStatus {
  available: boolean;
  checking: boolean;
  version?: string;
  capabilities?: NativeCapabilities;
  error?: string;
  active?: {
    mediaId: string;
    percent?: number;
    totalSize?: number;
    speed?: number;
  };
}

export interface CompanionDownloadInput {
  mediaId: string;
  manifestUrl: string;
  outputFilename: string;
  historyFilename: string;
  originalFilename: string;
  createdAt: number;
  likeCount: number;
  price: number;
  previewUrl?: string;
}

interface PendingRequest {
  resolve: (message: Extract<NativeHostMessage, { type: "response" }>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ActiveDownload {
  jobId: string;
  input: CompanionDownloadInput;
  resolve: (outputFilename: string) => void;
  reject: (error: Error) => void;
  progress: {
    percent?: number;
    totalSize?: number;
    speed?: number;
  };
}

let port: chrome.runtime.Port | null = null;
let connectionPromise: Promise<CompanionStatus> | null = null;
let status: CompanionStatus = {
  available: false,
  checking: false
};
let activeDownload: ActiveDownload | null = null;
const pendingRequests = new Map<string, PendingRequest>();

export function getCompanionStatus(): CompanionStatus {
  return {
    ...status,
    ...(activeDownload
      ? {
          active: {
            mediaId: activeDownload.input.mediaId,
            ...activeDownload.progress
          }
        }
      : {})
  };
}

export async function checkCompanion(force = false): Promise<CompanionStatus> {
  if (force && !activeDownload) {
    disconnectPort();
  }

  if (port && status.available) {
    return getCompanionStatus();
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  status = { available: false, checking: true };
  connectionPromise = connectAndHandshake().finally(() => {
    connectionPromise = null;
  });
  return connectionPromise;
}

export async function downloadWithCompanion(
  input: CompanionDownloadInput
): Promise<string> {
  validateDownloadInput(input);
  const companion = await checkCompanion();
  if (!companion.available || !port) {
    throw new Error(companion.error ?? "The native companion is unavailable.");
  }

  if (activeDownload) {
    throw new Error("The native companion is already downloading another video.");
  }

  await upsertDownloadRecord({
    mediaId: input.mediaId,
    filename: input.historyFilename,
    originalFilename: input.originalFilename,
    createdAt: input.createdAt,
    likeCount: input.likeCount,
    price: input.price,
    state: "queued",
    updatedAt: Date.now()
  });
  await publishDownloadRevision();
  if (input.previewUrl) {
    await createAndStoreThumbnail(input.mediaId, new URL(input.previewUrl))
      .catch(() => undefined);
  }

  return new Promise<string>((resolve, reject) => {
    const jobId = crypto.randomUUID();
    activeDownload = {
      jobId,
      input,
      resolve,
      reject,
      progress: {}
    };

    void beginActiveDownload();
  });
}

export async function cancelCompanionDownload(mediaId: string): Promise<boolean> {
  if (!activeDownload || activeDownload.input.mediaId !== mediaId || !port) {
    return false;
  }

  const response = await sendRequest({
    type: "download.cancel",
    requestId: crypto.randomUUID(),
    jobId: activeDownload.jobId
  });
  return response.ok;
}

async function connectAndHandshake(): Promise<CompanionStatus> {
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    port.onMessage.addListener(handleHostMessage);
    port.onDisconnect.addListener(handleDisconnect);

    const response = await sendRequest({
      type: "hello",
      requestId: crypto.randomUUID()
    });
    if (!response.ok) {
      throw new Error(response.error || "The native companion rejected the handshake.");
    }

    status = {
      available: true,
      checking: false,
      ...(response.version ? { version: response.version } : {}),
      ...(response.capabilities ? { capabilities: response.capabilities } : {})
    };
  } catch (error) {
    disconnectPort();
    status = {
      available: false,
      checking: false,
      error: safeError(error, "The native companion could not be reached.")
    };
  }

  return getCompanionStatus();
}

async function beginActiveDownload(): Promise<void> {
  const download = activeDownload;
  if (!download) {
    return;
  }

  try {
    const request: NativeRequest = {
      type: "download.start",
      requestId: crypto.randomUUID(),
      job: {
        jobId: download.jobId,
        manifestUrl: download.input.manifestUrl,
        outputFilename: download.input.outputFilename,
        originalFilename: download.input.originalFilename,
        createdAt: download.input.createdAt,
        likeCount: download.input.likeCount,
        price: download.input.price,
        ...(download.input.previewUrl
          ? { previewUrl: download.input.previewUrl }
          : {})
      }
    };
    const response = await sendRequest(request);
    if (!response.ok) {
      throw new Error(response.error || "The native companion rejected the download.");
    }

    if (activeDownload?.jobId === download.jobId) {
      await updateDownloadState(download.input.mediaId, "downloading");
    }
  } catch (error) {
    await failActiveDownload(safeError(error, "The companion download could not start."));
  }
}

function sendRequest(
  request: NativeRequest
): Promise<Extract<NativeHostMessage, { type: "response" }>> {
  if (!port) {
    return Promise.reject(new Error("The native companion is not connected."));
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(request.requestId);
      reject(new Error("The native companion did not respond in time."));
    }, RESPONSE_TIMEOUT_MS);
    pendingRequests.set(request.requestId, { resolve, reject, timeout });

    try {
      port?.postMessage(request);
    } catch (error) {
      clearTimeout(timeout);
      pendingRequests.delete(request.requestId);
      reject(error instanceof Error ? error : new Error("Could not send native message."));
    }
  });
}

function handleHostMessage(value: unknown): void {
  if (!isNativeHostMessage(value)) {
    return;
  }

  if (value.type === "response") {
    const pending = pendingRequests.get(value.requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    pendingRequests.delete(value.requestId);
    pending.resolve(value);
    return;
  }

  if (!activeDownload || value.jobId !== activeDownload.jobId) {
    return;
  }

  if (value.type === "download.progress") {
    activeDownload.progress = {
      ...(value.progress.percent === undefined
        ? {}
        : { percent: value.progress.percent }),
      ...(value.progress.totalSize === undefined
        ? {}
        : { totalSize: value.progress.totalSize }),
      ...(value.progress.speed === undefined
        ? {}
        : { speed: value.progress.speed })
    };
    return;
  }

  if (value.type === "download.completed") {
    if (value.outputFilename !== activeDownload.input.outputFilename) {
      void failActiveDownload("The companion returned an unexpected output filename.");
      return;
    }

    void completeActiveDownload(value.outputFilename);
    return;
  }

  if (value.type === "download.cancelled") {
    void failActiveDownload("Download cancelled.");
    return;
  }

  void failActiveDownload(value.error);
}

function handleDisconnect(): void {
  const message = chrome.runtime.lastError?.message;
  const disconnectError = sanitizeError(
    message || "The native companion disconnected."
  );
  port = null;
  status = {
    available: false,
    checking: false,
    error: disconnectError
  };

  rejectPendingRequests(disconnectError);
  if (activeDownload) {
    void failActiveDownload(disconnectError);
  }
}

async function completeActiveDownload(outputFilename: string): Promise<void> {
  const download = activeDownload;
  if (!download) {
    return;
  }

  activeDownload = null;
  try {
    await updateDownloadState(download.input.mediaId, "completed");
    download.resolve(outputFilename);
  } catch {
    download.reject(new Error("The completed download could not be saved to history."));
  }
}

async function failActiveDownload(error: string): Promise<void> {
  const download = activeDownload;
  if (!download) {
    return;
  }

  activeDownload = null;
  await updateDownloadState(download.input.mediaId, "failed", error).catch(() => undefined);
  download.reject(new Error(error));
}

async function updateDownloadState(
  mediaId: string,
  state: "downloading" | "completed" | "failed",
  error?: string
): Promise<void> {
  await updateDownloadByMediaId(mediaId, (record) => ({
    ...record,
    state,
    ...(error ? { error: sanitizeError(error) } : { error: undefined }),
    updatedAt: Date.now()
  }));
  await publishDownloadRevision();
}

async function publishDownloadRevision(): Promise<void> {
  await chrome.storage.local.set({
    [DOWNLOAD_REVISION_KEY]: `${Date.now()}-${crypto.randomUUID()}`
  });
}

function validateDownloadInput(input: CompanionDownloadInput): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(input.mediaId)
    || !isApprovedManifestUrl(input.manifestUrl)
    || !isSafeNativeFilename(input.outputFilename)
    || !isValidDownloadFilename(input.historyFilename)
    || (input.previewUrl !== undefined && !isApprovedCdnUrl(input.previewUrl))) {
    throw new Error("The companion download request was invalid.");
  }
}

function isApprovedCdnUrl(value: string): boolean {
  if (value.length > 8_192) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" && /^cdn[1-5]\.fansly\.com$/u.test(url.hostname);
  } catch {
    return false;
  }
}

function isSafeNativeFilename(value: string): boolean {
  return value.length > 0
    && value.length <= 180
    && !/[<>:"/\\|?*\r\n]/u.test(value)
    && !value.includes("..")
    && !/^\.+$/u.test(value)
    && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(value)
    && /\.(?:mp4|mkv)$/iu.test(value);
}

function disconnectPort(): void {
  if (!port) {
    return;
  }

  port.onMessage.removeListener(handleHostMessage);
  port.onDisconnect.removeListener(handleDisconnect);
  port.disconnect();
  port = null;
  rejectPendingRequests("The native companion connection was reset.");
}

function rejectPendingRequests(message: string): void {
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(message));
  }
  pendingRequests.clear();
}

function safeError(error: unknown, fallback: string): string {
  return sanitizeError(error instanceof Error ? error.message : fallback);
}

function sanitizeError(value: string): string {
  return value.replace(/https?:\/\/\S+/gu, "[redacted URL]").slice(0, 500);
}
