import { describe, expect, it } from "vitest";

import {
  BRIDGE_RELAY_REQUEST,
  parseRelayRequest
} from "../src/core/relay-protocol";

describe("extension-page relay protocol", () => {
  it("accepts bounded group pagination requests", () => {
    expect(parseRelayRequest({
      type: BRIDGE_RELAY_REQUEST,
      operation: "groups",
      offset: 30
    })).toEqual({
      type: BRIDGE_RELAY_REQUEST,
      operation: "groups",
      offset: 30
    });
  });

  it("accepts validated media cursor requests", () => {
    expect(parseRelayRequest({
      type: BRIDGE_RELAY_REQUEST,
      operation: "media",
      groupId: "100000000000000010",
      before: "100000000000000011"
    })).toEqual({
      type: BRIDGE_RELAY_REQUEST,
      operation: "media",
      groupId: "100000000000000010",
      before: "100000000000000011"
    });
  });

  it("rejects malformed operations and identifiers", () => {
    expect(parseRelayRequest({
      type: BRIDGE_RELAY_REQUEST,
      operation: "fetch-anything",
      offset: 0
    })).toBeNull();
    expect(parseRelayRequest({
      type: BRIDGE_RELAY_REQUEST,
      operation: "media",
      groupId: "../../other",
      before: ""
    })).toBeNull();
  });
});
