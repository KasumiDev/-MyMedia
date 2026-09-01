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
  const request = message as { type?: unknown; url?: unknown; filename?: unknown };

  if (request.type === "fansly-mymedia:download") {
    const url = validMediaUrl(request.url);
    if (!url || sender.url?.startsWith("https://fansly.com/") !== true) {
      sendResponse({ ok: false, error: "Only an approved Fansly media URL can be downloaded." });
      return;
    }
    void chrome.downloads.download({
      url: url.toString(),
      filename: validFilename(request.filename) ?? "Fansly MyMedia/feasibility-download",
      conflictAction: "uniquify",
      saveAs: false
    }).then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch(() => sendResponse({ ok: false, error: "Chrome could not start that download." }));
    return true;
  }
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
  return typeof value === "string" && /^Fansly MyMedia\/[a-zA-Z0-9_-]+(?:-direct\.mp4|\.mpd|\.m3u8)$/.test(value) ? value : null;
}
