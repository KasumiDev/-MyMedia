import {
  isValidDownloadFilename,
  sanitizeOriginalFilename
} from "../core/filenames";
import {
  loadDownloadIndex,
  loadDownloadThumbnailDataUrl,
  migrateLegacyDownloadIndex,
  updateDownloadByChromeId,
  upsertDownloadRecord
} from "../storage/download-index";
import { createAndStoreThumbnail } from "../storage/thumbnail-generator";

const MEDIA_HOSTS = new Set([
  "cdn1.fansly.com",
  "cdn2.fansly.com",
  "cdn3.fansly.com",
  "cdn4.fansly.com",
  "cdn5.fansly.com",
  "media.fansly.com"
]);
const DOWNLOAD_REVISION_KEY = "fansly-mymedia:download-revision";

type DownloadMetadata = {
  originalFilename: string;
  createdAt: number;
  likeCount: number;
  price: number;
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
      originalFilename?: unknown;
      createdAt?: unknown;
      likeCount?: unknown;
      price?: unknown;
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
      const metadata = validDownloadMetadata(request);
      if (!filename || !mediaId || !metadata) {
        sendResponse({
          ok: false,
          error: "The media filename or identifier was invalid."
        });
        return;
      }

      void startDownload(url, filename, mediaId, previewUrl, metadata)
        .then((downloadId) => sendResponse({ ok: true, downloadId }))
        .catch(() => sendResponse({
          ok: false,
          error: "The browser could not start that download."
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

function validFilename(value: unknown): string | null {
  return isValidDownloadFilename(value) ? value : null;
}

function validMediaId(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;
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
