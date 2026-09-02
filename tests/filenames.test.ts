import { describe, expect, it } from "vitest";
import {
  buildDownloadFilename,
  formatMediaCreatedAt,
  isValidDownloadFilename,
  sanitizeOriginalFilename
} from "../src/core/filenames";

describe("download filenames", () => {
  it("builds a filename accepted by the background validator", () => {
    const filename = buildDownloadFilename({
      mediaId: "100000000000000011",
      createdAt: 1_767_225_600,
      extension: "jpg"
    });

    expect(filename).toBe(
      "Fansly MyMedia/2026-01-01-100000000000000011.jpg"
    );
    expect(isValidDownloadFilename(filename)).toBe(true);
  });

  it("formats Fansly timestamps as UTC calendar dates", () => {
    expect(formatMediaCreatedAt(1_767_225_600)).toBe("2026-01-01");
    expect(formatMediaCreatedAt(0)).toBe("unknown-date");
  });

  it("rejects paths outside the extension download folder", () => {
    expect(isValidDownloadFilename("../unsafe.jpg")).toBe(false);
    expect(isValidDownloadFilename("Fansly MyMedia/nested/unsafe.jpg")).toBe(false);
  });

  it("keeps a safe display copy of the original filename", () => {
    expect(sanitizeOriginalFilename("My original image 01.jpeg"))
      .toBe("My original image 01.jpeg");
    expect(sanitizeOriginalFilename("../unsafe\\name.jpg"))
      .toBe("..-unsafe-name.jpg");
  });
});
