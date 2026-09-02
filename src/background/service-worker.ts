import {
  isValidDownloadDirectory,
  isValidDownloadFilename,
  sanitizeOriginalFilename
} from "../core/filenames";
import {
  BROWSER_DOWNLOAD_PROCESSOR_KEY,
  BROWSER_DOWNLOAD_REVISION_KEY,
  browserDownloadJobKey,
  browserDownloadQueueKey,
  type BrowserDownloadJob
} from "../core/browser-download";
import {
  loadDownloadIndex,
  loadDownloadThumbnailDataUrl,
  migrateLegacyDownloadIndex,
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
      accountMediaId?: unknown;
      sourceGroupId?: unknown;
      previewUrl?: unknown;
      manifestUrl?: unknown;
      originalFilename?: unknown;
      createdAt?: unknown;
      likeCount?: unknown;
      price?: unknown;
      debug?: unknown;
      downloadDirectory?: unknown;
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

    if (request.type === "fansly-mymedia:open-download-manager") {
      if (sender.url?.startsWith("https://fansly.com/") !== true) {
        sendResponse({ ok: false });
        return;
      }
      void openDownloadManager(true)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
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
      const accountMediaId = validMediaId(request.accountMediaId);
      const sourceGroupId = validGroupId(request.sourceGroupId);
      const previewUrl = validMediaUrl(request.previewUrl);
      const manifestUrl = validMediaUrl(request.manifestUrl);
      const metadata = validDownloadMetadata(request);
      const downloadDirectory = validDownloadDirectory(request.downloadDirectory);
      if (!filename || !mediaId || !accountMediaId || !sourceGroupId
        || !metadata || !downloadDirectory
        || !filename.startsWith(`${downloadDirectory}/`)) {
        sendResponse({
          ok: false,
          error: "The media filename or identifier was invalid."
        });
        return;
      }

      const hlsManifest = manifestUrl && isHlsManifest(manifestUrl)
        ? manifestUrl
        : null;
      const historyFilename = hlsManifest
        ? filename.replace(/\.[a-z0-9]{1,8}$/iu, ".mp4")
        : filename;
      const job: BrowserDownloadJob = {
        kind: hlsManifest ? "hls" : "direct",
        sourceUrl: (hlsManifest ?? url).toString(),
        outputFilename: historyFilename.slice(historyFilename.lastIndexOf("/") + 1),
        historyFilename,
        mediaId,
        accountMediaId,
        sourceGroupId,
        ...metadata,
        debug: request.debug === true
      };

      void storeBrowserJob(job)
        .then(() => queueBrowserDownload(job))
        .then(async (result) => {
          if (previewUrl) {
            await createAndStoreThumbnail(mediaId, previewUrl).catch(() => undefined);
          }
          return result;
        })
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

}

async function queueBrowserDownload(
  input: BrowserDownloadJob
): Promise<{ mode: "browser-native" }> {
  await upsertDownloadRecord({
    mediaId: input.mediaId,
    accountMediaId: input.accountMediaId,
    sourceGroupId: input.sourceGroupId,
    filename: input.historyFilename,
    originalFilename: input.originalFilename,
    createdAt: input.createdAt,
    likeCount: input.likeCount,
    price: input.price,
    state: "queued",
    updatedAt: Date.now()
  });
  await publishDownloadIndex();

  await chrome.storage.session.set({
    [browserDownloadQueueKey(input.mediaId)]: Date.now()
  });
  await chrome.storage.local.set({
    [BROWSER_DOWNLOAD_REVISION_KEY]: `${Date.now()}-${crypto.randomUUID()}`
  });
  await openDownloadManager(false);
  return { mode: "browser-native" };
}

async function storeBrowserJob(input: BrowserDownloadJob): Promise<void> {
  await chrome.storage.session.set({
    [browserDownloadJobKey(input.mediaId)]: input
  });
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

function isHlsManifest(url: URL): boolean {
  return /\.m3u8$/iu.test(url.pathname);
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

function validGroupId(value: unknown): string | null {
  return typeof value === "string" && /^\d{6,30}$/u.test(value) ? value : null;
}

async function openDownloadManager(settingsOnly: boolean): Promise<void> {
  const baseUrl = chrome.runtime.getURL("download.html");
  if (settingsOnly) {
    await chrome.tabs.create({ url: `${baseUrl}?settings=1`, active: true });
    return;
  }

  const stored = await chrome.storage.session.get(BROWSER_DOWNLOAD_PROCESSOR_KEY);
  const heartbeat = stored[BROWSER_DOWNLOAD_PROCESSOR_KEY];
  if (typeof heartbeat === "number" && Date.now() - heartbeat < 12_000) return;

  await chrome.storage.session.set({
    [BROWSER_DOWNLOAD_PROCESSOR_KEY]: Date.now()
  });
  await chrome.tabs.create({ url: baseUrl, active: true });
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
