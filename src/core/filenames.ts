const WINDOWS_RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`)
]);

const FALLBACK_EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpeg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov"
};

const EXTENSIONS_BY_MIME: Record<string, readonly string[]> = {
  "image/jpeg": ["jpeg", "jpg"],
  "image/jpg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "image/avif": ["avif"],
  "video/mp4": ["mp4", "m4v"],
  "video/webm": ["webm"],
  "video/quicktime": ["mov"]
};

/**
 * Produces one safe path component. It deliberately does not preserve path
 * separators, control characters, or Windows-reserved device names.
 */
export function sanitizeFilenameComponent(value: string, fallback = "unknown"): string {
  const normalized = value.normalize("NFKC")
    .replace(/[<>:"/\\|?*]/g, "-")
    .split("")
    .map((character) => character.charCodeAt(0) < 32 ? "-" : character)
    .join("")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\- ]+|[.\- ]+$/g, "")
    .slice(0, 80);
  const result = normalized || fallback;
  return WINDOWS_RESERVED_NAMES.has(result.toLowerCase()) ? `${result}-file` : result;
}

export function extensionForMedia(mimetype: string, sourceFilename?: string): string | null {
  const mime = mimetype.toLowerCase();
  const allowed = EXTENSIONS_BY_MIME[mime];
  if (!allowed) return null;
  const match = sourceFilename?.match(/\.([a-z0-9]{1,8})$/i);
  const sourceExtension = match?.[1]?.toLowerCase();
  if (sourceExtension && allowed.includes(sourceExtension)) return sourceExtension;
  return FALLBACK_EXTENSION_BY_MIME[mime] ?? null;
}

export interface DownloadFilenameInput {
  partnerUsername: string;
  groupId: string;
  accountMediaId: string;
  extension: string;
}

/** A deterministic filename; account-media IDs make same-named uploads safe. */
export function buildDownloadFilename(input: DownloadFilenameInput): string {
  const extension = input.extension.toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(extension)) throw new Error("Invalid media filename extension");
  const partner = sanitizeFilenameComponent(input.partnerUsername, "unknown-partner");
  const group = sanitizeFilenameComponent(input.groupId, "unknown-group");
  const media = sanitizeFilenameComponent(input.accountMediaId, "unknown-media");
  return `Fansly MyMedia/${partner}-${group}-${media}.${extension}`;
}

export function isValidDownloadFilename(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 240) return false;
  return /^Fansly MyMedia\/[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,79}-\d{6,30}-\d{6,30}\.[a-z0-9]{1,8}$/.test(value);
}
