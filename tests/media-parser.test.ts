import { describe, expect, it } from "vitest";
import { selectDownloadableMedia } from "../src/core/media-parser";

describe("media previews", () => {
  it("uses the smallest regular rendition for a tall portrait image", () => {
    const media = selectDownloadableMedia([{
      id: "100000000000000030",
      likeCount: 17,
      price: 499,
      media: {
        id: "100000000000000031",
        type: 1,
        mimetype: "image/jpeg",
        filename: "portrait.jpeg",
        createdAt: 1_700_000_000,
        width: 860,
        height: 1920,
        locations: [{ location: "https://cdn3.fansly.com/original.jpeg" }],
        variants: [
          imageVariant("100000000000000032", 720, 1608),
          imageVariant("100000000000000033", 480, 1072),
          imageVariant("100000000000000034", 360, 804),
          imageVariant("100000000000000035", 240, 536),
          imageVariant("100000000000000036", 240, 536, 3)
        ]
      }
    }]);

    expect(media).toHaveLength(1);
    expect(media[0]?.previewUrl).toBe(
      "https://cdn3.fansly.com/100000000000000035.jpeg"
    );
    expect(media[0]?.createdAt).toBe(1_700_000_000);
    expect(media[0]?.originalFilename).toBe("portrait.jpeg");
    expect(media[0]?.likeCount).toBe(17);
    expect(media[0]?.price).toBe(499);
  });

  it("does not fall back to a full-resolution image", () => {
    const media = selectDownloadableMedia([{
      id: "100000000000000030",
      media: {
        id: "100000000000000031",
        type: 1,
        mimetype: "image/jpeg",
        filename: "large.jpeg",
        createdAt: 1_700_000_000,
        width: 4000,
        height: 6000,
        locations: [{ location: "https://cdn3.fansly.com/original.jpeg" }],
        variants: []
      }
    }]);

    expect(media[0]?.previewUrl).toBeNull();
  });

  it("keeps type 4 video stripes separate from static thumbnails", () => {
    const media = selectDownloadableMedia([{
      id: "100000000000000030",
      likeCount: 3,
      price: 100,
      media: {
        id: "100000000000000031",
        type: 2,
        mimetype: "video/mp4",
        filename: "video.mp4",
        createdAt: 1_700_000_000,
        width: 1920,
        height: 1080,
        locations: [{ location: "https://cdn3.fansly.com/video.mp4" }],
        variants: [
          imageVariant("100000000000000032", 240, 135),
          imageVariant("100000000000000033", 160, 90, 4)
        ]
      }
    }]);

    expect(media[0]).toMatchObject({
      kind: "video",
      previewUrl: "https://cdn3.fansly.com/100000000000000032.jpeg",
      stripeUrl: "https://cdn3.fansly.com/100000000000000033.jpeg",
      stripeFrameWidth: 160,
      stripeFrameHeight: 90
    });
  });

  it("associates the best signed streaming manifest with its direct video", () => {
    const media = selectDownloadableMedia([{
      id: "100000000000000030",
      media: {
        id: "100000000000000031",
        type: 2,
        mimetype: "video/mp4",
        filename: "video.mp4",
        createdAt: 1_700_000_000,
        width: 1280,
        height: 720,
        locations: [{ location: "https://cdn3.fansly.com/video.mp4" }],
        variants: [
          {
            id: "100000000000000032",
            mimetype: "application/vnd.apple.mpegurl",
            width: 1920,
            height: 1080,
            locations: [{
              location: "https://cdn3.fansly.com/video/stream.m3u8",
              metadata: {
                Policy: "policy",
                Signature: "signature",
                "Key-Pair-Id": "key"
              }
            }]
          },
          {
            id: "100000000000000033",
            mimetype: "application/dash+xml",
            width: 1280,
            height: 720,
            locations: [{ location: "https://cdn3.fansly.com/video/stream.mpd" }]
          }
        ]
      }
    }]);

    const manifest = new URL(media[0]?.manifestUrl ?? "");
    expect(manifest.pathname).toBe("/video/stream.m3u8");
    expect(manifest.searchParams.get("Policy")).toBe("policy");
    expect(manifest.searchParams.get("Signature")).toBe("signature");
    expect(manifest.searchParams.get("Key-Pair-Id")).toBe("key");
  });
});

function imageVariant(
  id: string,
  width: number,
  height: number,
  type = 1
): Record<string, unknown> {
  return {
    id,
    type,
    mimetype: "image/jpeg",
    filename: `${id}.jpeg`,
    width,
    height,
    locations: [{ location: `https://cdn3.fansly.com/${id}.jpeg` }]
  };
}
