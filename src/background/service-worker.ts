import {
  isValidDownloadDirectory,
  isValidDownloadFilename,
  sanitizeOriginalFilename
} from "../core/filenames";
import {
  loadDownloadIndex,
  loadDownloadThumbnailDataUrl,
  migrateLegacyDownloadIndex,
  updateDownloadByChromeId,
  updateDownloadByMediaId,
  upsertDownloadRecord
} from "../storage/download-index";
import { createAndStoreThumbnail } from "../storage/thumbnail-generator";
import {
  cancelCompanionDownload,
  checkCompanion,
  downloadWithCompanion,
  getCompanionStatus
} from "./native-companion";
import type { CloudFrontAuth } from "../core/native-protocol";

const MEDIA_HOSTS = new Set([
  "cdn1.fansly.com",
  "cdn2.fansly.com",
  "cdn3.fansly.com",
  "cdn4.fansly.com",
  "cdn5.fansly.com",
  "media.fansly.com"
]);
const DOWNLOAD_REVISION_KEY = "fansly-mymedia:download-revision";
const RETRY_STORAGE_PREFIX = "fansly-mymedia:retry:";

type DownloadMetadata = {
  originalFilename: string;
  createdAt: number;
  likeCount: number;
  price: number;
};

type RetryDownloadInput = {
  url: string;
  filename: string;
  downloadDirectory: string;
  mediaId: string;
  previewUrl?: string;
  manifestUrl?: string;
  metadata: DownloadMetadata;
  debug: boolean;
  userAgent?: string;
};

