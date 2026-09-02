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

export function sanitizeOriginalFilename(value: string): string {
  const sanitized = value.normalize("NFKC")
    .replace(/[<>:"/\\|?*]/g, "-")
    .split("")
    .map((character) => character.charCodeAt(0) < 32 ? "-" : character)
    .join("")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 180);
  return sanitized || "unknown-file";
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
  mediaId: string;
  createdAt: number;
  extension: string;
}

/** A sortable deterministic filename; media IDs provide collision safety. */
export function buildDownloadFilename(input: DownloadFilenameInput): string {
  const extension = input.extension.toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(extension)) throw new Error("Invalid media filename extension");
  const media = sanitizeFilenameComponent(input.mediaId, "unknown-media");
  const date = formatMediaCreatedAt(input.createdAt);
  return `Fansly MyMedia/${date}-${media}.${extension}`;
}

export function formatMediaCreatedAt(createdAt: number): string {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return "unknown-date";
  const date = new Date(createdAt * 1_000);
  return Number.isNaN(date.getTime()) ? "unknown-date" : date.toISOString().slice(0, 10);
}

export function isValidDownloadFilename(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 240) return false;
  return /^Fansly MyMedia\/[^<>:"/\\|?*\r\n]{1,220}\.[a-z0-9]{1,8}$/u.test(value);
}
