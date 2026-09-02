import { describe, expect, it } from "vitest";
import {
  isApprovedManifestUrl,
  isNativeHostMessage
} from "../src/core/native-protocol";

describe("native companion protocol", () => {
  it("accepts approved signed Fansly manifests", () => {
    expect(isApprovedManifestUrl(
      "https://cdn3.fansly.com/account/media/stream.m3u8?Policy=secret"
    )).toBe(true);
    expect(isApprovedManifestUrl(
      "https://cdn5.fansly.com/account/media/manifest.mpd?Signature=secret"
    )).toBe(true);
  });

  it("rejects non-CDN, insecure, and non-manifest URLs", () => {
    expect(isApprovedManifestUrl("https://example.com/stream.m3u8")).toBe(false);
    expect(isApprovedManifestUrl("http://cdn3.fansly.com/stream.m3u8")).toBe(false);
    expect(isApprovedManifestUrl("https://cdn3.fansly.com/video.mp4")).toBe(false);
  });

  it("validates responses and download events", () => {
    expect(isNativeHostMessage({
      type: "response",
      requestId: "request-1",
      ok: true,
      version: "0.1.0",
      capabilities: { hls: true, dash: true, cancel: true }
    })).toBe(true);
    expect(isNativeHostMessage({
      type: "download.progress",
      jobId: "job-1",
      progress: { percent: 42.5, speed: 1.3 }
    })).toBe(true);
    expect(isNativeHostMessage({
      type: "download.completed",
      jobId: "job-1",
      outputFilename: "2026-09-02-123.mp4"
    })).toBe(true);
  });

  it("rejects unsafe completion filenames and malformed progress", () => {
    expect(isNativeHostMessage({
      type: "download.completed",
      jobId: "job-1",
      outputFilename: "../outside.mp4"
    })).toBe(false);
    expect(isNativeHostMessage({
      type: "download.progress",
      jobId: "job-1",
      progress: { percent: -1 }
    })).toBe(false);
  });
});
