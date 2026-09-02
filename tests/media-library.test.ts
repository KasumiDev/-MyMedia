import { describe, expect, it } from "vitest";
import { mergeUniqueMedia } from "../src/core/media-library";

describe("media library", () => {
  it("removes duplicate media from the same API page", () => {
    const result = mergeUniqueMedia([], [
      { mediaId: "media-1", accountMediaId: "account-media-1" },
      { mediaId: "media-1", accountMediaId: "account-media-2" }
    ]);

    expect(result).toEqual([
      { mediaId: "media-1", accountMediaId: "account-media-1" }
    ]);
  });

  it("does not add media already discovered on an earlier page", () => {
    const existing = [
      { mediaId: "media-1", accountMediaId: "account-media-1" }
    ];
    const result = mergeUniqueMedia(existing, [
      { mediaId: "media-1", accountMediaId: "account-media-2" },
      { mediaId: "media-2", accountMediaId: "account-media-3" }
    ]);

    expect(result).toEqual([
      { mediaId: "media-1", accountMediaId: "account-media-1" },
      { mediaId: "media-2", accountMediaId: "account-media-3" }
    ]);
  });
});