export function installServiceWorker(): void {
  void migrateLegacyDownloadIndex()
    .then(publishDownloadIndex)
    .catch(() => undefined);

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!message || typeof message !== "object") return;
    const request = message as {
      type?: unknown;
      url?: unknown;
      filename?: unknown;
      mediaId?: unknown;
      previewUrl?: unknown;
      manifestUrl?: unknown;
      originalFilename?: unknown;
      createdAt?: unknown;
      likeCount?: unknown;
      price?: unknown;
      debug?: unknown;
      userAgent?: unknown;
      downloadDirectory?: unknown;
      mediaIds?: unknown;
    };

    if (request.type === "fansly-mymedia:get-download-index") {
      if (sender.url?.startsWith("https://fansly.com/") !== true) {
        sendResponse({ ok: false, index: {} });
        return;
      }
      void loadDownloadIndex()
        .then((index) => sendResponse({ ok: true, index }))
        .catch(() => sendResponse({ ok: false, index: {} }));
      return true;
    }

    if (request.type === "fansly-mymedia:get-thumbnail") {
      const mediaId = validMediaId(request.mediaId);
      if (!mediaId || sender.url?.startsWith("https://fansly.com/") !== true) {
        sendResponse({ ok: false, dataUrl: null });
        return;
      }
      void loadDownloadThumbnailDataUrl(mediaId)
        .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
        .catch(() => sendResponse({ ok: false, dataUrl: null }));
      return true;
    }

    if (request.type === "fansly-mymedia:get-companion-status") {
      if (sender.url?.startsWith("https://fansly.com/") !== true) {
        sendResponse({ ok: false, status: getCompanionStatus() });
        return;
      }

      const refresh = (message as { refresh?: unknown }).refresh === true;
      void checkCompanion(refresh)
        .then((companionStatus) => sendResponse({ ok: true, status: companionStatus }))
        .catch(() => sendResponse({ ok: true, status: getCompanionStatus() }));
      return true;
    }

    if (request.type === "fansly-mymedia:cancel-companion-download") {
      const mediaId = validMediaId(request.mediaId);
      if (!mediaId || sender.url?.startsWith("https://fansly.com/") !== true) {
        sendResponse({ ok: false });
        return;
      }

      void cancelCompanionDownload(mediaId)
        .then((cancelled) => sendResponse({ ok: cancelled }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    if (request.type === "fansly-mymedia:retry-download") {
      const mediaId = validMediaId(request.mediaId);
      if (!mediaId || sender.url?.startsWith("https://fansly.com/") !== true) {
        sendResponse({ ok: false, error: "The failed download was invalid." });
        return;
      }

      void retryDownload(mediaId)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error: unknown) => sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Retry failed."
        }));
      return true;
    }

    if (request.type === "fansly-mymedia:retry-all-failed") {
      if (sender.url?.startsWith("https://fansly.com/") !== true) {
        sendResponse({ ok: false, retried: 0, failed: 0 });
        return;
      }

      void retryAllFailed()
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch(() => sendResponse({ ok: false, retried: 0, failed: 0 }));
      return true;
    }

    if (request.type === "fansly-mymedia:download") {
      const url = validMediaUrl(request.url);
      if (!url || sender.url?.startsWith("https://fansly.com/") !== true) {
        sendResponse({
          ok: false,
          error: "Only an approved Fansly media URL can be downloaded."
        });
        return;
      }

      const filename = validFilename(request.filename);
      const mediaId = validMediaId(request.mediaId);
      const previewUrl = validMediaUrl(request.previewUrl);
      const manifestUrl = validMediaUrl(request.manifestUrl);
      const metadata = validDownloadMetadata(request);
      const downloadDirectory = validDownloadDirectory(request.downloadDirectory);
      const userAgent = validUserAgent(request.userAgent);
      if (!filename || !mediaId || !metadata || !downloadDirectory
        || !filename.startsWith(`${downloadDirectory}/`)) {
        sendResponse({
          ok: false,
          error: "The media filename or identifier was invalid."
        });
        return;
      }

      const retryInput: RetryDownloadInput = {
        url: url.toString(),
        filename,
        downloadDirectory,
        mediaId,
        ...(previewUrl ? { previewUrl: previewUrl.toString() } : {}),
        ...(manifestUrl ? { manifestUrl: manifestUrl.toString() } : {}),
        metadata,
        debug: request.debug === true,
        ...(userAgent ? { userAgent } : {})
      };

      void storeRetryInput(retryInput)
        .then(() => startRetryInput(retryInput))
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error: unknown) => sendResponse({
          ok: false,
          error: error instanceof Error
            ? error.message
            : "The download could not be completed."
        }));
      return true;
    }
  });

  chrome.downloads.onChanged.addListener((delta) => {
    const state = delta.state?.current;
    if (state !== "complete" && state !== "interrupted") return;
    void updateDownloadByChromeId(delta.id, (record) => ({
        ...record,
        state: state === "complete" ? "completed" : "failed",
        ...(state === "interrupted"
          ? { error: delta.error?.current ?? "The browser interrupted the download." }
          : { error: undefined }),
        updatedAt: Date.now()
      }))
      .then(publishDownloadIndex)
      .catch(() => {
        // Storage is best-effort here. Do not interfere with the browser download.
      });
  });
}

async function startPreferredDownload(
  url: URL,
  filename: string,
  mediaId: string,
  previewUrl: URL | null,
  manifestUrl: URL | null,
  metadata: DownloadMetadata,
  debug: boolean,
  userAgent: string | null,
  downloadDirectory: string
): Promise<{ mode: "browser"; downloadId: number } | { mode: "companion" }> {
  if (manifestUrl && isStreamingManifest(manifestUrl)) {
    const companion = await checkCompanion();
    if (companion.available) {
      if (!userAgent) {
        throw new Error("The browser user agent was unavailable.");
      }

      const nativeHistoryFilename = filename.replace(/\.[a-z0-9]{1,8}$/iu, ".mp4");
      const cloudFrontAuth = await loadCloudFrontAuth(manifestUrl);
      await downloadWithCompanion({
        mediaId,
        manifestUrl: manifestUrl.toString(),
        downloadDirectory,
        outputFilename: nativeHistoryFilename.slice(nativeHistoryFilename.lastIndexOf("/") + 1),
        historyFilename: nativeHistoryFilename,
        originalFilename: metadata.originalFilename,
        createdAt: metadata.createdAt,
        likeCount: metadata.likeCount,
        price: metadata.price,
        ...(debug ? { debug: true } : {}),
        userAgent,
        ...(cloudFrontAuth ? { cloudFrontAuth } : {}),
        ...(previewUrl ? { previewUrl: previewUrl.toString() } : {})
      });
      return { mode: "companion" };
    }
  }

  const downloadId = await startDownload(url, filename, mediaId, previewUrl, metadata);
  return { mode: "browser", downloadId };
}

