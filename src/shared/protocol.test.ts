import { describe, expect, it } from "vitest";
import { isHostMessage, isMainMessage } from "./protocol";

describe("isMainMessage", () => {
  it("accepts the three main → host shapes", () => {
    expect(isMainMessage({ type: "start", sessionId: "a" })).toBe(true);
    expect(isMainMessage({ type: "stop", sessionId: "a" })).toBe(true);
    expect(isMainMessage({ type: "ping" })).toBe(true);
  });
  it("rejects anything else", () => {
    expect(isMainMessage({ type: "start" })).toBe(false);
    expect(isMainMessage({ type: "start", sessionId: "" })).toBe(false);
    expect(isMainMessage({ type: "pong" })).toBe(false);
    expect(isMainMessage(null)).toBe(false);
    expect(isMainMessage("start")).toBe(false);
  });
});

describe("isHostMessage", () => {
  it("accepts every host → main shape", () => {
    expect(isHostMessage({ type: "ready" })).toBe(true);
    expect(isHostMessage({ type: "pong" })).toBe(true);
    expect(isHostMessage({ type: "started", sessionId: "a", mimeType: "video/mp4" })).toBe(true);
    expect(isHostMessage({ type: "chunk", sessionId: "a", seq: 0, bytes: new ArrayBuffer(1) })).toBe(true);
    expect(isHostMessage({ type: "stopped", sessionId: "a" })).toBe(true);
    expect(isHostMessage({ type: "error", code: "no_audio_track", detail: "" })).toBe(true);
    expect(isHostMessage({ type: "error", sessionId: "a", code: "mp4_unsupported", detail: "x" })).toBe(true);
  });
  it("rejects malformed chunks and unknown error codes", () => {
    expect(isHostMessage({ type: "chunk", sessionId: "a", seq: -1, bytes: new ArrayBuffer(1) })).toBe(false);
    expect(isHostMessage({ type: "chunk", sessionId: "a", seq: 1.5, bytes: new ArrayBuffer(1) })).toBe(false);
    expect(isHostMessage({ type: "chunk", sessionId: "a", seq: 0, bytes: new Uint8Array(1) })).toBe(false);
    expect(isHostMessage({ type: "error", code: "made_up", detail: "" })).toBe(false);
    expect(isHostMessage({ type: "error", sessionId: "", code: "no_display", detail: "" })).toBe(false);
    expect(isHostMessage({ type: "started", sessionId: "a" })).toBe(false);
    expect(isHostMessage({ type: "nope" })).toBe(false);
  });
});
