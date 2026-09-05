import { describe, expect, it } from "vitest";
import { paginateGroups, paginateMedia, RepeatedCursorError } from "../src/core/pagination";

describe("pagination", () => {
  it("paginates groups by offset until a valid empty page", async () => {
    const offsets: number[] = [];
    const result = await paginateGroups(async (offset) => {
      offsets.push(offset);
      return {
        groups: offset === 0
          ? [{ groupId: "1", partnerUsername: "a", partnerAccountId: "2" }]
          : []
      };
    }, { pageSize: 30, signal: new AbortController().signal });
    expect(offsets).toEqual([0, 30]);
    expect(result).toHaveLength(1);
  });

  it("stops group discovery at the configured chat limit", async () => {
    const offsets: number[] = [];
    const result = await paginateGroups(async (offset) => {
      offsets.push(offset);
      return {
        groups: Array.from({ length: 30 }, (_, index) => ({
          groupId: String(offset + index + 1),
          partnerUsername: `creator-${offset + index + 1}`,
          partnerAccountId: String(offset + index + 101)
        }))
      };
    }, {
      pageSize: 30,
      limit: 10,
      signal: new AbortController().signal
    });

    expect(offsets).toEqual([0]);
    expect(result).toHaveLength(10);
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
