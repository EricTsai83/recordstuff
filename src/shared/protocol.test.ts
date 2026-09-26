import { describe, expect, it } from "vitest";
import { isHostMessage, isMainMessage } from "./protocol";
import { DEFAULT_QUALITY } from "./quality";

const capture = { videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 256_000, warnings: [] };

describe("isMainMessage", () => {
  it("accepts the four main → host shapes", () => {
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY })).toBe(true);
    expect(isMainMessage({ type: "record", sessionId: "a" })).toBe(true);
    expect(isMainMessage({ type: "stop", sessionId: "a" })).toBe(true);
    expect(isMainMessage({ type: "ping" })).toBe(true);
  });
  it("rejects anything else", () => {
    expect(isMainMessage({ type: "start" })).toBe(false);
    expect(isMainMessage({ type: "start", sessionId: "a" })).toBe(false);
    expect(isMainMessage({ type: "start", sessionId: "a", quality: { ...DEFAULT_QUALITY, frameRate: 24 } })).toBe(false);
    expect(isMainMessage({ type: "start", sessionId: "", quality: DEFAULT_QUALITY })).toBe(false);
    expect(isMainMessage({ type: "pong" })).toBe(false);
    expect(isMainMessage({ type: "record" })).toBe(false);
    expect(isMainMessage({ type: "record", sessionId: "" })).toBe(false);
    expect(isMainMessage(null)).toBe(false);
    expect(isMainMessage("start")).toBe(false);
  });
});

describe("isHostMessage", () => {
  it("accepts every host → main shape", () => {
    expect(isHostMessage({ type: "ready" })).toBe(true);
    expect(isHostMessage({ type: "pong" })).toBe(true);
    expect(isHostMessage({ type: "prepared", sessionId: "a", mimeType: "video/mp4", capture })).toBe(true);
    // `started` may drop its report: main keeps the one from `prepared`.
    expect(isHostMessage({ type: "started", sessionId: "a" })).toBe(true);
    expect(isHostMessage({ type: "started", sessionId: "a", mimeType: "video/mp4", capture })).toBe(true);
    expect(
      isHostMessage({
        type: "started",
        sessionId: "a",
        mimeType: "video/mp4",
        capture: { ...capture, width: 1920, height: 1080, frameRate: 30, sampleRate: 48_000, channelCount: 2, warnings: ["w"] },
      }),
    ).toBe(true);
    expect(isHostMessage({ type: "chunk", sessionId: "a", seq: 0, bytes: new ArrayBuffer(1) })).toBe(true);
    expect(isHostMessage({ type: "stopped", sessionId: "a" })).toBe(true);
    expect(isHostMessage({ type: "error", code: "no_audio_track", detail: "" })).toBe(true);
    expect(isHostMessage({ type: "error", sessionId: "a", code: "mp4_unsupported", detail: "x" })).toBe(true);
  });
  it("accepts optional stop diagnostics but rejects invalid timestamps", () => {
    expect(isHostMessage({ type: "stopped", sessionId: "a", tracksStoppedAt: 123 })).toBe(true);
    for (const tracksStoppedAt of [NaN, Infinity, "123", null]) {
      expect(isHostMessage({ type: "stopped", sessionId: "a", tracksStoppedAt })).toBe(false);
    }
  });
  it("rejects malformed chunks and unknown error codes", () => {
    expect(isHostMessage({ type: "chunk", sessionId: "a", seq: -1, bytes: new ArrayBuffer(1) })).toBe(false);
    expect(isHostMessage({ type: "chunk", sessionId: "a", seq: 1.5, bytes: new ArrayBuffer(1) })).toBe(false);
    expect(isHostMessage({ type: "chunk", sessionId: "a", seq: 0, bytes: new Uint8Array(1) })).toBe(false);
    expect(isHostMessage({ type: "error", code: "made_up", detail: "" })).toBe(false);
    // Only launch-time evidence reports a terminated app; a live host never can.
    expect(isHostMessage({ type: "error", code: "app_terminated", detail: "" })).toBe(false);
    expect(isHostMessage({ type: "error", sessionId: "", code: "no_display", detail: "" })).toBe(false);
    expect(isHostMessage({ type: "prepared", sessionId: "a" })).toBe(false);
    expect(isHostMessage({ type: "prepared", sessionId: "a", mimeType: "video/mp4" })).toBe(false);
    expect(isHostMessage({ type: "prepared", sessionId: "", mimeType: "video/mp4", capture })).toBe(false);
    expect(isHostMessage({ type: "prepared", sessionId: "a", mimeType: "video/mp4", capture: { ...capture, width: "1920" } })).toBe(false);
    expect(isHostMessage({ type: "prepared", sessionId: "a", mimeType: "video/mp4", capture: { ...capture, videoBitsPerSecond: NaN } })).toBe(false);
    expect(isHostMessage({ type: "prepared", sessionId: "a", mimeType: "video/mp4", capture: { ...capture, warnings: [1] } })).toBe(false);
    expect(isHostMessage({ type: "started", sessionId: "" })).toBe(false);
    expect(isHostMessage({ type: "started", sessionId: "a", mimeType: 1 })).toBe(false);
    expect(isHostMessage({ type: "started", sessionId: "a", capture: { ...capture, warnings: [1] } })).toBe(false);
    expect(isHostMessage({ type: "nope" })).toBe(false);
  });
});

it("validates optional structured display track failure", () => {
  const message = { type: "error", sessionId: "s1", code: "capture_failed", detail: "ended" };
  expect(isHostMessage({ ...message, displayFailure: "track_ended" })).toBe(true);
  expect(isHostMessage({ ...message, displayFailure: true })).toBe(false);
  expect(isHostMessage({ ...message, displayFailure: "audio" })).toBe(false);
});
