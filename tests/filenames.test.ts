import { describe, expect, it } from "vitest";
import {
  buildDownloadFilename,
  isValidDownloadFilename
} from "../src/core/filenames";

describe("download filenames", () => {
  it("builds a filename accepted by the background validator", () => {
    const filename = buildDownloadFilename({
      partnerUsername: "creator_name",
      groupId: "100000000000000000",
      accountMediaId: "100000000000000011",
      extension: "jpg"
    });

    expect(filename).toBe(
      "Fansly MyMedia/creator_name-100000000000000000-100000000000000011.jpg"
    );
    expect(isValidDownloadFilename(filename)).toBe(true);
  });

  it("accepts sanitized Unicode creator names", () => {
    const filename = buildDownloadFilename({
      partnerUsername: "créator",
      groupId: "100000000000000000",
      accountMediaId: "100000000000000011",
      extension: "png"
    });

    expect(isValidDownloadFilename(filename)).toBe(true);
  });

  it("rejects paths outside the extension download folder", () => {
    expect(isValidDownloadFilename("../unsafe.jpg")).toBe(false);
    expect(isValidDownloadFilename("Fansly MyMedia/nested/unsafe.jpg")).toBe(false);
  });
});
