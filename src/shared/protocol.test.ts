import { describe, expect, it } from "vitest";
import { isHostMessage, isMainMessage } from "./protocol";
import { DEFAULT_QUALITY } from "./quality";
import { MAX_GAIN_DB, volumeDb } from "./audio-volume";

const capture = { videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 256_000, warnings: [] };

describe("isMainMessage", () => {
  it("accepts the four main → host shapes", () => {
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY })).toBe(true);
    expect(isMainMessage({ type: "record", sessionId: "a" })).toBe(true);
    expect(isMainMessage({ type: "stop", sessionId: "a" })).toBe(true);
    expect(isMainMessage({ type: "ping" })).toBe(true);
  });
  it("accepts the native engine's start options and refuses malformed ones (plan 076)", () => {
    const native = { displayId: 1, recordingPath: "/out/a.recording.mp4", ownPids: [1, 2], systemUi: { menuBar: false, dock: false, desktop: false } };
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native })).toBe(true);
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, displayId: 1.5 } })).toBe(false);
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, recordingPath: "" } })).toBe(false);
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, ownPids: ["1"] } })).toBe(false);
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, systemUi: true } })).toBe(false);
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, systemUi: { menuBar: true, dock: 1, desktop: false } } })).toBe(false);
    const { systemUi: _, ...withoutSystemUi } = native;
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: withoutSystemUi })).toBe(false);
    // Plan 099: the part of the display to record, in its pixels.
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, crop: { x: 0, y: 74, width: 3024, height: 1890 } } })).toBe(true);
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, crop: { x: 0, y: -1, width: 3024, height: 1890 } } })).toBe(false);
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, crop: { x: 0, y: 74, width: 0, height: 1890 } } })).toBe(false);
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, crop: { x: 0, y: 74.5, width: 3024, height: 1890 } } })).toBe(false);
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, editable: true } })).toBe(true);
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, editable: "yes" } })).toBe(false);
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, displayPoint: { x: -960, y: 540 } } })).toBe(true);
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, displayPoint: { x: 0.5, y: 0 } } })).toBe(false);
    expect(isMainMessage({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, displayPoint: [0, 0] } })).toBe(false);
  });
  it("carries the camera choice and refuses one out of range (plan 075)", () => {
    const native = { displayId: 1, recordingPath: "/out/a.recording.mp4", ownPids: [1], systemUi: { menuBar: false, dock: false, desktop: false } };
    const camera = { width: 0.2, height: 0.2, rounding: 1, x: 0.97, y: 0.95, mirror: false };
    const start = (value: unknown) => ({ type: "start", sessionId: "a", quality: DEFAULT_QUALITY, native: { ...native, camera: value } });
    expect(isMainMessage(start(camera))).toBe(true);
    expect(isMainMessage(start({ ...camera, deviceId: "47B4B64B" }))).toBe(true);
    for (const bad of [{ ...camera, deviceId: "" }, { ...camera, x: 1.5 }, { ...camera, width: Number.NaN }, { ...camera, mirror: "no" }, null, []]) {
      expect(isMainMessage(start(bad)), JSON.stringify(bad)).toBe(false);
    }
  });
  it("asks for the cameras and carries their list (plan 075)", () => {
    expect(isMainMessage({ type: "listCameras" })).toBe(true);
    expect(isMainMessage({ type: "cameraPreview", sessionId: "s1", watching: true })).toBe(true);
    expect(isMainMessage({ type: "levels", sessionId: "s1", watching: false })).toBe(true);
    expect(isMainMessage({ type: "mute", sessionId: "s1", system: true, microphone: false })).toBe(true);
    expect(isMainMessage({ type: "mute", sessionId: "s1", system: true })).toBe(false);
    // In dB, from silence to 600%'s, the volume's percent made into dB (audio-volume.ts): not only whole dB.
    expect(isMainMessage({ type: "gain", sessionId: "s1", system: -60, microphone: MAX_GAIN_DB })).toBe(true);
    expect(isMainMessage({ type: "gain", sessionId: "s1", system: volumeDb(250), microphone: volumeDb(5) })).toBe(true);
    for (const system of [16, -61, Number.NaN, "0"]) expect(isMainMessage({ type: "gain", sessionId: "s1", system, microphone: 0 }), String(system)).toBe(false);
    // Levels go to the Studio's page on its port (plan 081), not to main.
    expect(isHostMessage({ type: "levels", sessionId: "s1", system: 0.5, microphone: 0 })).toBe(false);
    expect(isMainMessage({ type: "cameraPreview", sessionId: "s1", watching: "yes" })).toBe(false);
    expect(isMainMessage({ type: "cameraPreview", sessionId: "", watching: false })).toBe(false);
    expect(isHostMessage({ type: "cameras", devices: [{ id: "iphone", name: "iPhone Camera", default: false }] })).toBe(true);
    expect(isHostMessage({ type: "cameras", error: "a recording is in progress" })).toBe(true);
    expect(isHostMessage({ type: "cameras", devices: [{ id: "", name: "x", default: false }] })).toBe(false);
  });
  it("carries a built-in input's closed lid (plan 089, D2)", () => {
    const device = { id: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", default: false };
    expect(isHostMessage({ type: "microphones", devices: [{ ...device, lidClosed: true }] })).toBe(true);
    expect(isHostMessage({ type: "microphones", devices: [device] })).toBe(true);
    expect(isHostMessage({ type: "microphones", devices: [{ ...device, lidClosed: "yes" }] })).toBe(false);
  });
  it("asks the engine about the screen grant and carries its answer (plan 089, D1)", () => {
    expect(isMainMessage({ type: "checkScreenAccess", displayId: 3 })).toBe(true);
    for (const displayId of [1.5, -1, "3", undefined]) expect(isMainMessage({ type: "checkScreenAccess", displayId }), String(displayId)).toBe(false);
    for (const answer of ["granted", "denied", "unknown"]) expect(isHostMessage({ type: "screenAccess", answer })).toBe(true);
    expect(isHostMessage({ type: "screenAccess", answer: "denied", detail: "The user declined TCCs (-3801)" })).toBe(true);
    expect(isHostMessage({ type: "screenAccess", answer: "maybe" })).toBe(false);
    expect(isHostMessage({ type: "screenAccess", answer: "denied", detail: 3801 })).toBe(false);
  });
  it("switches the microphone while recording and runs Settings' meter and device watch (plan 079)", () => {
    expect(isMainMessage({ type: "microphone", sessionId: "s1", deviceId: "BuiltInMicrophoneDevice" })).toBe(true);
    expect(isMainMessage({ type: "microphone", sessionId: "s1" })).toBe(true);
    expect(isMainMessage({ type: "microphone", sessionId: "s1", deviceId: "" })).toBe(false);
    expect(isMainMessage({ type: "microphone", sessionId: "" })).toBe(false);
    expect(isMainMessage({ type: "watchDevices", watching: true })).toBe(true);
    expect(isMainMessage({ type: "watchDevices" })).toBe(false);
    expect(isMainMessage({ type: "meter", watching: true, deviceId: "usb" })).toBe(true);
    expect(isMainMessage({ type: "meter", watching: false })).toBe(true);
    expect(isMainMessage({ type: "meter", watching: "yes" })).toBe(false);
    expect(isHostMessage({ type: "microphoneSwitched", sessionId: "s1", from: "MacBook Pro Microphone", to: "FreeClip 2" })).toBe(true);
    expect(isHostMessage({ type: "microphoneSwitched", sessionId: "s1", from: "a" })).toBe(false);
    expect(isHostMessage({ type: "microphoneSwitchFailed", sessionId: "s1", detail: "microphone: usb is not connected" })).toBe(true);
    expect(isHostMessage({ type: "microphoneSwitchFailed", sessionId: "", detail: "x" })).toBe(false);
    expect(isHostMessage({ type: "meterStarted", device: "MacBook Pro Microphone" })).toBe(true);
    expect(isHostMessage({ type: "meterLevel", peak: 0.5, rms: 0.35 })).toBe(true);
    for (const bad of [-1, Number.NaN, 17, "0.1"]) expect(isHostMessage({ type: "meterLevel", peak: bad, rms: 0 }), String(bad)).toBe(false);
    expect(isHostMessage({ type: "meterStopped", error: "microphone: access is not allowed" })).toBe(true);
    expect(isHostMessage({ type: "meterStopped" })).toBe(false);
  });
  it("carries the camera's changes for a session (plan 075)", () => {
    const camera = { width: 0.2, height: 0.2, rounding: 1, x: 0.97, y: 0.95, mirror: false };
    expect(isMainMessage({ type: "cameraLayout", sessionId: "a", camera, hidden: false })).toBe(true);
    expect(isMainMessage({ type: "cameraLayout", sessionId: "", camera, hidden: false })).toBe(false);
    expect(isMainMessage({ type: "cameraLayout", sessionId: "a", camera: { ...camera, y: 2 }, hidden: false })).toBe(false);
    expect(isMainMessage({ type: "cameraLayout", sessionId: "a", camera, hidden: "yes" })).toBe(false);
  });
  it("carries the microphone choice and the request for the inputs (plan 074)", () => {
    const native = { displayId: 1, recordingPath: "/out/a.recording.mp4", ownPids: [1], systemUi: { menuBar: false, dock: false, desktop: false } };
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
    for (const type of ["cameraLost", "cameraReady", "cameraNotReady", "cameraResumed"]) {
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
