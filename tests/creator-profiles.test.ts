import { describe, expect, it } from "vitest";
import { selectCreatorProfiles } from "../src/core/creator-profiles";

describe("creator profiles", () => {
  it("selects account IDs and usernames from an account response", () => {
    expect(selectCreatorProfiles({
      response: {
        accounts: [{
          id: "100000000000000001",
          username: "creator_name",
          displayName: "Creator Name"
        }]
      }
    })).toEqual([{
      accountId: "100000000000000001",
      username: "creator_name"
    }]);
  });

  it("ignores malformed account entries", () => {
    expect(selectCreatorProfiles({
      response: {
        accounts: [{ id: "invalid", username: "creator" }, null]
      }
    })).toEqual([]);
  });

  it("supports an account array returned directly in response", () => {
    expect(selectCreatorProfiles({
      response: [{
        id: "100000000000000002",
        username: "second_creator"
      }]
    })).toEqual([{
      accountId: "100000000000000002",
      username: "second_creator"
    }]);
  });
});
