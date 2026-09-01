import { updateDownloadByChromeId, upsertDownloadRecord } from "../storage/download-index";

import { isValidDownloadFilename } from "../core/filenames";

const MEDIA_HOSTS = new Set([
  "cdn1.fansly.com",
  "cdn2.fansly.com",
  "cdn3.fansly.com",
  "cdn4.fansly.com",
  "cdn5.fansly.com",
  "media.fansly.com"
]);

export function installServiceWorker(): void {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== "object") return;
  const request = message as { type?: unknown; url?: unknown; filename?: unknown; mediaId?: unknown };

  if (request.type === "fansly-mymedia:download") {
    const url = validMediaUrl(request.url);
    if (!url || sender.url?.startsWith("https://fansly.com/") !== true) {
      sendResponse({ ok: false, error: "Only an approved Fansly media URL can be downloaded." });
      return;
    }
    const filename = validFilename(request.filename) ?? "Fansly MyMedia/feasibility-download";
    void chrome.downloads.download({
      url: url.toString(),
      filename,
      conflictAction: "uniquify",
      saveAs: false
    }).then((downloadId) => {
      // Do not persist url: it may contain temporary access signatures.
      const mediaId = validMediaId(request.mediaId) ?? `download-${downloadId}`;
      void upsertDownloadRecord({
        mediaId,
        filename,
        state: "downloading",
        chromeDownloadId: downloadId,
        updatedAt: Date.now()
      }).catch(() => {
        // The download itself succeeded; a transient storage failure must not
        // make the user believe otherwise.
      });
      sendResponse({ ok: true, downloadId });
    })
      .catch(() => sendResponse({ ok: false, error: "Chrome could not start that download." }));
    return true;
  }
  });

  chrome.downloads.onChanged.addListener((delta) => {
    const state = delta.state?.current;
    if (state !== "complete" && state !== "interrupted") return;
    void updateDownloadByChromeId(delta.id, (record) => ({
      ...record,
      state: state === "complete" ? "completed" : "failed",
      ...(state === "interrupted" ? { error: delta.error?.current ?? "Chrome download was interrupted." } : { error: undefined }),
      updatedAt: Date.now()
    })).catch(() => {
      // Storage is best-effort here. Do not interfere with Chrome's download.
    });
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
