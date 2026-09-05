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

  it("accepts album discovery and album media pagination", () => {
    expect(parseRelayRequest({
      type: BRIDGE_RELAY_REQUEST,
      operation: "albums"
    })).toEqual({
      type: BRIDGE_RELAY_REQUEST,
      operation: "albums"
    });
    expect(parseRelayRequest({
      type: BRIDGE_RELAY_REQUEST,
      operation: "albumMedia",
      albumId: "100000000000000002",
      before: "100000000000000013"
    })).toEqual({
      type: BRIDGE_RELAY_REQUEST,
      operation: "albumMedia",
      albumId: "100000000000000002",
      before: "100000000000000013"
    });
  });

  it("accepts a partner account when requesting received chat media", () => {
    expect(parseRelayRequest({
      type: BRIDGE_RELAY_REQUEST,
      operation: "media",
      groupId: "100000000000000001",
      accountId: "100000000000000002",
      before: ""
    })).toEqual({
      type: BRIDGE_RELAY_REQUEST,
      operation: "media",
      groupId: "100000000000000001",
      accountId: "100000000000000002",
      before: ""
    });
  });

  it("rejects an invalid partner account ID", () => {
    expect(parseRelayRequest({
      type: BRIDGE_RELAY_REQUEST,
      operation: "media",
      groupId: "100000000000000001",
      accountId: "invalid",
      before: ""
    })).toBeNull();
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
    expect(parseRelayRequest({
      type: BRIDGE_RELAY_REQUEST,
      operation: "albumMedia",
      albumId: "not-an-id",
      before: ""
    })).toBeNull();
  });
});
