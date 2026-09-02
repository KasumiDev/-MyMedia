import { describe, expect, it } from "vitest";

import {
  authorizeHlsRequestUrl,
  preferMuxedHlsAudio
} from "../src/core/hls-request";

const SOURCE = [
  "https://cdn3.fansly.com/new/account/media/master.m3u8",
  "?Policy=policy&Signature=signature&Key-Pair-Id=key"
].join("");

describe("HLS request authorization", () => {
  it("adds signed CloudFront values to child playlists and segments", () => {
    const result = authorizeHlsRequestUrl(
      SOURCE,
      "https://cdn3.fansly.com/new/account/media/audio/aac/und/segment-0.aac"
    );
    const url = new URL(result.url);

    expect(result.credentialsAttached).toBe(true);
    expect(url.searchParams.get("Policy")).toBe("policy");
    expect(url.searchParams.get("Signature")).toBe("signature");
    expect(url.searchParams.get("Key-Pair-Id")).toBe("key");
  });

  it("does not overwrite credentials already present on a child URL", () => {
    const result = authorizeHlsRequestUrl(
      SOURCE,
      "https://cdn3.fansly.com/new/account/media/segment.ts?Policy=child"
    );
    const url = new URL(result.url);

    expect(url.searchParams.get("Policy")).toBe("child");
    expect(url.searchParams.get("Signature")).toBe("signature");
  });

  it("does not disclose credentials to another origin or media directory", () => {
    const otherOrigin = authorizeHlsRequestUrl(
      SOURCE,
      "https://example.com/new/account/media/segment.ts"
    );
    const siblingDirectory = authorizeHlsRequestUrl(
      SOURCE,
      "https://cdn3.fansly.com/new/account/other/segment.ts"
    );

    expect(otherOrigin.credentialsAttached).toBe(false);
    expect(new URL(otherOrigin.url).search).toBe("");
    expect(siblingDirectory.credentialsAttached).toBe(false);
    expect(new URL(siblingDirectory.url).search).toBe("");
  });
});

describe("muxed HLS audio preference", () => {
  it("removes external audio declarations and variant bindings", () => {
    const manifest = [
      "#EXTM3U\r\n",
      "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio_aac\",URI=\"audio/stream.m3u8\"\r\n",
      "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",URI=\"subs.m3u8\"\r\n",
      "#EXT-X-STREAM-INF:BANDWIDTH=100,CODECS=\"avc1,mp4a\",AUDIO=\"audio_aac\"\r\n",
      "media-1/stream.m3u8\r\n"
    ].join("");

    expect(preferMuxedHlsAudio(manifest)).toBe([
      "#EXTM3U\r\n",
      "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",URI=\"subs.m3u8\"\r\n",
      "#EXT-X-STREAM-INF:BANDWIDTH=100,CODECS=\"avc1,mp4a\"\r\n",
      "media-1/stream.m3u8\r\n"
    ].join(""));
  });
});
