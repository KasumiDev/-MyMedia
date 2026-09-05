import { describe, expect, it } from "vitest";
import {
  includesChatMedia,
  mediaGroupingPath
} from "../src/core/media-source";

describe("chat media direction", () => {
  it("includes media owned by the viewer as sent", () => {
    expect(includesChatMedia("viewer", "viewer", "sent")).toBe(true);
    expect(includesChatMedia("creator", "viewer", "sent")).toBe(false);
  });

  it("includes media owned by the chat partner as received", () => {
    expect(includesChatMedia("creator", "viewer", "received")).toBe(true);
    expect(includesChatMedia("viewer", "viewer", "received")).toBe(false);
  });

  it("includes all media even when ownership is unavailable", () => {
    expect(includesChatMedia("", "", "all")).toBe(true);
  });

  it("puts sent and received chat media into distinct folders", () => {
    expect(mediaGroupingPath({
      source: "chat",
      ownerAccountId: "viewer",
      viewerAccountId: "viewer",
      chatName: "Creator Name"
    })).toEqual(["MyMedia"]);
    expect(mediaGroupingPath({
      source: "chat",
      ownerAccountId: "creator",
      viewerAccountId: "viewer",
      chatName: "Creator Name"
    })).toEqual(["Received", "Creator Name"]);
  });

  it("groups liked and purchased media by creator and bundle", () => {
    expect(mediaGroupingPath({
      source: "liked",
      ownerAccountId: "creator",
      creatorName: "creator_name"
    })).toEqual(["Liked", "creator_name"]);
    expect(mediaGroupingPath({
      source: "purchased",
      ownerAccountId: "creator",
      mediaBundleId: "album"
    })).toEqual(["Purchased", "Creator-creator", "Album-album"]);
  });
});
