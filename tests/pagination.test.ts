import { describe, expect, it } from "vitest";
import { paginateGroups, paginateMedia, RepeatedCursorError } from "../src/core/pagination";

describe("pagination", () => {
  it("paginates groups by offset until a valid empty page", async () => {
    const offsets: number[] = [];
    const result = await paginateGroups(async (offset) => {
      offsets.push(offset);
      return { groups: offset === 0 ? [{ groupId: "1", partnerUsername: "a" }] : [] };
    }, { pageSize: 30, signal: new AbortController().signal });
    expect(offsets).toEqual([0, 30]);
    expect(result).toHaveLength(1);
  });

  it("starts media pagination at an empty cursor and advances from final offer", async () => {
    const cursors: string[] = [];
    await paginateMedia(async (before) => {
      cursors.push(before);
      return before === "" ? { offers: [{ id: "a" }, { id: "b" }], accountMediaCount: 0 } : { offers: [], accountMediaCount: 0 };
    }, { signal: new AbortController().signal });
    expect(cursors).toEqual(["", "b"]);
  });

  it("rejects a repeated cursor", async () => {
    await expect(paginateMedia(async () => ({ offers: [{ id: "same" }], accountMediaCount: 0 }), { signal: new AbortController().signal }))
      .rejects.toBeInstanceOf(RepeatedCursorError);
  });
});
