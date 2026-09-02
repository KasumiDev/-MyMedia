import { describe, expect, it } from "vitest";
import { sortMedia } from "../src/core/media-sort";

const media = [
  { mediaId: "one", createdAt: 100, price: 20, likeCount: 5 },
  { mediaId: "two", createdAt: 300, price: 0, likeCount: 10 },
  { mediaId: "three", createdAt: 200, price: 40, likeCount: 1 }
];

describe("media sorting", () => {
  it("sorts by creation time in either direction", () => {
    expect(sortMedia(media, "created-desc").map(({ mediaId }) => mediaId))
      .toEqual(["two", "three", "one"]);
    expect(sortMedia(media, "created-asc").map(({ mediaId }) => mediaId))
      .toEqual(["one", "three", "two"]);
  });

  it("sorts by price and likes", () => {
    expect(sortMedia(media, "price-desc").map(({ mediaId }) => mediaId))
      .toEqual(["three", "one", "two"]);
    expect(sortMedia(media, "likes-desc").map(({ mediaId }) => mediaId))
      .toEqual(["two", "one", "three"]);
  });

  it("puts records without the selected metadata last", () => {
    const result = sortMedia([...media, { mediaId: "legacy" }], "created-desc");
    expect(result.at(-1)?.mediaId).toBe("legacy");
  });
});