async function startRetryInput(
  input: RetryDownloadInput
): Promise<{ mode: "browser"; downloadId: number } | { mode: "companion" }> {
  await upsertDownloadRecord({
    mediaId: input.mediaId,
    filename: input.filename,
    ...input.metadata,
    state: "queued",
    updatedAt: Date.now()
  });
  await publishDownloadIndex();

  try {
    return await startPreferredDownload(
      new URL(input.url),
      input.filename,
      input.mediaId,
      input.previewUrl ? new URL(input.previewUrl) : null,
      input.manifestUrl ? new URL(input.manifestUrl) : null,
      input.metadata,
      input.debug,
      input.userAgent ?? null,
      input.downloadDirectory
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Download failed.";
    await updateDownloadByMediaId(input.mediaId, (record) => ({
      ...record,
      state: "failed",
      error: message.slice(0, 500),
      updatedAt: Date.now()
    }));
    await publishDownloadIndex();
    throw error;
  }
}

async function retryDownload(
  mediaId: string
): Promise<{ mode: "browser"; downloadId: number } | { mode: "companion" }> {
  const input = await loadRetryInput(mediaId);
  if (!input) {
    throw new Error(
      "Retry details expired. Rediscover this media and start the download again."
    );
  }
  return startRetryInput(input);
}

async function retryAllFailed(): Promise<{ retried: number; failed: number }> {
  const index = await loadDownloadIndex();
  const failedIds = Object.values(index)
    .filter((record) => record.state === "failed")
    .sort((left, right) => left.updatedAt - right.updatedAt)
    .map((record) => record.mediaId);
  let retried = 0;
  let failed = 0;

  for (const mediaId of failedIds) {
    try {
      await retryDownload(mediaId);
      retried += 1;
    } catch {
      failed += 1;
    }
  }

  return { retried, failed };
}

async function storeRetryInput(input: RetryDownloadInput): Promise<void> {
  await chrome.storage.session.set({
    [`${RETRY_STORAGE_PREFIX}${input.mediaId}`]: input
  });
}

async function loadRetryInput(mediaId: string): Promise<RetryDownloadInput | null> {
  const key = `${RETRY_STORAGE_PREFIX}${mediaId}`;
  const stored = await chrome.storage.session.get(key);
  return parseRetryInput(stored[key]);
}

function parseRetryInput(value: unknown): RetryDownloadInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<RetryDownloadInput>;
  const url = validMediaUrl(input.url);
  const filename = validFilename(input.filename);
  const downloadDirectory = validDownloadDirectory(input.downloadDirectory);
  const mediaId = validMediaId(input.mediaId);
  const previewUrl = validMediaUrl(input.previewUrl);
  const manifestUrl = validMediaUrl(input.manifestUrl);
  const metadata = validDownloadMetadata(input.metadata ?? {});
  const userAgent = validUserAgent(input.userAgent);
  if (!url || !filename || !downloadDirectory || !mediaId || !metadata
    || !filename.startsWith(`${downloadDirectory}/`)) return null;

  return {
    url: url.toString(),
    filename,
    downloadDirectory,
    mediaId,
    ...(previewUrl ? { previewUrl: previewUrl.toString() } : {}),
    ...(manifestUrl ? { manifestUrl: manifestUrl.toString() } : {}),
    metadata,
    debug: input.debug === true,
    ...(userAgent ? { userAgent } : {})
  };
}

