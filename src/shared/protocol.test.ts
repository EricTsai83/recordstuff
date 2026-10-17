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
  it("accepts the native engine's start options and refuses malformed ones (plan 076)", () => {
    const native = { displayId: 1, recordingPath: "/out/a.recording.mp4", ownPids: [1, 2], hideSystemUi: false };
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native })).toBe(true);
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, displayId: 1.5 } })).toBe(false);
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, recordingPath: "" } })).toBe(false);
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, ownPids: ["1"] } })).toBe(false);
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, hideSystemUi: 1 } })).toBe(false);
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, displayPoint: { x: -960, y: 540 } } })).toBe(true);
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, displayPoint: { x: 0.5, y: 0 } } })).toBe(false);
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, displayPoint: [0, 0] } })).toBe(false);
  });
  it("carries the camera choice and refuses one out of range (plan 075)", () => {
    const native = { displayId: 1, recordingPath: "/out/a.recording.mp4", ownPids: [1], hideSystemUi: false };
    const camera = { width: 0.2, height: 0.2, rounding: 1, x: 0.97, y: 0.95, mirror: false };
    const start = (value: unknown) => ({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, camera: value } });
    expect(isMainMessage(start(camera))).toBe(true);
    expect(isMainMessage(start({ ...camera, deviceId: "47B4B64B" }))).toBe(true);
    for (const bad of [{ ...camera, deviceId: "" }, { ...camera, x: 1.5 }, { ...camera, width: Number.NaN }, { ...camera, mirror: "no" }, null, []]) {
      expect(isMainMessage(start(bad)), JSON.stringify(bad)).toBe(false);
    }
  });
  it("carries the microphone choice and the request for the inputs (plan 074)", () => {
    const native = { displayId: 1, recordingPath: "/out/a.recording.mp4", ownPids: [1], hideSystemUi: false };
    const start = (microphone: unknown) => ({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, microphone } });
    expect(isMainMessage(start({ enabled: false }))).toBe(true);
    expect(isMainMessage(start({ enabled: true }))).toBe(true);
    expect(isMainMessage(start({ enabled: true, deviceId: "BuiltInMicrophoneDevice" }))).toBe(true);
    expect(isMainMessage(start({ enabled: "yes" }))).toBe(false);
    expect(isMainMessage(start({ enabled: true, deviceId: "" }))).toBe(false);
    expect(isMainMessage(start(true))).toBe(false);
    expect(isMainMessage({ type: "listMicrophones" })).toBe(true);
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
  it("accepts the microphone's refusal, its loss and the listed inputs, and refuses malformed ones (plan 074)", () => {
    expect(isHostMessage({ type: "error", sessionId: "a", code: "microphone_unavailable", detail: "microphone: there is no audio input" })).toBe(true);
    expect(isHostMessage({ type: "error", sessionId: "a", code: "camera_unavailable", detail: "camera: no camera is connected" })).toBe(true);
    for (const type of ["cameraLost", "cameraResumed"]) {
      expect(isHostMessage({ type, sessionId: "a", detail: "the camera delivered no frame for 2 s" })).toBe(true);
      expect(isHostMessage({ type, sessionId: "", detail: "x" })).toBe(false);
    }
    expect(isHostMessage({ type: "microphoneLost", sessionId: "a", detail: "the microphone delivered no sound for 2 s" })).toBe(true);
    expect(isHostMessage({ type: "microphoneLost", sessionId: "", detail: "x" })).toBe(false);
    expect(isHostMessage({ type: "microphoneLost", sessionId: "a" })).toBe(false);
    expect(isHostMessage({ type: "microphoneResumed", sessionId: "a", detail: "the microphone delivered sound again after 2.4 s" })).toBe(true);
    expect(isHostMessage({ type: "microphoneResumed", sessionId: "a" })).toBe(false);
    expect(isHostMessage({ type: "microphones", devices: [{ id: "mic", name: "MacBook Pro Microphone", default: true }] })).toBe(true);
    expect(isHostMessage({ type: "microphones", devices: [] })).toBe(true);
    expect(isHostMessage({ type: "microphones", error: "AVFoundation has no audio media type" })).toBe(true);
    expect(isHostMessage({ type: "microphones", devices: [{ id: "", name: "x", default: false }] })).toBe(false);
    expect(isHostMessage({ type: "microphones", devices: [{ id: "mic", name: "x" }] })).toBe(false);
    expect(isHostMessage({ type: "microphones" })).toBe(false);
  });
  it("accepts the native engine's progress, write errors and file report, and refuses malformed ones (plan 076)", () => {
    expect(isHostMessage({ type: "progress", sessionId: "a", bytes: 0 })).toBe(true);
    expect(isHostMessage({ type: "progress", sessionId: "a", bytes: -1 })).toBe(false);
    expect(isHostMessage({ type: "progress", sessionId: "a", bytes: Number.NaN })).toBe(false);
    expect(isHostMessage({ type: "writeError", sessionId: "a", code: "disk_full", detail: "x" })).toBe(true);
    // A host may report only the write failures the engine can observe.
    expect(isHostMessage({ type: "writeError", sessionId: "a", code: "stop_timeout", detail: "x" })).toBe(false);
    expect(isHostMessage({ type: "finished", sessionId: "a", file: { bytes: 1, finalizeMs: 2, fragmented: "why" } })).toBe(true);
    expect(isHostMessage({ type: "finished", sessionId: "a", file: { bytes: 1 } })).toBe(false);
    expect(isHostMessage({ type: "finished", sessionId: "a" })).toBe(false);
  });
  it("accepts every host → main shape", () => {
    expect(isHostMessage({ type: "ready" })).toBe(true);
    expect(isHostMessage({ type: "pong" })).toBe(true);
    expect(isHostMessage({ type: "prepared", sessionId: "a", mimeType: "video/mp4", capture })).toBe(true);
    // The report travels in `prepared`; main keeps it for `started`.
    expect(isHostMessage({ type: "started", sessionId: "a" })).toBe(true);
    expect(
      isHostMessage({
        type: "prepared",
        sessionId: "a",
        mimeType: "video/mp4",
        capture: { ...capture, width: 1920, height: 1080, frameRate: 30, sampleRate: 48_000, channelCount: 2, warnings: ["w"] },
      }),
    ).toBe(true);
    expect(isHostMessage({ type: "stopped", sessionId: "a" })).toBe(true);
    expect(isHostMessage({ type: "error", sessionId: "a", code: "no_audio_track", detail: "" })).toBe(true);
    expect(isHostMessage({ type: "error", sessionId: "a", code: "media_components_missing", detail: "x" })).toBe(true);
    expect(isHostMessage({ type: "error", sessionId: "a", code: "mp4_unsupported", detail: "x" })).toBe(false);
  });
  it("accepts optional stop diagnostics but rejects invalid timestamps", () => {
    expect(isHostMessage({ type: "stopped", sessionId: "a", tracksStoppedAt: 123 })).toBe(true);
    for (const tracksStoppedAt of [NaN, Infinity, "123", null]) {
      expect(isHostMessage({ type: "stopped", sessionId: "a", tracksStoppedAt })).toBe(false);
    }
  });
  it("rejects the removed capture page's chunks and unknown error codes", () => {
    // Media never passes through main since plan 076: the engine writes the file and reports progress.
    expect(isHostMessage({ type: "chunk", sessionId: "a", seq: 0, bytes: new ArrayBuffer(1) })).toBe(false);
    expect(isHostMessage({ type: "error", sessionId: "a", code: "made_up", detail: "" })).toBe(false);
    // Only main can find a folder, disk, deadline, supervision or launch-time failure; a live host never can.
    for (const code of ["app_terminated", "disk_full", "output_open_failed", "output_write_failed", "stop_timeout",
      "capture_host_crashed", "capture_host_unresponsive", "unsupported_os_version", "display_unavailable"]) {
      expect(isHostMessage({ type: "error", sessionId: "a", code, detail: "" }), code).toBe(false);
    }
    // Every host failure names its session: none may fail whichever session main happens to hold.
    expect(isHostMessage({ type: "error", code: "capture_failed", detail: "" })).toBe(false);
    expect(isHostMessage({ type: "error", sessionId: "", code: "no_display", detail: "" })).toBe(false);
    expect(isHostMessage({ type: "prepared", sessionId: "a" })).toBe(false);
    expect(isHostMessage({ type: "prepared", sessionId: "a", mimeType: "video/mp4" })).toBe(false);
    expect(isHostMessage({ type: "prepared", sessionId: "", mimeType: "video/mp4", capture })).toBe(false);
    expect(isHostMessage({ type: "prepared", sessionId: "a", mimeType: "video/mp4", capture: { ...capture, width: "1920" } })).toBe(false);
    expect(isHostMessage({ type: "prepared", sessionId: "a", mimeType: "video/mp4", capture: { ...capture, videoBitsPerSecond: NaN } })).toBe(false);
    expect(isHostMessage({ type: "prepared", sessionId: "a", mimeType: "video/mp4", capture: { ...capture, warnings: [1] } })).toBe(false);
    expect(isHostMessage({ type: "started", sessionId: "" })).toBe(false);
    expect(isHostMessage({ type: "nope" })).toBe(false);
  });
});

it("validates optional structured display track failure", () => {
  const message = { type: "error", sessionId: "s1", code: "capture_failed", detail: "ended" };
  expect(isHostMessage({ ...message, displayFailure: "track_ended" })).toBe(true);
  expect(isHostMessage({ ...message, displayFailure: true })).toBe(false);
  expect(isHostMessage({ ...message, displayFailure: "audio" })).toBe(false);
});
