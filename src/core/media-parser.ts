import { extensionForMedia, sanitizeOriginalFilename } from "./filenames";

export type DirectMediaKind = "image" | "video";

export interface DownloadableMedia {
  accountMediaId: string;
  mediaId: string;
  kind: DirectMediaKind;
  mimetype: string;
  url: string;
  width: number;
  height: number;
  createdAt: number;
  originalFilename: string;
  likeCount: number;
  price: number;
  extension: string;
  previewUrl: string | null;
  stripeUrl: string | null;
  stripeFrameWidth: number;
  stripeFrameHeight: number;
  manifestUrl: string | null;
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
const MAX_PREVIEW_PIXELS = 1_000_000;

/**
 * Selects exactly one highest-resolution direct rendition for every accessible
 * account-media record. A video's preferred streaming manifest is associated
 * in-memory so the companion can retrieve its full-quality representation.
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
  if (!record) return [];
  const accountMediaId = idFrom(record, "id");
  const media = record.media;
  if (!accountMediaId || !isRecord(media)) return [];
  const rootMimetype = stringFrom(media, "mimetype")?.toLowerCase() ?? "";
  const rootKind = rootMimetype.startsWith("image/")
    ? "image"
    : rootMimetype.startsWith("video/")
      ? "video"
      : null;
  if (!rootKind) return [];
  const candidates: DownloadableMedia[] = [];
  const previewUrl = selectPreview(media);
  const stripe = selectVideoStripe(media);
  const manifestUrl = rootKind === "video" ? selectPreferredManifest(media) : null;
  for (const rendition of renditions(media)) {
    const mimetype = stringFrom(rendition, "mimetype")?.toLowerCase() ?? "";
    const kind = mimetype.startsWith("image/") ? "image" : mimetype.startsWith("video/") ? "video" : null;
    const extension = extensionForMedia(mimetype, stringFrom(rendition, "filename") ?? undefined);
    const url = signedLocation(firstArrayValue(rendition, "locations"));
    const mediaId = idFrom(rendition, "id") ?? idFrom(media, "id");
    if (kind !== rootKind || !extension || !url || !mediaId) continue;
    candidates.push({
      accountMediaId,
      mediaId,
      kind,
      mimetype,
      extension,
      url,
      previewUrl,
      width: numberFrom(rendition, "width"),
      height: numberFrom(rendition, "height"),
      createdAt: numberFrom(media, "createdAt"),
      originalFilename: sanitizeOriginalFilename(
        stringFrom(media, "filename") ?? "unknown-file"
      ),
      likeCount: numberFrom(record, "likeCount"),
      price: numberFrom(record, "price"),
      stripeUrl: kind === "video" ? stripe?.url ?? null : null,
      stripeFrameWidth: kind === "video" ? stripe?.width ?? 0 : 0,
      stripeFrameHeight: kind === "video" ? stripe?.height ?? 0 : 0,
      manifestUrl: kind === "video" ? manifestUrl : null
    });
  }
  candidates.sort(compareQuality);
  return candidates.slice(0, 1);
}

function selectPreferredManifest(media: UnknownRecord): string | null {
  const manifests = renditions(media).flatMap((rendition) => {
    const mimetype = stringFrom(rendition, "mimetype")?.toLowerCase();
    const url = signedLocation(firstArrayValue(rendition, "locations"));
    if (!url || (mimetype !== "application/dash+xml"
      && mimetype !== "application/vnd.apple.mpegurl")) {
      return [];
    }

    return [{
      url,
      width: numberFrom(rendition, "width"),
      height: numberFrom(rendition, "height"),
      formatRank: mimetype === "application/dash+xml" ? 0 : 1
    }];
  });

  manifests.sort((left, right) =>
    compareQuality(left, right) || left.formatRank - right.formatRank
  );
  return manifests[0]?.url ?? null;
}

function selectPreview(media: UnknownRecord): string | null {
  const previews = variants(media).flatMap((item) => {
    const mimetype = stringFrom(item, "mimetype")?.toLowerCase() ?? "";
    const width = numberFrom(item, "width");
    const height = numberFrom(item, "height");
    const url = signedLocation(firstArrayValue(item, "locations"));
    const type = numberFrom(item, "type");
    const isPreview = type !== 3 && type !== 4;
    const isReasonableSize = width > 0
      && height > 0
      && width * height <= MAX_PREVIEW_PIXELS;

    return mimetype.startsWith("image/") && isPreview && isReasonableSize && url
      ? [{ url, width, height }]
      : [];
  });

  previews.sort(comparePreviewSize);
  return previews[0]?.url ?? null;
}

function selectVideoStripe(
  media: UnknownRecord
): { url: string; width: number; height: number } | null {
  const stripes = variants(media).flatMap((item) => {
    const mimetype = stringFrom(item, "mimetype")?.toLowerCase() ?? "";
    const width = numberFrom(item, "width");
    const height = numberFrom(item, "height");
    const url = signedLocation(firstArrayValue(item, "locations"));
    return numberFrom(item, "type") === 4
      && mimetype.startsWith("image/")
      && width > 0
      && height > 0
      && url
      ? [{ url, width, height }]
      : [];
  });
  stripes.sort(comparePreviewSize);
  return stripes[0] ?? null;
}

function renditions(media: UnknownRecord): UnknownRecord[] {
  return [media, ...variants(media)];
}

function variants(media: UnknownRecord): UnknownRecord[] {
  return Array.isArray(media.variants) ? media.variants.filter(isRecord) : [];
}

function comparePreviewSize(
  left: { width: number; height: number },
  right: { width: number; height: number }
): number {
  const pixelDifference = left.width * left.height - right.width * right.height;
  return pixelDifference || left.width - right.width || left.height - right.height;
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
