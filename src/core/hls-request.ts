const CLOUDFRONT_QUERY_PARAMETERS = [
  "Policy",
  "Signature",
  "Key-Pair-Id",
  "Expires"
] as const;

export interface AuthorizedHlsUrl {
  url: string;
  credentialsAttached: boolean;
}

/**
 * HLS child references do not inherit the signed query of their master URL.
 * Copy only CloudFront authorization values, and only to URLs beneath the same
 * CDN origin and media directory.
 */
export function authorizeHlsRequestUrl(
  sourceUrl: string,
  requestUrl: string
): AuthorizedHlsUrl {
  const source = new URL(sourceUrl);
  const request = new URL(requestUrl);
  const directory = source.pathname.slice(0, source.pathname.lastIndexOf("/") + 1);

  if (request.origin !== source.origin || !request.pathname.startsWith(directory)) {
    return { url: request.toString(), credentialsAttached: false };
  }

  let credentialsAttached = false;
  for (const name of CLOUDFRONT_QUERY_PARAMETERS) {
    const value = source.searchParams.get(name);
    if (value && !request.searchParams.has(name)) {
      request.searchParams.set(name, value);
      credentialsAttached = true;
    }
  }

  return { url: request.toString(), credentialsAttached };
}

/**
 * Some Fansly variants contain muxed AAC even though the master also points to
 * separate audio renditions. Removing that binding makes an HLS demuxer inspect
 * the selected MPEG-TS variant for both its video and audio tracks, matching
 * Chrome's native playback behavior.
 */
export function preferMuxedHlsAudio(manifest: string): string {
  return manifest
    .split(/(?<=\n)/u)
    .filter((line) => !isExternalAudioDeclaration(line))
    .map((line) => line.startsWith("#EXT-X-STREAM-INF:")
      ? line.replace(/,AUDIO=(?:"[^"]*"|[^,\r\n]*)/giu, "")
      : line)
    .join("");
}

function isExternalAudioDeclaration(line: string): boolean {
  if (!line.startsWith("#EXT-X-MEDIA:")) return false;
  const attributes = line.slice("#EXT-X-MEDIA:".length);
  return /(?:^|,)TYPE=AUDIO(?:,|\r?$)/iu.test(attributes);
}