async function startDownload(
  url: URL,
  filename: string,
  mediaId: string,
  previewUrl: URL | null,
  metadata: DownloadMetadata
): Promise<number> {
  const downloadId = await chrome.downloads.download({
    url: url.toString(),
    filename,
    conflictAction: "uniquify",
    saveAs: false
  });

  // Signed source URLs are deliberately never persisted.
  await upsertDownloadRecord({
    mediaId,
    filename,
    ...metadata,
    state: "downloading",
    chromeDownloadId: downloadId,
    updatedAt: Date.now()
  });
  await publishDownloadIndex();

  if (previewUrl) {
    await createAndStoreThumbnail(mediaId, previewUrl).catch(() => undefined);
  }

  const [download] = await chrome.downloads.search({ id: downloadId });
  if (download?.state === "complete" || download?.state === "interrupted") {
    await updateDownloadByChromeId(downloadId, (record) => ({
      ...record,
      state: download.state === "complete" ? "completed" : "failed",
      ...(download.state === "interrupted"
        ? { error: download.error ?? "The browser interrupted the download." }
        : { error: undefined }),
      updatedAt: Date.now()
    }));
    await publishDownloadIndex();
  }

  return downloadId;
}

async function publishDownloadIndex(): Promise<void> {
  await chrome.storage.local.set({
    [DOWNLOAD_REVISION_KEY]: `${Date.now()}-${crypto.randomUUID()}`
  });
}

function validMediaUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 8_192) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && MEDIA_HOSTS.has(url.hostname) ? url : null;
  } catch { return null; }
}

function isStreamingManifest(url: URL): boolean {
  return /\.(?:m3u8|mpd)$/iu.test(url.pathname);
}

function validFilename(value: unknown): string | null {
  return isValidDownloadFilename(value) ? value : null;
}

function validDownloadDirectory(value: unknown): string | null {
  return isValidDownloadDirectory(value) ? value : null;
}

function validMediaId(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;
}

function validUserAgent(value: unknown): string | null {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !/[\r\n]/u.test(value)
    ? value
    : null;
}

async function loadCloudFrontAuth(url: URL): Promise<CloudFrontAuth | null> {
  const cookies = await chrome.cookies.getAll({ url: url.toString() });
  const byName = new Map(cookies.map((cookie) => [cookie.name, cookie.value]));
  const keyPairId = byName.get("CloudFront-Key-Pair-Id")
    ?? url.searchParams.get("Key-Pair-Id");
  const policy = byName.get("CloudFront-Policy")
    ?? url.searchParams.get("Policy");
  const signature = byName.get("CloudFront-Signature")
    ?? url.searchParams.get("Signature");

  return isSafeCloudFrontValue(keyPairId, 256)
    && isSafeCloudFrontValue(policy, 8_192)
    && isSafeCloudFrontValue(signature, 8_192)
    ? { keyPairId, policy, signature }
    : null;
}

function isSafeCloudFrontValue(
  value: string | null | undefined,
  maximumLength: number
): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumLength
    && !/[;\r\n]/u.test(value);
}

function validDownloadMetadata(value: {
  originalFilename?: unknown;
  createdAt?: unknown;
  likeCount?: unknown;
  price?: unknown;
}): DownloadMetadata | null {
  if (typeof value.originalFilename !== "string"
    || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)
    || value.createdAt <= 0
    || !isNonNegativeInteger(value.likeCount)
    || !isNonNegativeInteger(value.price)) return null;

  return {
    originalFilename: sanitizeOriginalFilename(value.originalFilename),
    createdAt: value.createdAt,
    likeCount: value.likeCount,
    price: value.price
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
