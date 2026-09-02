import { extensionForMedia } from "./filenames";

export type DirectMediaKind = "image" | "video";

export interface DownloadableMedia {
  accountMediaId: string;
  mediaId: string;
  kind: DirectMediaKind;
  mimetype: string;
  url: string;
  width: number;
  height: number;
  extension: string;
  previewUrl: string | null;
}

export interface ManifestMedia {
  accountMediaId: string;
  mediaId: string;
  mimetype: "application/dash+xml" | "application/vnd.apple.mpegurl";
  url: string;
  width: number;
  height: number;
}

type UnknownRecord = Record<string, unknown>;

/**
 * Selects exactly one highest-resolution direct rendition for every accessible
 * account-media record. HLS/DASH manifests are intentionally excluded.
 */
export function selectDownloadableMedia(accountMedia: unknown[]): DownloadableMedia[] {
  return accountMedia.flatMap(selectAccountMedia).sort((left, right) =>
    left.accountMediaId.localeCompare(right.accountMediaId));
}

export function selectDiagnosticManifest(
  accountMedia: unknown[],
  mimetype: ManifestMedia["mimetype"]
): ManifestMedia | null {
  const candidates: ManifestMedia[] = [];
  for (const record of accountMedia) {
    const accountMediaId = idFrom(record, "id");
    const media = recordFrom(record)?.media;
    if (!accountMediaId || !isRecord(media)) continue;
    for (const rendition of renditions(media)) {
      if (stringFrom(rendition, "mimetype")?.toLowerCase() !== mimetype) continue;
      const url = signedLocation(firstArrayValue(rendition, "locations"));
      const mediaId = idFrom(rendition, "id") ?? idFrom(media, "id");
      if (!url || !mediaId) continue;
      candidates.push({ accountMediaId, mediaId, mimetype, url, width: numberFrom(rendition, "width"), height: numberFrom(rendition, "height") });
    }
  }
  candidates.sort(compareQuality);
  return candidates[0] ?? null;
}

function selectAccountMedia(value: unknown): DownloadableMedia[] {
  const record = recordFrom(value);
  const accountMediaId = idFrom(record, "id");
  const media = record?.media;
  if (!accountMediaId || !isRecord(media)) return [];
  const candidates: DownloadableMedia[] = [];
  for (const rendition of renditions(media)) {
    const mimetype = stringFrom(rendition, "mimetype")?.toLowerCase() ?? "";
    const kind = mimetype.startsWith("image/") ? "image" : mimetype.startsWith("video/") ? "video" : null;
    const extension = extensionForMedia(mimetype, stringFrom(rendition, "filename") ?? undefined);
    const url = signedLocation(firstArrayValue(rendition, "locations"));
    const mediaId = idFrom(rendition, "id") ?? idFrom(media, "id");
    if (!kind || !extension || !url || !mediaId) continue;
    const previewUrl = selectPreview(media, kind);
    candidates.push({ accountMediaId, mediaId, kind, mimetype, extension, url, previewUrl, width: numberFrom(rendition, "width"), height: numberFrom(rendition, "height") });
  }
  candidates.sort(compareQuality);
  return candidates.slice(0, 1);
}

function selectPreview(media: UnknownRecord, kind: DirectMediaKind): string | null {
  const previews = renditions(media).filter((item) => {
    const mime = stringFrom(item, "mimetype") ?? "";
    return mime.startsWith("image/") && (kind === "video" || numberFrom(item, "height") <= 480);
  });
  previews.sort((a, b) => numberFrom(b, "height") - numberFrom(a, "height"));
  return previews.map((item) => signedLocation(firstArrayValue(item, "locations"))).find((url): url is string => url !== null) ?? null;
}

function renditions(media: UnknownRecord): UnknownRecord[] {
  const variants = Array.isArray(media.variants) ? media.variants.filter(isRecord) : [];
  return [media, ...variants];
}

function compareQuality(left: { width: number; height: number }, right: { width: number; height: number }): number {
  const leftPixels = left.width * left.height;
  const rightPixels = right.width * right.height;
  return rightPixels - leftPixels || right.height - left.height || right.width - left.width;
}

/** Adds CloudFront signature fields that Fansly supplies separately. */
export function signedLocation(value: unknown): string | null {
  const entry = recordFrom(value);
  if (!entry || typeof entry.location !== "string" || entry.location.length > 8_192) return null;
  try {
    const url = new URL(entry.location);
    const metadata = recordFrom(entry.metadata);
    for (const key of ["Key-Pair-Id", "Signature", "Policy"]) {
      if (typeof metadata?.[key] === "string" && !url.searchParams.has(key)) url.searchParams.set(key, metadata[key] as string);
    }
    return url.protocol === "https:" ? url.toString() : null;
  } catch { return null; }
}

function firstArrayValue(value: UnknownRecord, key: string): unknown {
  const values = value[key];
  return Array.isArray(values) ? values[0] : undefined;
}
function recordFrom(value: unknown): UnknownRecord | null { return isRecord(value) ? value : null; }
function isRecord(value: unknown): value is UnknownRecord { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function stringFrom(value: UnknownRecord, key: string): string | null { return typeof value[key] === "string" ? value[key] : null; }
function numberFrom(value: UnknownRecord, key: string): number { return typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : 0; }
function idFrom(value: unknown, key: string): string | null {
  const candidate = recordFrom(value)?.[key];
  const id = typeof candidate === "string" || typeof candidate === "number" ? String(candidate) : "";
  return /^\d{6,30}$/.test(id) ? id : null;
}
