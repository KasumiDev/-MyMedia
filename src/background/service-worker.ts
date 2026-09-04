import {
  isValidDownloadDirectory,
  isValidDownloadFilename,
  sanitizeOriginalFilename
} from "../core/filenames";
import {
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

  chrome.action.onClicked.addListener(() => {
    void openLibraryPage();
  });

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!message || typeof message !== "object") return;
    const request = message as {
      type?: unknown;
      url?: unknown;
      filename?: unknown;
      mediaId?: unknown;
      accountMediaId?: unknown;
      sourceGroupId?: unknown;
      sourceType?: unknown;
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
      if (!isLibrarySender(sender)) {
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
      if (!mediaId || !isLibrarySender(sender)) {
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
      if (!url || !isLibrarySender(sender)) {
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
      const sourceType = validSourceType(request.sourceType);
      const previewUrl = validMediaUrl(request.previewUrl);
      const manifestUrl = validMediaUrl(request.manifestUrl);
      const metadata = validDownloadMetadata(request);
      const downloadDirectory = validDownloadDirectory(request.downloadDirectory);
      if (!filename || !mediaId || !accountMediaId || !sourceGroupId || !sourceType
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
        sourceType,
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
    sourceType: input.sourceType,
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

function validSourceType(value: unknown): "chat" | "album" | null {
  return value === "chat" || value === "album" ? value : null;
}

async function openLibraryPage(): Promise<void> {
  const url = chrome.runtime.getURL("library.html");
  const contexts = await new Promise<chrome.runtime.ExtensionContext[]>((resolve) => {
    chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.TAB],
      documentUrls: [url]
    }, resolve);
  });
  const existing = contexts.find((context) => context.tabId >= 0);
  if (existing) {
    await chrome.tabs.update(existing.tabId, { active: true });
    if (existing.windowId >= 0) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url, active: true });
}

function isLibrarySender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id
    && sender.url?.startsWith(chrome.runtime.getURL("library.html")) === true;
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
