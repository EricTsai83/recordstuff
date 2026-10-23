import type { AudioVolume } from "../../shared/audio-volume";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileWriteError, NO_MEDIA_DETAIL, nodeFs } from "./file-writer";
import { EngineFileWriter } from "./engine-file-writer";
import { SavedNotification, SAVED_NOTIFICATION_DELAY_MS } from "./saved-notification";
import { RECORDING_HEALTH } from "./recording-health";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostStartError, type EngineFileReport, type HostMessage } from "../../shared/protocol";
import { DEFAULT_QUALITY, type CaptureReport, type QualitySettings } from "../../shared/quality";
import type { RecordingState } from "../../shared/state";
import { DEFAULT_CAMERA_LAYOUT } from "../../shared/camera-layout";
import type { RecordingFailure } from "../../shared/recording-result";
import { Recorder, formatTimestamp, type CountdownPresentation, type CountdownPresenter, type RecorderDeps, type RecorderEvent, type RecorderHost, type RecorderWriter, type SessionCamera, type SessionCapture } from "./recorder";
import { COUNTDOWN_TIMING } from "../../shared/countdown";
import { SessionSentinels, type SessionSentinel } from "./session-sentinel";

class FakeHost implements RecorderHost {
  started: string[] = [];
  /** Sessions `record` was sent for. */
  recorded: string[] = [];
  /** Answer `record` with `started` at once, as a healthy host does. */
  autoStart = true;
  recordError: Error | undefined;
  /** Quality snapshot each `start` was called with. */
  startedWith: QualitySettings[] = [];
  stopped: string[] = [];
  startError: Error | undefined;
  private messageListener: ((m: HostMessage) => void) | undefined;
  private failureListener:
    | ((code: "capture_host_crashed" | "capture_host_unresponsive", detail: string) => void)
    | undefined;

  /** The temporary file each `start` named, for the native engine (plan 076). */
  recordingPaths: (string | undefined)[] = [];
  /** What else each `start` was asked to capture (plan 074). */
  capturedWith: (SessionCapture | undefined)[] = [];
  async start(sessionId: string, quality: QualitySettings, recordingPath?: string, capture?: SessionCapture): Promise<void> {
    if (this.startError) throw this.startError;
    this.started.push(sessionId);
    this.startedWith.push(quality);
    this.recordingPaths.push(recordingPath);
    this.capturedWith.push(capture);
  }
  record(sessionId: string): void {
    if (this.recordError) throw this.recordError;
    this.recorded.push(sessionId);
    if (this.autoStart) this.emit({ type: "started", sessionId });
  }
  stop(sessionId: string): void {
    this.stopped.push(sessionId);
  }
  /** Each camera change sent (plan 075). */
  cameraChanges: { sessionId: string; camera: SessionCamera; hidden: boolean }[] = [];
  setCamera(sessionId: string, camera: SessionCamera, hidden: boolean): void {
    this.cameraChanges.push({ sessionId, camera, hidden });
  }
  mutes: [string, boolean, boolean][] = [];
  setMuted(sessionId: string, system: boolean, microphone: boolean): void {
    this.mutes.push([sessionId, system, microphone]);
  }
  gains: [string, AudioVolume][] = [];
  setGains(sessionId: string, gain: AudioVolume): void {
    this.gains.push([sessionId, gain]);
  }
  /** Each microphone switch sent (plan 079, D3); `accepts` false is a host that does not run the session. */
  switches: [string, string | undefined][] = [];
  accepts = true;
  setMicrophone(sessionId: string, deviceId: string | undefined): boolean {
    if (this.accepts) this.switches.push([sessionId, deviceId]);
    return this.accepts;
  }
  onMessage(listener: (m: HostMessage) => void): void {
    this.messageListener = listener;
  }
  onFailure(listener: (code: "capture_host_crashed" | "capture_host_unresponsive", detail: string) => void): void {
    this.failureListener = listener;
  }
  /** Where the engine writes: called for each `progress` with bytes, as the engine wrote to the session's file. */
  onWrite: ((sessionId: string, bytes: number) => void) | undefined;
  emit(message: HostMessage): void {
    if (message.type === "progress" && message.bytes > 0) this.onWrite?.(message.sessionId, message.bytes);
    this.messageListener?.(message);
  }
  crash(): void {
    this.failureListener?.("capture_host_crashed", "killed");
  }
  hang(): void {
    this.failureListener?.("capture_host_unresponsive", "no pong");
  }
}

class FakeWriter implements RecorderWriter {
  preservationUncertain = false;
  /** The engine's cumulative byte counts written to this file, one per `progress`. */
  written: number[] = [];
  finished = false;
  abandoned = false;
  finishError: Error | undefined;
  constructor(
    readonly recordingPath: string,
    public finalPath: string,
  ) {}
  retarget(finalPath: string): void {
    this.finalPath = finalPath;
  }
  async finish(): Promise<string> {
    if (this.finishError) throw this.finishError;
    this.finished = true;
    return this.finalPath;
  }
  async abandon(): Promise<string | undefined> {
    this.abandoned = true;
    return this.written.length > 0 ? this.recordingPath : undefined;
  }
}

/** Terminal events name their session (plan 029); most assertions here are about the outcome itself. */
const traced = (id = "s1") => expect.objectContaining({ id });

/** The engine's `seq`th progress report: `size` more bytes written. */
function chunk(sessionId: string, seq: number, size = 4): HostMessage {
  return { type: "progress", sessionId, bytes: (seq + 1) * size };
}

const CAPTURE: CaptureReport = {
  width: 1920,
  height: 1080,
  frameRate: 30,
  sampleRate: 48_000,
  channelCount: 2,
  videoBitsPerSecond: 8_100_000,
  audioBitsPerSecond: 256_000,
  warnings: [],
};

/** Capture is ready; with no countdown the recorder sends `record` at once and the fake host starts. */
function prepared(sessionId: string, capture: CaptureReport = CAPTURE): HostMessage {
  return { type: "prepared", sessionId, mimeType: "video/mp4", capture };
}

function setup(
  overrides: {
    ensureWritableDir?: () => Promise<void>;
    openWriter?: (recordingPath: string, finalPath: string) => Promise<FakeWriter>;
    quality?: () => QualitySettings;
    log?: (message: string) => void;
    captureRequestTimeoutMs?: number | "default";
    deps?: Partial<RecorderDeps>;
  } = {},
) {
  const host = new FakeHost();
  const writers: FakeWriter[] = [];
  host.onWrite = (sessionId, bytes) => {
    if (sessionId === host.started.at(-1)) writers.at(-1)?.written.push(bytes);
  };
  const events: RecorderEvent[] = [];
  const states: RecordingState[] = [];
  const recorder = new Recorder({
    host,
    outputDir: () => "/out",
    quality: overrides.quality ?? (() => DEFAULT_QUALITY),
    ...(overrides.log ? { log: overrides.log } : {}),
    ensureWritableDir: overrides.ensureWritableDir ?? (async () => undefined),
    openWriter:
      overrides.openWriter ??
      (async (recordingPath, finalPath) => {
        const writer = new FakeWriter(recordingPath, finalPath);
        writers.push(writer);
        return writer;
      }),
    now: () => new Date(2026, 8, 11, 14, 30, 0),
    newSessionId: () => "s1",
    startTimeoutMs: 8000,
    ...(overrides.captureRequestTimeoutMs === "default" ? {} : { captureRequestTimeoutMs: overrides.captureRequestTimeoutMs ?? 8000 }),
    stopTimeoutMs: 10_000,
    ...overrides.deps,
  });
  recorder.subscribe((event) => {
    events.push(event);
    if (event.type === "state") states.push(event.state);
  });
  return { recorder, host, writers, events, states };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

async function startRecording(ctx: ReturnType<typeof setup>): Promise<void> {
  ctx.recorder.toggle();
  await flush();
  ctx.host.emit(prepared("s1"));
  ctx.host.emit(chunk("s1", 0));
  await flush();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Live preview (plan 075, D20)", () => {
  it("prepares the recording's session and holds it, the state idle, nothing recorded", async () => {
    const ctx = setup({ deps: { camera: () => ({ layout: DEFAULT_CAMERA_LAYOUT }) } });
    expect(ctx.recorder.startPreview()).toBe(true);
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(ctx.recorder.preview).toEqual({ sessionId: "s1", live: false });
    expect(ctx.host.started).toEqual(["s1"]);
    ctx.host.emit(prepared("s1"));
    await flush();
    expect(ctx.recorder.preview).toEqual({ sessionId: "s1", live: true });
    expect(ctx.recorder.previewSessionId, "the Studio shows its picture").toBe("s1");
    expect(ctx.recorder.camera, "its camera changes as a recording's").toEqual({ hidden: false });
    expect(ctx.host.recorded).toEqual([]);
    expect(ctx.states).toEqual([]);
    expect(ctx.events.filter((e) => e.type === "preview")).toHaveLength(2);
    expect(ctx.recorder.startPreview(), "one at a time").toBe(false);
  });

  it("is taken by Start into the countdown and the recording, named when Start came, with no new session", async () => {
    let now = new Date(2026, 8, 11, 14, 30, 0);
    const ctx = setup({ deps: { now: () => now, countdownSeconds: () => 3 } });
    ctx.recorder.startPreview();
    await flush();
    ctx.host.emit(prepared("s1"));
    await flush();
    now = new Date(2026, 8, 11, 14, 35, 12);
    expect(ctx.recorder.startIfIdle()).toBe(true);
    await flush();
    expect(ctx.recorder.preview).toBeUndefined();
    expect(ctx.recorder.state).toEqual({ type: "countdown", remaining: 3 });
    expect(ctx.host.started, "the same session").toEqual(["s1"]);
    expect(ctx.writers[0]!.finalPath).toBe(path.join("/out", "2026-09-11 14-35-12.mp4"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(ctx.host.recorded).toEqual(["s1"]);
    expect(ctx.recorder.state.type).toBe("recording");
  });

  it("taken while it still prepares, records once prepared; let go of, is cancelled and leaves nothing", async () => {
    const ctx = setup();
    ctx.recorder.startPreview();
    await flush();
    ctx.recorder.toggle();
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "starting" });
    ctx.host.emit(prepared("s1"));
    await flush();
    expect(ctx.host.recorded).toEqual(["s1"]);
    const other = setup();
    other.recorder.startPreview();
    await flush();
    other.host.emit(prepared("s1"));
    await flush();
    other.recorder.stopPreview();
    await flush();
    expect(other.recorder.preview).toBeUndefined();
    expect(other.host.stopped).toEqual(["s1"]);
    expect(other.writers[0]!.abandoned).toBe(true);
    expect(other.events).toContainEqual(expect.objectContaining({ type: "cancelled", reason: "preview" }));
    expect(other.events.some((e) => e.type === "failed" || e.type === "failureStatus")).toBe(false);
  });

  it("that fails is no recording's failure: the Studio is told why, nothing is reported", async () => {
    const ctx = setup();
    ctx.recorder.startPreview();
    await flush();
    ctx.host.emit({ type: "error", sessionId: "s1", code: "camera_unavailable", detail: "no camera is connected" });
    await flush();
    expect(ctx.recorder.preview).toBeUndefined();
    expect(ctx.events).toContainEqual({ type: "preview", failure: { code: "camera_unavailable", detail: "no camera is connected" } });
    expect(ctx.events.some((e) => e.type === "failed" || e.type === "failureStatus")).toBe(false);
    expect(ctx.recorder.state).toEqual({ type: "idle" });
  });

  it("taken while it prepares, is a recording: preview teardown leaves it, and its name and time are Start's alone", async () => {
    let now = new Date(2026, 8, 11, 9, 0, 0);
    const ctx = setup({ deps: { now: () => now } });
    ctx.recorder.startPreview();
    await flush();
    ctx.recorder.toggle();
    await flush();
    expect(ctx.recorder.preview, "no longer a preview").toBeUndefined();
    ctx.recorder.stopPreview();
    expect(ctx.recorder.state).toEqual({ type: "starting" });
    now = new Date(2026, 8, 11, 9, 0, 10);
    ctx.host.emit(prepared("s1"));
    await flush();
    expect(ctx.writers[0]!.finalPath).toBe(path.join("/out", "2026-09-11 09-00-00.mp4"));
    expect(ctx.host.recorded).toEqual(["s1"]);
  });

  it("leaves no interruption evidence until Start takes it, and takes the bubble as it is once prepared", async () => {
    const written: string[] = [];
    let width = 0.2;
    const ctx = setup({ deps: { sentinels: { write: async (entry) => { written.push(entry.sessionId); }, remove: async () => undefined },
      camera: () => ({ layout: { ...DEFAULT_CAMERA_LAYOUT, width } }) } });
    ctx.recorder.startPreview();
    await flush();
    expect(written, "a preview is no recording").toEqual([]);
    width = 0.3;
    expect(ctx.recorder.updateCamera({ layout: { ...DEFAULT_CAMERA_LAYOUT, width } }), "no live session yet to change").toBe(false);
    ctx.host.emit(prepared("s1"));
    await flush();
    expect(ctx.host.cameraChanges.map((change) => change.camera.layout.width), "changed while preparing: sent once prepared").toEqual([0.3]);
    ctx.recorder.startIfIdle();
    await flush();
    expect(written).toEqual(["s1"]);
  });

  it("taken while its file still opens, takes Start's name and the recording's evidence once it is open", async () => {
    let now = new Date(2026, 8, 11, 9, 0, 0);
    const written: string[] = [];
    let open!: () => void;
    const ctx = setup({ deps: { now: () => now, sentinels: { write: async (entry) => { written.push(entry.recordingPath ?? ""); }, remove: async () => undefined } },
      openWriter: async (recordingPath, finalPath) => { await new Promise<void>((resolve) => { open = resolve; }); const writer = new FakeWriter(recordingPath, finalPath); ctx.writers.push(writer); return writer; } });
    ctx.recorder.startPreview();
    await flush();
    now = new Date(2026, 8, 11, 9, 5, 0);
    ctx.recorder.startIfIdle();
    open();
    await flush();
    expect(ctx.writers[0]!.finalPath).toBe(path.join("/out", "2026-09-11 09-05-00.mp4"));
    expect(written).toEqual([path.join("/out", "2026-09-11 09-00-00.recording.mp4")]);
  });

  it("is let go of when screen recording's permission goes", async () => {
    const ctx = setup();
    ctx.recorder.startPreview();
    await flush();
    ctx.host.emit(prepared("s1"));
    await flush();
    ctx.recorder.setPermission({ granted: false, needsRelaunch: false });
    expect(ctx.recorder.preview).toBeUndefined();
    expect(ctx.host.stopped).toEqual(["s1"]);
  });

  it("is let go of by sleep and by quit", async () => {
    const ctx = setup();
    ctx.recorder.startPreview();
    await flush();
    ctx.host.emit(prepared("s1"));
    await flush();
    ctx.recorder.systemWillSleep();
    await flush();
    expect(ctx.recorder.preview).toBeUndefined();
    const quitting = setup();
    quitting.recorder.startPreview();
    await flush();
    quitting.host.emit(prepared("s1"));
    await flush();
    await expect(quitting.recorder.shutdown()).resolves.toBe(true);
    expect(quitting.recorder.preview).toBeUndefined();
  });
});

describe("formatTimestamp", () => {
  it("uses the local time with dashes only", () => {
    expect(formatTimestamp(new Date(2026, 8, 11, 14, 30, 5))).toBe("2026-09-11 14-30-05");
  });
  it("names the session by the file name the owner chose, from the time it was requested (2026-10-05)", async () => {
    const fileName = vi.fn((date: Date) => `Demo ${formatTimestamp(date)}`);
    const ctx = setup({ deps: { fileName } });
    await startRecording(ctx);
    expect(fileName).toHaveBeenCalledWith(new Date(2026, 8, 11, 14, 30, 0));
    expect([ctx.writers[0]!.recordingPath, ctx.writers[0]!.finalPath])
      .toEqual([path.join("/out", "Demo 2026-09-11 14-30-00.recording.mp4"), path.join("/out", "Demo 2026-09-11 14-30-00.mp4")]);
  });
});

describe("the camera (plan 075)", () => {
  const layout = { width: 0.2, height: 0.2, rounding: 1, mirror: false, positions: [] };

  it("snapshots the camera when the session begins and passes it to the host with the microphone", async () => {
    let camera: { deviceId?: string; layout: typeof layout } | undefined = { deviceId: "cam", layout };
    const ctx = setup({ deps: { microphone: () => ({ enabled: true }), camera: () => camera } });
    ctx.recorder.toggle();
    camera = undefined;
    await flush();
    ctx.host.emit(prepared("s1"));
    await flush();
    expect(ctx.host.capturedWith).toEqual([{ microphone: { enabled: true }, camera: { deviceId: "cam", layout } }]);
  });

  it("passes no camera without the dependency or when it answers none", async () => {
    for (const camera of [undefined, () => undefined]) {
      const ctx = setup({ deps: camera ? { camera } : {} });
      await startRecording(ctx);
      expect(ctx.host.capturedWith).toEqual([undefined]);
    }
  });

  it("refuses with camera_unavailable before any countdown", async () => {
    const ctx = setup({ deps: { camera: () => ({ layout }) } });
    ctx.recorder.toggle();
    await flush();
    ctx.host.emit({ type: "error", sessionId: "s1", code: "camera_unavailable", detail: "camera: no camera is connected" });
    await flush();
    expect(ctx.events).toContainEqual(expect.objectContaining({ type: "failed", code: "camera_unavailable", outcome: "empty" }));
    expect(ctx.host.recorded).toEqual([]);
    expect(ctx.recorder.state).toEqual({ type: "idle" });
  });

  it("changes the recording's camera from its next frame on: a new layout, hidden and shown, logged", async () => {
    const logs: string[] = [];
    const ctx = setup({ log: (line) => logs.push(line), deps: { camera: () => ({ layout }) } });
    await startRecording(ctx);
    expect(ctx.recorder.camera).toEqual({ hidden: false });
    const moved = { ...layout, width: 0.3 };
    expect(ctx.recorder.updateCamera({ layout: moved })).toBe(true);
    expect(ctx.recorder.updateCamera({ hidden: true })).toBe(true);
    expect(ctx.recorder.camera).toEqual({ hidden: true });
    expect(ctx.host.cameraChanges).toEqual([
      { sessionId: "s1", camera: { layout: moved }, hidden: false },
      { sessionId: "s1", camera: { layout: moved }, hidden: true }]);
    expect(logs).toContainEqual(expect.stringContaining("session s1 camera hidden"));
    ctx.recorder.stop();
    expect(ctx.recorder.updateCamera({ hidden: false }), "not while stopping").toBe(false);
    expect(ctx.recorder.camera, "nor offered to Settings or the tray then").toBeUndefined();
  });

  it("takes no camera change before the engine's session is prepared, and offers none there", async () => {
    const ctx = setup({ deps: { camera: () => ({ layout }) } });
    ctx.recorder.toggle();
    await flush();
    expect(ctx.recorder.updateCamera({ hidden: true }), "preparing").toBe(false);
    // Settings' shape rows and the tray's Hide camera follow `camera`: a change they took here would be lost.
    expect(ctx.recorder.camera).toBeUndefined();
    expect(ctx.host.cameraChanges).toEqual([]);
  });

  it("offers the camera from the state that redraws Settings: not while arming without a countdown, then once recording", async () => {
    const ctx = setup({ deps: { camera: () => ({ layout }) } });
    ctx.host.autoStart = false;
    ctx.recorder.toggle();
    await flush();
    ctx.host.emit(prepared("s1"));
    await flush();
    expect(ctx.recorder.state.type, "arming keeps starting").toBe("starting");
    expect(ctx.recorder.camera).toBeUndefined();
    expect(ctx.recorder.updateCamera({ hidden: true })).toBe(false);
    ctx.host.emit({ type: "started", sessionId: "s1" });
    ctx.host.emit(chunk("s1", 0));
    await flush();
    expect(ctx.recorder.state.type).toBe("recording");
    expect(ctx.recorder.camera).toEqual({ hidden: false });
    expect(ctx.recorder.cameraSessionId, "the session Settings' preview joins").toBe("s1");
  });

  it("sends the saved volumes once the session is prepared, and again on each change until it stops (D21)", async () => {
    let gain: AudioVolume = { system: 100, microphone: 50 };
    const ctx = setup({ deps: { audioVolume: () => gain } });
    expect(ctx.recorder.updateGains(), "no session").toBe(false);
    ctx.recorder.toggle();
    await flush();
    gain = { system: 140, microphone: 50 };
    expect(ctx.recorder.updateGains(), "preparing: taken once prepared").toBe(false);
    expect(ctx.host.gains).toEqual([]);
    ctx.host.emit(prepared("s1"));
    await flush();
    expect(ctx.host.gains, "before any sound is taken").toEqual([["s1", { system: 140, microphone: 50 }]]);
    ctx.host.emit({ type: "started", sessionId: "s1" });
    await flush();
    gain = { system: 0, microphone: 600 };
    expect(ctx.recorder.updateGains()).toBe(true);
    expect(ctx.host.gains.at(-1)).toEqual(["s1", { system: 0, microphone: 600 }]);
    ctx.recorder.stop();
    expect(ctx.recorder.updateGains(), "not while stopping").toBe(false);
  });

  it("mutes the recording's inputs for that recording, from the countdown or start until it stops (D19)", async () => {
    const logs: string[] = [];
    const ctx = setup({ log: (line) => logs.push(line), deps: { microphone: () => ({ enabled: true }) } });
    expect(ctx.recorder.audio).toBeUndefined();
    expect(ctx.recorder.updateAudio({ system: true })).toBe(false);
    await startRecording(ctx);
    expect(ctx.recorder.audio).toEqual({ sessionId: "s1", systemMuted: false, microphone: { muted: false } });
    expect(ctx.recorder.updateAudio({ microphone: true })).toBe(true);
    expect(ctx.recorder.updateAudio({ system: true })).toBe(true);
    expect(ctx.recorder.audio).toEqual({ sessionId: "s1", systemMuted: true, microphone: { muted: true } });
    expect(ctx.host.mutes).toEqual([["s1", false, true], ["s1", true, true]]);
    expect(logs).toContainEqual(expect.stringContaining("session s1 system audio muted, microphone muted"));
    ctx.recorder.stop();
    expect(ctx.recorder.audio, "not while stopping").toBeUndefined();
  });

  it("has no camera to change without one, or between recordings", async () => {
    const ctx = setup({});
    expect(ctx.recorder.updateCamera({ hidden: true })).toBe(false);
    await startRecording(ctx);
    expect(ctx.recorder.camera).toBeUndefined();
    expect(ctx.recorder.updateCamera({ hidden: true })).toBe(false);
    expect(ctx.host.cameraChanges).toEqual([]);
  });

  it("keeps recording when the camera is lost, logs each dropout and its return, tells it once and marks the saved recording", async () => {
    const logs: string[] = [];
    const ctx = setup({ log: (line) => logs.push(line), deps: { camera: () => ({ layout }) } });
    await startRecording(ctx);
    ctx.host.emit({ type: "cameraLost", sessionId: "s1", detail: "the camera delivered no frame for 2 s" });
    ctx.host.emit({ type: "cameraResumed", sessionId: "s1", detail: "the camera delivered frames again after 3.1 s" });
    ctx.host.emit({ type: "cameraLost", sessionId: "s1", detail: "again" });
    ctx.host.emit({ type: "cameraLost", sessionId: "other", detail: "another session's" });
    expect(ctx.events.filter((event) => event.type === "cameraLost")).toEqual([
      { type: "cameraLost", sessionId: "s1", detail: "the camera delivered no frame for 2 s" }]);
    expect(ctx.recorder.state.type).toBe("recording");
    expect(logs.filter((line) => line.includes("camera lost; recording continues without it"))).toHaveLength(2);
    expect(logs).toContainEqual(expect.stringContaining("camera resumed: the camera delivered frames again after 3.1 s"));
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    const saved = ctx.events.find((event) => event.type === "saved");
    expect(saved).toMatchObject({ cameraLost: true });
    expect(saved).not.toHaveProperty("microphoneLost");
    expect(saved).not.toHaveProperty("cameraNotReady");
  });

  it("keeps recording when the camera is not ready, tells it once apart from a loss and marks the saved recording (plan 090)", async () => {
    const logs: string[] = [];
    const ctx = setup({ log: (line) => logs.push(line), deps: { camera: () => ({ layout }) } });
    await startRecording(ctx);
    ctx.host.emit({ type: "cameraNotReady", sessionId: "s1", detail: "the camera delivered no frame in the 10 s after it was opened" });
    ctx.host.emit({ type: "cameraNotReady", sessionId: "s1", detail: "again" });
    ctx.host.emit({ type: "cameraNotReady", sessionId: "other", detail: "another session's" });
    ctx.host.emit({ type: "cameraResumed", sessionId: "s1", detail: "the camera delivered its first frame 12.0 s after it was opened" });
    expect(ctx.events.filter((event) => event.type === "cameraNotReady")).toEqual([
      { type: "cameraNotReady", sessionId: "s1", detail: "the camera delivered no frame in the 10 s after it was opened" }]);
    expect(ctx.events.some((event) => event.type === "cameraLost")).toBe(false);
    expect(ctx.recorder.state.type).toBe("recording");
    expect(logs).toContainEqual(expect.stringContaining("camera not ready; recording continues without it"));
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    const saved = ctx.events.find((event) => event.type === "saved");
    expect(saved).toMatchObject({ cameraNotReady: true });
    expect(saved).not.toHaveProperty("cameraLost");
  });
});

describe("the microphone (plan 074)", () => {
  it("passes nothing to the host and logs mic off without the dependency or with the switch off", async () => {
    for (const microphone of [undefined, () => ({ enabled: false, deviceId: "usb" })]) {
      const logs: string[] = [];
      const ctx = setup({ log: (line) => logs.push(line), deps: microphone ? { microphone } : {} });
      await startRecording(ctx);
      expect(ctx.host.capturedWith).toEqual([undefined]);
      expect(logs).toContainEqual(expect.stringMatching(/prepared after \d+ ms; countdown 0 s; sound off; mime video\/mp4; mic off$/));
    }
  });

  it("snapshots the choice when the session begins, passes it without its label and names the device in the log", async () => {
    const logs: string[] = [];
    let choice = { enabled: true, deviceId: "usb", label: "USB Microphone" };
    const ctx = setup({ log: (line) => logs.push(line), deps: { microphone: () => choice } });
    ctx.recorder.toggle();
    choice = { enabled: false, deviceId: "other", label: "Other" };
    await flush();
    ctx.host.emit(prepared("s1"));
    await flush();
    expect(ctx.host.capturedWith).toEqual([{ microphone: { enabled: true, deviceId: "usb" } }]);
    expect(logs).toContainEqual(expect.stringContaining("; mic on (USB Microphone)"));
  });

  it("names the device the engine opened, which is the default input when the chosen one was not connected", async () => {
    const logs: string[] = [];
    const ctx = setup({ log: (line) => logs.push(line), deps: { microphone: () => ({ enabled: true, deviceId: "usb", label: "USB Microphone" }) } });
    ctx.recorder.toggle();
    await flush();
    ctx.host.emit(prepared("s1", { ...CAPTURE, microphone: "MacBook Pro Microphone" }));
    await flush();
    expect(logs).toContainEqual(expect.stringContaining("; mic on (MacBook Pro Microphone)"));
  });

  it("refuses with microphone_unavailable before any countdown", async () => {
    const ctx = setup({ deps: { microphone: () => ({ enabled: true }) } });
    ctx.recorder.toggle();
    await flush();
    ctx.host.emit({ type: "error", sessionId: "s1", code: "microphone_unavailable", detail: "microphone: there is no audio input" });
    await flush();
    expect(ctx.events).toContainEqual(expect.objectContaining({ type: "failed", code: "microphone_unavailable", outcome: "empty" }));
    expect(ctx.host.recorded).toEqual([]);
    expect(ctx.recorder.state).toEqual({ type: "idle" });
  });

  it("keeps recording when the microphone is lost, logs each dropout and its return, tells it once and marks the saved recording", async () => {
    const logs: string[] = [];
    const ctx = setup({ log: (line) => logs.push(line), deps: { microphone: () => ({ enabled: true }) } });
    await startRecording(ctx);
    ctx.host.emit({ type: "microphoneLost", sessionId: "s1", detail: "the microphone delivered no sound for 2 s" });
    ctx.host.emit({ type: "microphoneResumed", sessionId: "s1", detail: "the microphone delivered sound again after 2.4 s" });
    ctx.host.emit({ type: "microphoneLost", sessionId: "s1", detail: "again" });
    ctx.host.emit({ type: "microphoneLost", sessionId: "other", detail: "another session's" });
    ctx.host.emit({ type: "microphoneResumed", sessionId: "other", detail: "another session's" });
    expect(ctx.events.filter((event) => event.type === "microphoneLost")).toEqual([
      { type: "microphoneLost", sessionId: "s1", detail: "the microphone delivered no sound for 2 s" }]);
    expect(ctx.recorder.state.type).toBe("recording");
    expect(logs.filter((line) => line.includes("microphone lost; recording continues without it"))).toHaveLength(2);
    expect(logs.filter((line) => line.includes("microphone resumed"))).toEqual([
      expect.stringContaining("microphone resumed: the microphone delivered sound again after 2.4 s")]);
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(ctx.events.find((event) => event.type === "saved")).toMatchObject({ microphoneLost: true });
  });

  it("saves a recording whose microphone stayed without the mark, and ignores a loss before recording", async () => {
    const ctx = setup({ deps: { microphone: () => ({ enabled: true }) } });
    ctx.recorder.toggle();
    await flush();
    ctx.host.emit({ type: "microphoneLost", sessionId: "s1", detail: "while preparing" });
    ctx.host.emit(prepared("s1"));
    ctx.host.emit(chunk("s1", 0));
    await flush();
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(ctx.events.some((event) => event.type === "microphoneLost")).toBe(false);
    expect(ctx.events.find((event) => event.type === "saved")).not.toHaveProperty("microphoneLost");
  });
});

describe("switching the microphone while recording (plan 079, D3)", () => {
  it("sends the chosen input to the recording only, then logs the switch and names both devices in the saved recording", async () => {
    const logs: string[] = [];
    let choice: { enabled: boolean; deviceId?: string; label?: string } = { enabled: true };
    const ctx = setup({ log: (line) => logs.push(line), deps: { microphone: () => choice } });
    expect(ctx.recorder.updateMicrophone(), "no session").toBe(false);
    ctx.recorder.toggle();
    await flush();
    choice = { enabled: true, deviceId: "usb", label: "USB Microphone" };
    expect(ctx.recorder.updateMicrophone(), "preparing: it opens the device chosen when it began").toBe(false);
    ctx.host.emit(prepared("s1", { ...CAPTURE, microphone: "MacBook Pro Microphone" }));
    ctx.host.emit(chunk("s1", 0));
    await flush();
    expect(ctx.recorder.updateMicrophone()).toBe(true);
    // The same choice again is no switch, until it is answered.
    expect(ctx.recorder.updateMicrophone()).toBe(false);
    expect(ctx.host.switches).toEqual([["s1", "usb"]]);
    ctx.host.emit({ type: "microphoneSwitched", sessionId: "s1", from: "MacBook Pro Microphone", to: "USB Microphone" });
    ctx.host.emit({ type: "microphoneSwitched", sessionId: "other", from: "x", to: "y" });
    expect(logs).toContainEqual(expect.stringContaining("microphone switched from MacBook Pro Microphone to USB Microphone"));
    // Back to the system default: a switch too.
    choice = { enabled: true };
    expect(ctx.recorder.updateMicrophone()).toBe(true);
    ctx.host.emit({ type: "microphoneSwitchFailed", sessionId: "s1", detail: "microphone: there is no default input; USB Microphone goes on being recorded" });
    expect(logs).toContainEqual(expect.stringContaining("microphone not switched: microphone: there is no default input"));
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(ctx.events.find((event) => event.type === "saved")).toMatchObject({ microphones: ["MacBook Pro Microphone", "USB Microphone"] });
  });

  it("sends one switch at a time, so an answer is never taken for a later choice, and takes answers from the countdown on", async () => {
    const logs: string[] = [];
    let choice: { enabled: boolean; deviceId?: string; label?: string } = { enabled: true };
    const ctx = setup({ log: (line) => logs.push(line), deps: { microphone: () => choice, countdownSeconds: () => 3 } });
    ctx.recorder.toggle();
    await flush();
    ctx.host.emit(prepared("s1", { ...CAPTURE, microphone: "MacBook Pro Microphone" }));
    await flush();
    expect(ctx.recorder.state.type).toBe("countdown");
    choice = { enabled: true, deviceId: "b", label: "B" };
    expect(ctx.recorder.updateMicrophone()).toBe(true);
    // C while B opens waits for B's answer, and D replaces it.
    choice = { enabled: true, deviceId: "c", label: "C" };
    expect(ctx.recorder.updateMicrophone()).toBe(true);
    choice = { enabled: true, deviceId: "d", label: "D" };
    expect(ctx.recorder.updateMicrophone()).toBe(true);
    expect(ctx.host.switches).toEqual([["s1", "b"]]);
    // Answered during the countdown: taken, and D sent.
    ctx.host.emit({ type: "microphoneSwitched", sessionId: "s1", from: "MacBook Pro Microphone", to: "B" });
    expect(ctx.host.switches).toEqual([["s1", "b"], ["s1", "d"]]);
    ctx.host.emit({ type: "microphoneSwitchFailed", sessionId: "s1", detail: "microphone: d is not connected; B goes on being recorded" });
    // D failed: B is recorded, so choosing D again is a switch, and B is none.
    expect(ctx.recorder.updateMicrophone()).toBe(true);
    expect(ctx.host.switches.at(-1)).toEqual(["s1", "d"]);
    ctx.host.emit({ type: "microphoneSwitchFailed", sessionId: "s1", detail: "again" });
    choice = { enabled: true, deviceId: "b", label: "B" };
    expect(ctx.recorder.updateMicrophone()).toBe(false);
    // An answer nothing asked for is ignored.
    ctx.host.emit({ type: "microphoneSwitched", sessionId: "s1", from: "B", to: "E" });
    expect(logs.filter((line) => line.includes("microphone switched from"))).toHaveLength(1);
    // System default when B is the default: the same device, answered as kept, which lets the next choice go.
    choice = { enabled: true };
    expect(ctx.recorder.updateMicrophone()).toBe(true);
    choice = { enabled: true, deviceId: "f", label: "F" };
    expect(ctx.recorder.updateMicrophone()).toBe(true);
    ctx.host.emit({ type: "microphoneSwitched", sessionId: "s1", from: "B", to: "B" });
    expect(logs).toContainEqual(expect.stringContaining("microphone B kept: it is the one chosen"));
    expect(ctx.host.switches.slice(-2)).toEqual([["s1", undefined], ["s1", "f"]]);
    ctx.host.emit({ type: "microphoneSwitched", sessionId: "s1", from: "B", to: "F" });
    expect(logs).toContainEqual(expect.stringContaining("microphone switched from B to F"));
  });

  it("leaves a recording without the microphone alone, and saves one never switched without the list", async () => {
    const ctx = setup({ deps: { microphone: () => ({ enabled: true, deviceId: "usb" }) } });
    await startRecording(ctx);
    expect(ctx.recorder.updateMicrophone(), "the device it records").toBe(false);
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(ctx.events.find((event) => event.type === "saved")).not.toHaveProperty("microphones");
    let enabled = false;
    const off = setup({ deps: { microphone: () => ({ enabled, deviceId: "usb" }) } });
    await startRecording(off);
    enabled = true;
    expect(off.recorder.updateMicrophone()).toBe(false);
    expect(off.host.switches).toEqual([]);
  });
});

describe("native engine messages (plan 076)", () => {
  /** Recording through a host that writes the file itself: `started`, then `progress` instead of chunks. */
  async function startNative(ctx: ReturnType<typeof setup>): Promise<void> {
    ctx.recorder.toggle();
    await flush();
    ctx.host.emit(prepared("s1"));
    await flush();
  }

  it("tells the host which file the writer opened", async () => {
    const ctx = setup();
    await startNative(ctx);
    expect(ctx.host.recordingPaths).toEqual([path.join("/out", "2026-09-11 14-30-00.recording.mp4")]);
  });

  it("counts progress with bytes as the first media and logs it as the first chunk the runners time to", async () => {
    const logs: string[] = [];
    const ctx = setup({ log: (message) => logs.push(message) });
    await startNative(ctx);
    ctx.host.emit({ type: "progress", sessionId: "s1", bytes: 0 });
    await vi.advanceTimersByTimeAsync(7000);
    expect(ctx.recorder.state.type).toBe("recording");
    ctx.host.emit({ type: "progress", sessionId: "s1", bytes: 4096 });
    await vi.advanceTimersByTimeAsync(5000);
    // Past the 8 s first-media deadline, which the progress cleared.
    expect(ctx.recorder.state.type).toBe("recording");
    expect(logs).toContain("recorder: session s1 first chunk 4096 bytes (engine progress)");
  });

  it("fails the start when the engine reports no media before the deadline", async () => {
    const ctx = setup();
    await startNative(ctx);
    ctx.host.emit({ type: "progress", sessionId: "s1", bytes: 0 });
    await vi.advanceTimersByTimeAsync(8000);
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "capture_start_failed" });
  });

  it("fails as a stall when progress stops while the host still answers", async () => {
    const ctx = setup({ deps: { health: { stallWarnMs: 3000, stallFailMs: 6000 } } });
    await startNative(ctx);
    for (let second = 1; second <= 5; second++) {
      ctx.host.emit({ type: "progress", sessionId: "s1", bytes: second * 1000 });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(ctx.recorder.state.type).toBe("recording");
    await vi.advanceTimersByTimeAsync(6000);
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "capture_failed", detail: expect.stringContaining("stalled") });
  });

  it("fails with the engine's write error and keeps what it wrote", async () => {
    const ctx = setup();
    await startNative(ctx);
    ctx.host.emit({ type: "progress", sessionId: "s1", bytes: 4096 });
    ctx.host.emit({ type: "writeError", sessionId: "s1", code: "disk_full", detail: "write failed: No space left on device" });
    await flush();
    expect(ctx.host.stopped).toEqual(["s1"]);
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "disk_full", outcome: "partial",
      partialPath: path.join("/out", "2026-09-11 14-30-00.recording.mp4") });
  });

  it("ignores progress and write errors of another session", async () => {
    const ctx = setup();
    await startNative(ctx);
    ctx.host.emit({ type: "progress", sessionId: "s1", bytes: 10 });
    ctx.host.emit({ type: "writeError", sessionId: "other", code: "output_write_failed", detail: "x" });
    ctx.host.emit({ type: "progress", sessionId: "other", bytes: 10 });
    await flush();
    expect(ctx.recorder.state.type).toBe("recording");
  });
});

describe("Recorder happy path", () => {
  it("finalizes the file and returns idle before a delayed notification can fail", async () => {
    const ctx = setup();
    const show = vi.fn(() => { throw new Error("notification unavailable"); });
    const log = vi.fn();
    const notification = new SavedNotification({ platform: "darwin", show, log });
    ctx.recorder.subscribe((event) => {
      if (event.type === "state") notification.stateChanged(event.state);
      if (event.type === "saved") notification.schedule(event.path);
    });
    await startRecording(ctx);
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1", tracksStoppedAt: Date.now() });
    await flush();
    expect(ctx.writers[0]!.finished).toBe(true);
    expect(ctx.recorder.state.type).toBe("idle");
    expect(ctx.events.at(-1)?.type).toBe("saved");
    expect(show).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVED_NOTIFICATION_DELAY_MS);
    expect(show).toHaveBeenCalledTimes(1);
    expect(ctx.recorder.state.type).toBe("idle");
    expect(ctx.events.filter((event) => event.type === "failed")).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("saved request failed"));
  });

  it("logs where the wait between stop and saved went", async () => {
    let clock = 0;
    const log = vi.fn();
    const ctx = setup({ log, deps: { monotonic: () => clock } });
    await startRecording(ctx);
    Object.assign(ctx.writers[0]!, { bytesWritten: 4, finishTimings: { flushMs: 4.4, finalizeMs: 2.6, closeMs: 0.2, publishMs: 0.6, cleanupMs: 1, method: "link" } });
    clock = 1000;
    ctx.recorder.stop();
    clock = 1012;
    ctx.host.emit({ type: "stopped", sessionId: "s1", tracksStoppedAt: Date.now() });
    await flush();
    expect(log).toHaveBeenCalledWith("recorder: session s1 finalize timing: host 12 ms, writes 0 ms, flush 4 ms, finalize 3 ms to plain MP4, close 0 ms, publish 1 ms by link, cleanup 1 ms, checkpoint ? ms; 4 bytes");
  });

  it("says when the file stayed fragmented and when the temporary name was kept beside the saved file", async () => {
    const log = vi.fn();
    const ctx = setup({ log });
    await startRecording(ctx);
    Object.assign(ctx.writers[0]!, { bytesWritten: 4, finishTimings: { flushMs: 1, finalizeMs: 0, fragmented: "track 2 has an edit list", closeMs: 0, publishMs: 9, cleanupMs: 0, method: "copy", linkError: "ENOTSUP", cleanupError: "EPERM" } });
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    const line = log.mock.calls.map(([message]) => String(message)).find(message => message.includes("finalize timing"));
    expect(line).toContain("finalize 0 ms kept fragmented (track 2 has an edit list), close 0 ms");
    expect(line).toContain("by copy (link ENOTSUP), cleanup 0 ms (temporary name kept: EPERM), checkpoint ? ms; 4 bytes");
  });

  it("idle → starting → recording → stopping → idle", async () => {
    const ctx = setup();
    await startRecording(ctx);
    expect(ctx.host.started).toEqual(["s1"]);
    expect(ctx.recorder.state).toEqual({ type: "recording", startedAt: expect.any(String) });

    ctx.host.emit(chunk("s1", 1));
    ctx.recorder.toggle();
    expect(ctx.recorder.state).toEqual({ type: "stopping" });
    expect(ctx.host.stopped).toEqual(["s1"]);
    ctx.host.emit(chunk("s1", 2));
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();

    const writer = ctx.writers[0]!;
    expect(writer.written).toHaveLength(3);
    expect(writer.finished).toBe(true);
    expect(writer.recordingPath).toBe(path.join("/out", "2026-09-11 14-30-00.recording.mp4"));
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(ctx.events.at(-1)).toEqual({ type: "saved", path: path.join("/out", "2026-09-11 14-30-00.mp4"), session: {
      id: "s1", recordingPath: path.join("/out", "2026-09-11 14-30-00.recording.mp4"),
      recordingAt: new Date(2026, 8, 11, 14, 30, 0).toISOString(), stoppingAt: new Date(2026, 8, 11, 14, 30, 0).toISOString(),
    } });
    expect(ctx.states.map((s) => s.type)).toEqual(["starting", "recording", "stopping", "idle"]);
  });

  it("checks the output dir before opening the file", async () => {
    const order: string[] = [];
    const ctx = setup({
      ensureWritableDir: async () => {
        order.push("ensure");
      },
      openWriter: async () => {
        order.push("open");
        return new FakeWriter(path.join("/out", "a.recording.mp4"), path.join("/out", "a.mp4"));
      },
    });
    ctx.recorder.toggle();
    await flush();
    expect(order).toEqual(["ensure", "open"]);
  });
});

describe("a toggle during a long start (plan 065)", () => {
  function timed(overrides: Parameters<typeof setup>[0] = {}) {
    const clock = { now: 0 };
    const logs: string[] = [];
    const ctx = setup({ ...overrides, log: (message) => logs.push(message), deps: { ...overrides.deps, monotonic: () => clock.now } });
    return { ...ctx, clock, logs };
  }
  const outcomes = (ctx: ReturnType<typeof setup>, from = 0) =>
    ctx.events.slice(from).filter((event) => event.type === "failed" || event.type === "failureStatus" || event.type === "saved" || event.type === "cancelled");

  it("ignores and logs a press within the grace, including one 8 ms after the start (plan 063's case)", async () => {
    const ctx = timed({ deps: { countdownSeconds: () => 3 } });
    ctx.recorder.toggle();
    await flush();
    for (const at of [8, 999]) {
      ctx.clock.now = at;
      ctx.recorder.toggle();
      expect(ctx.recorder.state.type).toBe("starting");
      expect(ctx.logs).toContain(`recorder: session s1 toggle ignored while starting (${at} ms after the start)`);
    }
    expect(ctx.host.started).toEqual(["s1"]);
    expect(ctx.host.stopped).toEqual([]);
    ctx.host.emit(prepared("s1"));
    expect(ctx.recorder.state).toEqual({ type: "countdown", remaining: 3 });
  });

  it("after the grace, cancels an attempt preparing capture as Cancel recording does, returning to idle", async () => {
    const ctx = timed({ deps: { countdownSeconds: () => 3 } });
    ctx.recorder.toggle();
    await flush();
    ctx.host.emit(prepared("s1"));
    await vi.advanceTimersByTimeAsync(3000);
    ctx.host.emit(chunk("s1", 0));
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "idle" });

    ctx.clock.now = 10_000;
    ctx.recorder.toggle();
    await flush();
    const before = ctx.events.length;
    ctx.clock.now = 11_000;
    ctx.recorder.toggle();
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(ctx.host.stopped.at(-1)).toBe("s1");
    expect(ctx.writers[1]!.abandoned).toBe(true);
    expect(outcomes(ctx, before)).toEqual([{ type: "cancelled", reason: "toggle", session: traced() }]);
    expect(ctx.logs).toContain("recorder: session s1 cancelled (toggle) while preparing capture");
    // Its capture-request timer went with it, and a late prepared is a stale session's.
    ctx.host.emit(prepared("s1"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ctx.host.recorded).toEqual(["s1"]);
    expect(outcomes(ctx, before)).toHaveLength(1);
  });

  it("after the grace, cancels an attempt still opening the folder before any capture request or file", async () => {
    let open!: () => void;
    const ctx = timed({ ensureWritableDir: () => new Promise<void>((resolve) => { open = resolve; }) });
    ctx.recorder.toggle();
    await flush();
    ctx.clock.now = 1500;
    ctx.recorder.toggle();
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    open();
    await flush();
    expect(ctx.host.started).toEqual([]);
    expect(ctx.writers).toEqual([]);
    expect(outcomes(ctx)).toEqual([{ type: "cancelled", reason: "toggle", session: traced() }]);
  });

  it("with the countdown Off, a press after record becomes stop-on-start and the recording is saved", async () => {
    const ctx = timed();
    ctx.host.autoStart = false;
    ctx.recorder.toggle();
    await flush();
    ctx.host.emit(prepared("s1"));
    expect(ctx.host.recorded).toEqual(["s1"]);
    expect(ctx.recorder.state.type).toBe("starting");
    ctx.clock.now = 1200;
    ctx.recorder.toggle();
    expect(ctx.logs).toContain("recorder: session s1 cancel (toggle) arrived after record was sent; stopping once capture starts");
    ctx.host.emit({ type: "started", sessionId: "s1" });
    expect(ctx.recorder.state.type).toBe("stopping");
    ctx.host.emit(chunk("s1", 0));
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(outcomes(ctx).map((event) => event.type)).toEqual(["saved"]);
  });
});

describe("Recorder ignores illegal transitions", () => {
  it("ignores clicks while starting and stopping", async () => {
    // A fixed clock keeps the start inside the grace (plan 065) however slowly the test runs.
    const ctx = setup({ deps: { monotonic: () => 0 } });
    ctx.recorder.toggle();
    await flush();
    expect(ctx.recorder.state.type).toBe("starting");
    ctx.recorder.toggle();
    ctx.recorder.toggle();
    expect(ctx.recorder.state.type).toBe("starting");
    expect(ctx.host.started).toEqual(["s1"]);

    ctx.host.emit(prepared("s1"));
    ctx.host.emit(chunk("s1", 0));
    ctx.recorder.toggle();
    expect(ctx.recorder.state.type).toBe("stopping");
    ctx.recorder.toggle();
    expect(ctx.recorder.state.type).toBe("stopping");
    expect(ctx.host.stopped).toEqual(["s1"]);
  });

  it("logs a toggle ignored while stopping", async () => {
    let clock = 0;
    const logs: string[] = [];
    const ctx = setup({ log: (message) => logs.push(message), deps: { monotonic: () => clock } });
    await startRecording(ctx);
    clock = 100;
    ctx.recorder.toggle();
    clock = 340;
    ctx.recorder.toggle();
    expect(ctx.recorder.state.type).toBe("stopping");
    expect(ctx.host.stopped).toEqual(["s1"]);
    expect(logs).toContain("recorder: session s1 toggle ignored while stopping (240 ms after the stop)");
  });

  it("two rapid clicks in idle start exactly one session", async () => {
    const ctx = setup();
    ctx.recorder.toggle();
    ctx.recorder.toggle();
    await flush();
    expect(ctx.host.started).toEqual(["s1"]);
    expect(ctx.writers).toHaveLength(1);
  });

  it("ignores messages for a stale session", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.host.emit(chunk("other", 1));
    ctx.host.emit({ type: "stopped", sessionId: "other" });
    await flush();
    expect(ctx.recorder.state.type).toBe("recording");
    expect(ctx.writers[0]!.written).toHaveLength(1);
  });

  it("stop() outside recording is a no-op", () => {
    const ctx = setup();
    ctx.recorder.stop();
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(ctx.events).toEqual([]);
  });
});

describe("Recorder timeouts", () => {
  it("allows a user to answer OS prompts after 30 s, then bounds the first chunk separately", async () => {
    const ctx = setup({ captureRequestTimeoutMs: "default" });
    ctx.recorder.toggle();
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ctx.recorder.state.type).toBe("starting");
    ctx.host.emit(prepared("s1"));
    await vi.advanceTimersByTimeAsync(7999);
    expect(ctx.recorder.state.type).toBe("recording");
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.recorder.state.type).toBe("idle");
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "capture_start_failed" });
  });

  it("bounds unanswered OS prompts at two minutes and cancels the pending capture", async () => {
    const ctx = setup({ captureRequestTimeoutMs: "default" });
    ctx.recorder.toggle();
    await flush();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(ctx.recorder.state.type).toBe("starting");
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.recorder.state.type).toBe("idle");
    expect(ctx.host.stopped).toEqual(["s1"]);
    expect(ctx.writers[0]!.abandoned).toBe(true);
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", detail: expect.stringContaining("system permission prompts") });
  });

  it("fails with capture_start_failed when no chunk arrives within 8 s", async () => {
    const ctx = setup();
    ctx.recorder.toggle();
    await flush();
    ctx.host.emit(prepared("s1"));
    await vi.advanceTimersByTimeAsync(7999);
    expect(ctx.recorder.state.type).toBe("recording");
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "capture_start_failed" });
    expect(ctx.host.stopped).toEqual(["s1"]);
    expect(ctx.writers[0]!.abandoned).toBe(true);
  });

  it("the start timer is cleared once the first chunk arrives", async () => {
    const ctx = setup();
    await startRecording(ctx);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ctx.recorder.state.type).toBe("recording");
  });

  it("fails with stop_timeout and keeps the partial file when stopped never arrives", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.recorder.toggle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(ctx.events.at(-1)).toEqual({
      type: "failed",
      code: "stop_timeout",
      detail: expect.any(String),
      partialPath: path.join("/out", "2026-09-11 14-30-00.recording.mp4"),
      outcome: "partial",
      session: traced(),
    });
  });

  it("a stop request does not leave the start timer armed", async () => {
    const ctx = setup();
    ctx.recorder.toggle();
    await flush();
    ctx.host.emit(prepared("s1"));
    ctx.recorder.toggle(); // stop before the first chunk
    await vi.advanceTimersByTimeAsync(9000);
    expect(ctx.recorder.state.type).toBe("stopping");
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(ctx.recorder.state.type).toBe("idle");
  });
});

describe("Recorder failures", () => {
  it("output dir not writable → idle with outputDirUnavailable, no host start", async () => {
    const ctx = setup({
      ensureWritableDir: async () => {
        throw new Error("EACCES");
      },
    });
    ctx.recorder.toggle();
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "idle", outputDirUnavailable: true });
    // Failed before any file: the session is still named, with no temporary path or timing.
    expect(ctx.events.at(-1)).toEqual({ type: "failed", code: "output_open_failed", detail: "EACCES", outcome: "empty", session: { id: "s1" } });
    expect(ctx.host.started).toEqual([]);
    expect(ctx.host.stopped).toEqual([]);

    ctx.recorder.outputDirChanged();
    expect(ctx.recorder.state).toEqual({ type: "idle" });
  });

  it("a cancel while the folder is still being checked keeps it marked unavailable", async () => {
    let attempt = 0;
    const ctx = setup({
      ensureWritableDir: () => ++attempt === 1 ? Promise.reject(new Error("EACCES")) : new Promise(() => undefined),
    });
    ctx.recorder.toggle();
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "idle", outputDirUnavailable: true });
    ctx.recorder.toggle();
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "starting" });
    ctx.recorder.cancelCountdown("menu");
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "idle", outputDirUnavailable: true });
  });

  it("a capture host that throws on stop still lets the attempt settle, and the next one start", async () => {
    const logs: string[] = [];
    const ctx = setup({ log: (message) => logs.push(message) });
    ctx.host.stop = () => { throw new Error("port closed"); };
    ctx.recorder.toggle();
    await flush();
    ctx.recorder.cancelCountdown("menu");
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(logs).toContain("recorder: session s1 stop request failed: port closed");
    ctx.recorder.toggle();
    await flush();
    expect(ctx.host.started).toEqual(["s1", "s1"]);
  });

  it("a capture host that throws on a recording's stop still shows stopping, and the deadline keeps the file", async () => {
    const logs: string[] = [];
    const ctx = setup({ log: (message) => logs.push(message) });
    await startRecording(ctx);
    ctx.host.stop = () => { throw new Error("port closed"); };
    expect(() => ctx.recorder.toggle()).not.toThrow();
    expect(ctx.recorder.state).toEqual({ type: "stopping" });
    expect(logs).toContain("recorder: session s1 stop request failed: port closed");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "stop_timeout", partialPath: path.join("/out", "2026-09-11 14-30-00.recording.mp4") });
  });

  it("a cancel after the writer opened clears the unavailable folder", async () => {
    let attempt = 0;
    const ctx = setup({
      ensureWritableDir: async () => { if (++attempt === 1) throw new Error("EACCES"); },
    });
    ctx.recorder.toggle();
    await flush();
    ctx.recorder.toggle();
    await flush();
    ctx.recorder.cancelCountdown("menu");
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "idle" });
  });

  it("host.start rejection → capture_start_failed", async () => {
    const ctx = setup();
    ctx.host.startError = new Error("no renderer");
    ctx.recorder.toggle();
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(ctx.events.at(-1)).toEqual({ type: "failed", code: "capture_start_failed", detail: "no renderer", outcome: "empty",
      session: { id: "s1", recordingPath: path.join("/out", "2026-09-11 14-30-00.recording.mp4") } });
  });

  it("host.start rejection with a code of its own → failed with that code (plan 078)", async () => {
    const ctx = setup();
    ctx.host.startError = new HostStartError("media_components_missing", "mfplat.dll is missing");
    ctx.recorder.toggle();
    await flush();
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "media_components_missing", detail: "mfplat.dll is missing" });
  });

  it("refuses a start while Windows lacks its media components, starting no capture (plan 078)", async () => {
    const ctx = setup({ deps: { mediaComponentsMissing: true } });
    ctx.recorder.toggle();
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(ctx.host.started).toEqual([]);
  });

  it("host error message → failed with that code", async () => {
    const ctx = setup();
    ctx.recorder.toggle();
    await flush();
    ctx.host.emit({ type: "error", sessionId: "s1", code: "no_audio_track", detail: "none" });
    await flush();
    expect(ctx.events.at(-1)).toEqual({ type: "failed", code: "no_audio_track", detail: "none", outcome: "empty", session: traced() });
    expect(ctx.recorder.state).toEqual({ type: "idle" });
  });

  it("crash while recording keeps the partial file", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.host.crash();
    await flush();
    expect(ctx.events.at(-1)).toEqual({
      type: "failed",
      code: "capture_host_crashed",
      detail: "killed",
      partialPath: path.join("/out", "2026-09-11 14-30-00.recording.mp4"),
      outcome: "partial",
      session: traced(),
    });
    expect(ctx.writers[0]!.finished).toBe(false);
  });

  it("unresponsive host while recording fails", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.host.hang();
    await flush();
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "capture_host_unresponsive" });
  });

  it("host failure while idle is ignored", () => {
    const ctx = setup();
    ctx.host.crash();
    expect(ctx.events).toEqual([]);
  });

  it("unexpected stopped while recording → capture_failed", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "capture_failed" });
  });

  it("write error → disk_full from the engine's code", async () => {
    const ctx = setup();
    await startRecording(ctx);
    const writer = ctx.writers[0]!;
    ctx.host.emit({ type: "writeError", sessionId: "s1", code: "disk_full", detail: "ENOSPC" });
    await flush();
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "disk_full", partialPath: writer.recordingPath });
    expect(ctx.recorder.state).toEqual({ type: "idle" });
  });

  it("finish error → output_write_failed", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.writers[0]!.finishError = new Error("rename failed");
    ctx.recorder.toggle();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "output_write_failed" });
  });

  it("preflight blocker fails without touching anything", async () => {
    const host = new FakeHost();
    const events: RecorderEvent[] = [];
    const recorder = new Recorder({
      host,
      outputDir: () => "/out",
      quality: () => DEFAULT_QUALITY,
      ensureWritableDir: async () => undefined,
      openWriter: async () => new FakeWriter("a", "b"),
      preflight: () => "unsupported_os_version",
    });
    recorder.subscribe((e) => events.push(e));
    recorder.toggle();
    await flush();
    // No attempt, so no session is named or borrowed.
    expect(events.filter(event => event.type === "failed")).toEqual([{ type: "failed", code: "unsupported_os_version", detail: "", preflight: true }]);
    expect(recorder.state).toEqual({ type: "idle" });
  });
});

describe("Recorder review fixes", () => {
  it("stops a session it no longer owns when the host reports prepared or progress for it", async () => {
    const ctx = setup();
    ctx.recorder.toggle();
    await flush();
    // start timeout fires while the host is still preparing
    await vi.advanceTimersByTimeAsync(8000);
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    ctx.host.emit(prepared("s1"));
    ctx.host.emit(chunk("s1", 0));
    expect(ctx.host.stopped).toEqual(["s1", "s1", "s1"]);
    expect(ctx.recorder.state).toEqual({ type: "idle" });
  });

  it("the start deadline also covers a hung output-dir check", async () => {
    const ctx = setup({ ensureWritableDir: () => new Promise(() => undefined) });
    ctx.recorder.toggle();
    await vi.advanceTimersByTimeAsync(8000);
    expect(ctx.recorder.state).toEqual({ type: "idle", outputDirUnavailable: true });
    expect(ctx.events.at(-1)).toMatchObject({ type: "failureStatus", result: { code: "output_open_failed", outcome: "pending",
      detail: "opening /out did not finish within 8000 ms" } });
    expect(ctx.host.started).toEqual([]);
  });

  it("waits on a folder check that outlived its deadline instead of starting another, until it answers", async () => {
    const logs: string[] = [];
    const checks: Array<() => void> = [];
    const ensureWritableDir = vi.fn(() => new Promise<void>((resolve) => { checks.push(resolve); }));
    const ctx = setup({ ensureWritableDir, log: (message) => logs.push(message) });
    ctx.recorder.toggle();
    await vi.advanceTimersByTimeAsync(8000);
    // Retried while the volume still does not answer: no second check holds another file-system thread.
    ctx.recorder.toggle();
    await vi.advanceTimersByTimeAsync(8000);
    expect(ensureWritableDir).toHaveBeenCalledTimes(1);
    expect(logs).toContain("recorder: session s1 waits on the earlier check of /out, still unanswered");
    // Both attempts are reported at their deadline; their cleanup waits on the same check.
    expect(ctx.events.filter(event => event.type === "failureStatus" && event.result.outcome === "pending")
      .map(event => event.type === "failureStatus" && event.result.code)).toEqual(["output_open_failed", "output_open_failed"]);
    // Once it answers, the next attempt checks the folder afresh.
    checks[0]!();
    await flush();
    ctx.recorder.toggle();
    await flush();
    expect(ensureWritableDir).toHaveBeenCalledTimes(2);
  });

  it("keeps waiting on each hung folder's check while the user switches between folders", async () => {
    let folder = "/a";
    const ensureWritableDir = vi.fn((_dir: string) => new Promise<void>(() => undefined));
    const ctx = setup({ deps: { outputDir: () => folder, ensureWritableDir } });
    for (const next of ["/a", "/b", "/a", "/b"]) {
      folder = next;
      ctx.recorder.toggle();
      await vi.advanceTimersByTimeAsync(8000);
    }
    expect(ensureWritableDir.mock.calls.map(([dir]) => dir)).toEqual(["/a", "/b"]);
  });

  it("a writer opened after the deadline is abandoned, not used", async () => {
    let resolveOpen: ((w: FakeWriter) => void) | undefined;
    const late = new FakeWriter(path.join("/out", "late.recording.mp4"), path.join("/out", "late.mp4"));
    const ctx = setup({ openWriter: () => new Promise((r) => (resolveOpen = r)) });
    ctx.recorder.toggle();
    await vi.advanceTimersByTimeAsync(8000);
    expect(ctx.recorder.state).toEqual({ type: "idle", outputDirUnavailable: true });
    resolveOpen!(late);
    await flush();
    expect(late.abandoned).toBe(true);
    expect(ctx.host.started).toEqual([]);
    // The folder opened after all: it is no longer said to be unavailable, though the attempt stays a failure.
    expect(ctx.recorder.state).toEqual({ type: "idle" });
  });

  it("clears the unavailable folder once a late check writes to it, and keeps it when the late check fails", async () => {
    for (const late of ["writes", "fails"] as const) {
      let settle: ((ok: boolean) => void) | undefined;
      const ctx = setup({ ensureWritableDir: () => new Promise<void>((resolve, reject) => { settle = ok => ok ? resolve() : reject(new Error("EIO")); }) });
      ctx.recorder.toggle();
      await vi.advanceTimersByTimeAsync(8000);
      expect(ctx.recorder.state).toEqual({ type: "idle", outputDirUnavailable: true });
      settle!(late === "writes");
      await flush();
      expect(ctx.recorder.state).toEqual(late === "writes" ? { type: "idle" } : { type: "idle", outputDirUnavailable: true });
      expect(ctx.events.filter(event => event.type === "failed").map(event => event.type === "failed" && event.code)).toEqual(["output_open_failed"]);
    }
  });

  it("leaves a newer attempt's unavailable folder alone when an older one's late check then writes (review pass 1, F1)", async () => {
    let settleFirst: (() => void) | undefined;
    let calls = 0;
    // The folder was changed between the attempts: the second checks its own and fails there.
    let folder = "/out";
    const ctx = setup({ deps: { outputDir: () => folder }, ensureWritableDir: () => ++calls === 1
      ? new Promise<void>((resolve) => { settleFirst = resolve; })
      : Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })) });
    ctx.recorder.toggle();
    await vi.advanceTimersByTimeAsync(8000);
    folder = "/other";
    // The second attempt fails on its own, while the first one's cleanup still waits for its check.
    ctx.recorder.toggle();
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "idle", outputDirUnavailable: true });
    settleFirst!();
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "idle", outputDirUnavailable: true });
  });

  it("goes idle before waiting for the partial file to close", async () => {
    const ctx = setup();
    await startRecording(ctx);
    const writer = ctx.writers[0]!;
    let releaseAbandon: (() => void) | undefined;
    writer.abandon = () =>
      new Promise((r) => {
        releaseAbandon = () => r(writer.recordingPath);
      });
    ctx.host.crash();
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(ctx.events.filter(event => event.type === "state").at(-1)).toEqual({ type: "state", state: { type: "idle" } });
    expect(ctx.events.at(-1)).toMatchObject({ type: "failureStatus", result: { outcome: "pending" } });
    await flush();
    releaseAbandon!();
    await flush();
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "capture_host_crashed", partialPath: writer.recordingPath });
  });

  it("shutdown waits for the partial file to be closed before resolving (pass-2 finding 3)", async () => {
    const ctx = setup();
    await startRecording(ctx);
    const writer = ctx.writers[0]!;
    let releaseAbandon: (() => void) | undefined;
    writer.abandon = () =>
      new Promise((r) => {
        releaseAbandon = () => r(writer.recordingPath);
      });
    const shutdown = ctx.recorder.shutdown();
    await vi.advanceTimersByTimeAsync(13_000); // host never answers stop → stop_timeout
    let resolved = false;
    void shutdown.then(() => (resolved = true));
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(await shutdown).toBe(false);
    await flush();
    releaseAbandon!();
    await flush();
    expect(resolved).toBe(true);
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "stop_timeout", partialPath: writer.recordingPath });
  });

  it("shutdown cap during a slow finish does not report a failure; the save completes (pass-2 finding 4)", async () => {
    const ctx = setup();
    await startRecording(ctx);
    const writer = ctx.writers[0]!;
    let releaseFinish: (() => void) | undefined;
    writer.finish = () =>
      new Promise((r) => {
        releaseFinish = () => r(writer.finalPath);
      });
    const shutdown = ctx.recorder.shutdown();
    await flush();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    await vi.advanceTimersByTimeAsync(13_000);
    expect(await shutdown).toBe(false); // Deferred, without failing the session
    const retry = ctx.recorder.shutdown();
    await vi.advanceTimersByTimeAsync(13_000);
    expect(await retry).toBe(false);
    // The recording is over: idle, while its save still holds quit (2026-10-09).
    expect([ctx.recorder.state.type, ctx.recorder.mediaPending, ctx.recorder.waitingOnlyForSaves]).toEqual(["idle", true, true]);
    expect(ctx.events.some((e) => e.type === "failed")).toBe(false);
    releaseFinish!();
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(ctx.events.at(-1)).toEqual({ type: "saved", path: writer.finalPath, session: traced() });
  });

  it("reports media work pending through a failure's cleanup that outlives the idle state (plan 056)", async () => {
    const ctx = setup();
    expect(ctx.recorder.mediaPending).toBe(false);
    let settledNow = false;
    void ctx.recorder.whenMediaSettled().then(() => { settledNow = true; });
    await flush();
    expect(settledNow).toBe(true);
    await startRecording(ctx);
    expect(ctx.recorder.mediaPending).toBe(true);
    const writer = ctx.writers[0]!;
    let releaseAbandon!: () => void;
    writer.abandon = () => new Promise((r) => { releaseAbandon = () => r(writer.recordingPath); });
    let settled = false;
    const waiting = ctx.recorder.whenMediaSettled();
    void waiting.then(() => { settled = true; });
    // A repeated quit joins the same wait instead of adding listeners.
    expect(ctx.recorder.whenMediaSettled()).toBe(waiting);
    ctx.host.crash();
    await flush();
    // Idle already, yet the partial file is still being closed.
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(ctx.recorder.mediaPending).toBe(true);
    expect(settled).toBe(false);
    releaseAbandon();
    await flush();
    expect(ctx.recorder.mediaPending).toBe(false);
    expect(settled).toBe(true);
  });

  it("returns to idle once capture stopped, and settles media work only once the save in the background is done", async () => {
    const ctx = setup();
    await startRecording(ctx);
    const writer = ctx.writers[0]!;
    let releaseFinish!: () => void;
    writer.finish = () => new Promise((r) => { releaseFinish = () => r(writer.finalPath); });
    let settled = false;
    void ctx.recorder.whenMediaSettled().then(() => { settled = true; });
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(ctx.recorder.saving).toEqual([{ sessionId: "s1", recordingPath: writer.recordingPath, slow: false }]);
    expect(settled).toBe(false);
    releaseFinish();
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(settled).toBe(true);
    expect(ctx.recorder.mediaPending).toBe(false);
  });

  it("saves in the background: the next recording may start, a slow save is told once, and its outcome leaves the state alone", async () => {
    let id = 0;
    const logs: string[] = [];
    // The second recording sends no media for the test's 90 s: its stall guard is not the subject here.
    const ctx = setup({ log: (message) => logs.push(message), deps: { newSessionId: () => `s${++id}`, health: { stallWarnMs: 1e9, stallFailMs: 2e9 } } });
    await startRecording(ctx);
    const first = ctx.writers[0]!;
    let failFinish!: (error: Error) => void;
    first.finish = () => new Promise((_resolve, reject) => { failFinish = reject; });
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    // The next recording starts while the first is still being saved.
    ctx.recorder.toggle();
    await flush();
    ctx.host.emit(prepared("s2"));
    ctx.host.emit(chunk("s2", 0));
    await flush();
    expect(ctx.recorder.state.type).toBe("recording");
    expect(ctx.recorder.waitingOnlyForSaves).toBe(false);
    // Slow: told once, never given up on.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ctx.recorder.saving).toEqual([{ sessionId: "s1", recordingPath: first.recordingPath, slow: true }]);
    expect(ctx.events.filter(event => event.type === "savingSlow")).toEqual([{ type: "savingSlow", dir: "/out", session: expect.objectContaining({ id: "s1" }) }]);
    expect(logs).toContain("recorder: session s1 still saving to /out after 30000 ms; the drive may not be responding");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ctx.events.filter(event => event.type === "savingSlow")).toHaveLength(1);
    // The save fails: reported with its partial file, while the second recording goes on.
    failFinish(Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }));
    await flush();
    expect(ctx.recorder.saving).toEqual([]);
    expect(ctx.events.filter(event => event.type === "failed")).toEqual([expect.objectContaining({ code: "output_write_failed", session: expect.objectContaining({ id: "s1" }) })]);
    expect(ctx.recorder.state.type).toBe("recording");
  });

  it("a same-second name collision gets a -2 suffix instead of failing (pass-2 finding 6)", async () => {
    const opened: string[] = [];
    const ctx = setup({
      openWriter: async (recordingPath: string, finalPath: string) => {
        opened.push(recordingPath);
        if (opened.length === 1) {
          throw Object.assign(new Error("exists"), { code: "output_open_failed", cause: { code: "EEXIST" } });
        }
        return new FakeWriter(recordingPath, finalPath);
      },
    });
    ctx.recorder.toggle();
    await flush();
    expect(opened).toEqual([path.join("/out", "2026-09-11 14-30-00.recording.mp4"), path.join("/out", "2026-09-11 14-30-00-2.recording.mp4")]);
    expect(ctx.recorder.state.type).toBe("starting");
    expect(ctx.host.started).toEqual(["s1"]);
  });

  it("shutdown defers quit while partial-file close is stalled and reopens recording admission", async () => {
    const ctx = setup();
    await startRecording(ctx);
    let release!: () => void;
    ctx.writers[0]!.abandon = () => new Promise(resolve => { release = () => resolve(undefined); });
    const quitting = ctx.recorder.shutdown();
    await vi.advanceTimersByTimeAsync(13_000);
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(await quitting).toBe(false);
    await startRecording(ctx);
    expect(ctx.writers).toHaveLength(2);
    expect(ctx.recorder.state.type).toBe("recording");
    ctx.host.crash(); release(); await flush();
    expect(await ctx.recorder.shutdown()).toBe(true);
  });

  it("reports the partial as unknown, keeping its path, when the drive does not answer the check", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.writers[0]!.abandon = () => new Promise(() => undefined);
    ctx.host.crash();
    await vi.advanceTimersByTimeAsync(RECORDING_HEALTH.cleanupCheckMs);
    expect(ctx.events.filter((event) => event.type === "failed").at(-1)).toMatchObject({ outcome: "unknown" });
    expect(ctx.events.filter((event) => event.type === "failureStatus").at(-1))
      .toMatchObject({ result: { outcome: "unknown", recordingPath: ctx.writers[0]!.recordingPath } });
    expect(ctx.recorder.mediaPending).toBe(false);
    expect(await ctx.recorder.shutdown()).toBe(true);
  });

  it("a non-EEXIST open error is not retried", async () => {
    let calls = 0;
    const ctx = setup({
      openWriter: async () => {
        calls += 1;
        throw Object.assign(new Error("ro"), { code: "output_open_failed", cause: { code: "EROFS" } });
      },
    });
    ctx.recorder.toggle();
    await flush();
    expect(calls).toBe(1);
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "output_open_failed" });
  });

  it("onSessionStart is called with each new session id", async () => {
    const host = new FakeHost();
    const started: string[] = [];
    const recorder = new Recorder({
      host,
      outputDir: () => "/out",
      quality: () => DEFAULT_QUALITY,
      ensureWritableDir: async () => undefined,
      openWriter: async () => new FakeWriter("a", "b"),
      newSessionId: () => "s1",
      onSessionStart: (id) => started.push(id),
    });
    recorder.toggle();
    await flush();
    expect(started).toEqual(["s1"]);
  });

  it("a session start hook that throws is logged, and the attempt still goes on instead of jamming the recorder", async () => {
    const host = new FakeHost();
    const logs: string[] = [];
    const recorder = new Recorder({
      host,
      outputDir: () => "/out",
      quality: () => DEFAULT_QUALITY,
      ensureWritableDir: async () => undefined,
      openWriter: async () => new FakeWriter("a", "b"),
      newSessionId: () => "s1",
      onSessionStart: () => { throw new Error("no display request"); },
      log: (message) => logs.push(message),
    });
    recorder.toggle();
    await flush();
    expect(host.started).toEqual(["s1"]);
    expect(recorder.state.type).not.toBe("idle");
    expect(logs).toContain("recorder: session s1 start hook failed: no display request");
  });

  it("mapHostError replaces the host's code with the owner's known cause", async () => {
    const host = new FakeHost();
    const events: RecorderEvent[] = [];
    const recorder = new Recorder({
      host,
      outputDir: () => "/out",
      quality: () => DEFAULT_QUALITY,
      ensureWritableDir: async () => undefined,
      openWriter: async () => new FakeWriter("a", "b"),
      newSessionId: () => "s1",
      mapHostError: (code) => (code === "capture_start_failed" ? "no_display" : code),
    });
    recorder.subscribe((e) => events.push(e));
    recorder.toggle();
    await flush();
    host.emit({ type: "error", sessionId: "s1", code: "capture_start_failed", detail: "AbortError" });
    await flush();
    expect(events.at(-1)).toMatchObject({ type: "failed", code: "no_display" });
  });
});

describe("Recorder permission", () => {
  it("not granted → needsPermission; click asks for permission; granted → idle", () => {
    const ctx = setup();
    ctx.recorder.setPermission({ granted: false, needsRelaunch: false });
    expect(ctx.recorder.state).toEqual({ type: "needsPermission", needsRelaunch: false });
    ctx.recorder.toggle();
    expect(ctx.events.at(-1)).toEqual({ type: "permissionRequested", needsRelaunch: false });
    expect(ctx.host.started).toEqual([]);
    ctx.recorder.setPermission({ granted: false, needsRelaunch: true });
    expect(ctx.recorder.state).toEqual({ type: "needsPermission", needsRelaunch: true });
    ctx.recorder.setPermission({ granted: true, needsRelaunch: false });
    expect(ctx.recorder.state).toEqual({ type: "idle" });
  });

  it("repeated identical permission polls do not re-emit state", () => {
    const ctx = setup();
    ctx.recorder.setPermission({ granted: false, needsRelaunch: false });
    ctx.recorder.setPermission({ granted: false, needsRelaunch: false });
    ctx.recorder.setPermission({ granted: true, needsRelaunch: false });
    ctx.recorder.setPermission({ granted: true, needsRelaunch: false });
    expect(ctx.states.map((s) => s.type)).toEqual(["needsPermission", "idle"]);
  });

  it("a permission change never interrupts a running recording", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.recorder.setPermission({ granted: false, needsRelaunch: false });
    expect(ctx.recorder.state.type).toBe("recording");
  });

  // Bug 2: the watcher reports a revocation once, and the old recorder
  // dropped it while busy, so the session ended in a misleading "Ready".
  const SAVED = path.join("/out", "2026-09-11 14-30-00.mp4");
  const saveRecording = async (ctx: ReturnType<typeof setup>): Promise<void> => {
    if (ctx.recorder.state.type === "recording") ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
  };

  it("a revoke during recording settles the save into needsPermission and still reports it saved", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.recorder.setPermission({ granted: false, needsRelaunch: false });
    await saveRecording(ctx);
    expect(ctx.recorder.state).toEqual({ type: "needsPermission", needsRelaunch: false });
    expect(ctx.events.at(-1)).toEqual({ type: "saved", path: SAVED, session: traced() });
    ctx.recorder.toggle();
    expect(ctx.events.at(-1)).toEqual({ type: "permissionRequested", needsRelaunch: false });
    expect(ctx.host.started).toEqual(["s1"]);
    ctx.recorder.setPermission({ granted: true, needsRelaunch: false });
    expect(ctx.recorder.state).toEqual({ type: "idle" });
  });

  it("a revoke during stopping settles into the latest needsRelaunch", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.recorder.stop();
    ctx.recorder.setPermission({ granted: false, needsRelaunch: true });
    expect(ctx.recorder.state.type).toBe("stopping");
    await saveRecording(ctx);
    expect(ctx.recorder.state).toEqual({ type: "needsPermission", needsRelaunch: true });
  });

  it("a capture failure after a revoke settles into needsPermission and still reports the failure", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.recorder.setPermission({ granted: false, needsRelaunch: false });
    ctx.host.crash();
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "needsPermission", needsRelaunch: false });
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "capture_host_crashed", partialPath: path.join("/out", "2026-09-11 14-30-00.recording.mp4") });
    expect(ctx.states.map((s) => s.type)).toEqual(["starting", "recording", "needsPermission"]);
  });

  it("a revoke during starting settles a start failure into needsPermission; the grant restores the folder flag", async () => {
    let rejectDir!: (cause: Error) => void;
    const ctx = setup({ ensureWritableDir: () => new Promise((_resolve, reject) => { rejectDir = reject; }) });
    ctx.recorder.toggle();
    ctx.recorder.setPermission({ granted: false, needsRelaunch: false });
    expect(ctx.recorder.state.type).toBe("starting");
    await flush();
    rejectDir(new Error("EACCES"));
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "needsPermission", needsRelaunch: false });
    expect(ctx.events.at(-1)).toEqual({ type: "failed", code: "output_open_failed", detail: "EACCES", outcome: "empty", session: traced() });
    ctx.recorder.setPermission({ granted: true, needsRelaunch: false });
    expect(ctx.recorder.state).toEqual({ type: "idle", outputDirUnavailable: true });
  });

  it("cancels, not fails, an opening that sleep marked and whose folder check then fails", async () => {
    let rejectDir!: (cause: Error) => void;
    const ctx = setup({ ensureWritableDir: () => new Promise((_resolve, reject) => { rejectDir = reject; }) });
    ctx.recorder.toggle();
    await flush();
    ctx.recorder.systemWillSleep();
    rejectDir(new Error("EIO"));
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(ctx.events.filter((event) => event.type === "cancelled")).toEqual([{ type: "cancelled", reason: "sleep", session: traced() }]);
    expect(ctx.events.some((event) => event.type === "failed" || event.type === "failureStatus")).toBe(false);
    expect(ctx.host.started).toEqual([]);
  });

  it("choosing a folder while permission is missing forgets the unusable-folder flag", async () => {
    const ctx = setup({ ensureWritableDir: async () => { throw new Error("EACCES"); } });
    ctx.recorder.setPermission({ granted: false, needsRelaunch: false });
    ctx.recorder.setPermission({ granted: true, needsRelaunch: false });
    ctx.recorder.toggle();
    ctx.recorder.setPermission({ granted: false, needsRelaunch: false });
    await flush();
    ctx.recorder.outputDirChanged();
    expect(ctx.recorder.state).toEqual({ type: "needsPermission", needsRelaunch: false });
    ctx.recorder.setPermission({ granted: true, needsRelaunch: false });
    expect(ctx.recorder.state).toEqual({ type: "idle" });
  });

  it("a grant later in the same session needs no duplicate event", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.recorder.setPermission({ granted: false, needsRelaunch: false });
    ctx.recorder.setPermission({ granted: true, needsRelaunch: false });
    await saveRecording(ctx);
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(ctx.states.map((s) => s.type)).toEqual(["starting", "recording", "stopping", "idle"]);
  });

  it("needsRelaunch transitions after a save stay in needsPermission until the grant returns", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.recorder.setPermission({ granted: false, needsRelaunch: true });
    await saveRecording(ctx);
    ctx.recorder.setPermission({ granted: false, needsRelaunch: false });
    ctx.recorder.setPermission({ granted: false, needsRelaunch: false });
    expect(ctx.recorder.state).toEqual({ type: "needsPermission", needsRelaunch: false });
    ctx.recorder.setPermission({ granted: true, needsRelaunch: false });
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(ctx.states.map((s) => s.type)).toEqual(["starting", "recording", "stopping", "needsPermission", "needsPermission", "idle"]);
  });
});

describe("Recorder shutdown", () => {
  it("resolves immediately when idle", async () => {
    const ctx = setup();
    await expect(ctx.recorder.shutdown()).resolves.toBe(true);
  });

  it("stops a running recording and resolves when idle", async () => {
    const ctx = setup();
    await startRecording(ctx);
    let done = false;
    const shutdown = ctx.recorder.shutdown().then(() => {
      done = true;
    });
    await flush();
    expect(ctx.recorder.state.type).toBe("stopping");
    expect(done).toBe(false);
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    await shutdown;
    expect(ctx.recorder.state.type).toBe("idle");
    expect(ctx.writers[0]!.finished).toBe(true);
  });

  it("cancels an attempt still preparing at once, without waiting for prepared (plan 065): no media existed, so nothing records or fails", async () => {
    const ctx = setup({ deps: { countdownSeconds: () => 3 } });
    ctx.recorder.toggle();
    await flush();
    const shutdown = ctx.recorder.shutdown();
    await flush();
    expect(ctx.recorder.state.type).toBe("idle");
    expect(await shutdown).toBe(true);
    expect(ctx.host.stopped).toEqual(["s1"]);
    // The late answer is a stale session's: stopped again, never counted down or recorded.
    ctx.host.emit(prepared("s1"));
    await flush();
    expect(ctx.host.recorded).toEqual([]);
    expect(ctx.host.stopped).toEqual(["s1", "s1"]);
    expect(ctx.states.map((state) => state.type)).toEqual(["starting", "idle"]);
    expect(ctx.writers[0]!.abandoned).toBe(true);
    expect(ctx.events.filter((event) => event.type === "cancelled")).toEqual([
      { type: "cancelled", reason: "quit", session: traced() },
    ]);
    expect(ctx.events.some((event) => event.type === "failed" || event.type === "failureStatus" || event.type === "saved")).toBe(false);
  });

  it("does not admit quit until the cancelled attempt's file and sentinel are gone (review pass 2)", async () => {
    let release!: () => void;
    const removed: string[] = [];
    const writers: FakeWriter[] = [];
    const ctx = setup({
      openWriter: async (recordingPath, finalPath) => {
        const writer = new FakeWriter(recordingPath, finalPath);
        writer.abandon = () => new Promise((resolve) => { release = () => { writer.abandoned = true; resolve(undefined); }; });
        writers.push(writer);
        return writer;
      },
      deps: { countdownSeconds: () => 3, sentinels: { write: async () => undefined, remove: async (id) => { removed.push(id); } } },
    });
    ctx.recorder.toggle();
    await flush();
    let admitted: boolean | undefined;
    void ctx.recorder.shutdown().then((safe) => { admitted = safe; });
    await flush();
    expect(ctx.recorder.state.type).toBe("idle");
    expect(admitted).toBeUndefined();
    expect(writers[0]!.abandoned).toBe(false);
    expect(removed).toEqual([]);
    release();
    await flush();
    expect(writers[0]!.abandoned).toBe(true);
    expect(removed).toEqual(["s1"]);
    expect(admitted).toBe(true);
  });

  it("a prepared arriving before the deferred check still cancels, with the countdown Off too", async () => {
    const ctx = setup();
    ctx.recorder.toggle();
    await flush();
    const shutdown = ctx.recorder.shutdown();
    // Synchronously after the quit, before its check runs: the mark turns it into the cancel.
    ctx.host.emit(prepared("s1"));
    await flush();
    expect(await shutdown).toBe(true);
    expect(ctx.host.recorded).toEqual([]);
    expect(ctx.events.map((event) => event.type)).not.toContain("captureStarted");
    expect(ctx.events.filter((event) => event.type === "cancelled")).toHaveLength(1);
  });

  it("cancels during opening without asking for capture at all, once the folder check it awaits returns", async () => {
    let open!: () => void;
    const ctx = setup({ ensureWritableDir: () => new Promise<void>((resolve) => { open = resolve; }) });
    ctx.recorder.toggle();
    await flush();
    let admitted: boolean | undefined;
    void ctx.recorder.shutdown().then((safe) => { admitted = safe; });
    await flush();
    expect(ctx.recorder.state.type).toBe("idle");
    // The cancelled attempt still owns the folder check, so quit waits for it.
    expect(admitted).toBeUndefined();
    open();
    await flush();
    expect(admitted).toBe(true);
    expect(ctx.host.started).toEqual([]);
    expect(ctx.host.stopped).toEqual([]);
    expect(ctx.writers).toEqual([]);
    expect(ctx.events.filter((event) => event.type === "cancelled")).toEqual([{ type: "cancelled", reason: "quit", session: traced() }]);
  });

  it("after record was sent, quit stops the capture once it starts", async () => {
    const ctx = setup();
    ctx.host.autoStart = false;
    ctx.recorder.toggle();
    await flush();
    ctx.host.emit(prepared("s1"));
    expect(ctx.host.recorded).toEqual(["s1"]);
    const shutdown = ctx.recorder.shutdown();
    await flush();
    ctx.host.emit({ type: "started", sessionId: "s1" });
    expect(ctx.recorder.state.type).toBe("stopping");
    ctx.host.emit(chunk("s1", 0));
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(await shutdown).toBe(true);
    expect(ctx.events.filter((event) => event.type === "saved")).toHaveLength(1);
  });

  it("a chunk before started keeps the record → started deadline", async () => {
    const ctx = setup();
    ctx.host.autoStart = false;
    ctx.recorder.toggle();
    await flush();
    ctx.host.emit(prepared("s1"));
    expect(ctx.host.recorded).toEqual(["s1"]);
    // A host that deviates from the protocol: media arrives, `started` never does.
    ctx.host.emit(chunk("s1", 0));
    await vi.advanceTimersByTimeAsync(8000);
    expect(ctx.events).toContainEqual(expect.objectContaining({ type: "failed", code: "capture_start_failed" }));
    expect(ctx.recorder.state.type).toBe("idle");
  });

  it("keeps capture admission closed after a safe shutdown until quit is declined", async () => {
    const ctx = setup();
    expect(await ctx.recorder.shutdown()).toBe(true);
    ctx.recorder.toggle();
    await flush();
    expect(ctx.recorder.state.type).toBe("idle");
    expect(ctx.host.started).toEqual([]);
    ctx.recorder.resumeAdmission();
    ctx.recorder.toggle();
    await flush();
    expect(ctx.recorder.state.type).toBe("starting");
  });

  it("admits quit after a missing stop response is failed and cleaned up within the margin", async () => {
    const ctx = setup();
    await startRecording(ctx);
    const shutdown = ctx.recorder.shutdown();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await shutdown).toBe(true);
    expect(ctx.recorder.state.type).toBe("idle");
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "stop_timeout" });
  });
});

describe("quality snapshot", () => {
  it("passes the quality read at session start to the host and ignores later changes", async () => {
    let current: QualitySettings = { ...DEFAULT_QUALITY, videoQuality: "high" };
    const ctx = setup({ quality: () => current });
    ctx.recorder.toggle();
    current = { ...DEFAULT_QUALITY, videoQuality: "economy" };
    await flush();
    expect(ctx.host.startedWith).toEqual([{ ...DEFAULT_QUALITY, videoQuality: "high" }]);
  });

  it("logs the capture report and emits captureStarted with the session's snapshot", async () => {
    const logs: string[] = [];
    const quality: QualitySettings = { ...DEFAULT_QUALITY, frameRate: 60 };
    const ctx = setup({ quality: () => quality, log: (m) => logs.push(m) });
    ctx.recorder.toggle();
    await flush();
    const report: CaptureReport = { ...CAPTURE, frameRate: 30, warnings: ["x"] };
    ctx.host.emit(prepared("s1", report));
    expect(ctx.events.at(-1)).toEqual({ type: "captureStarted", sessionId: "s1", requested: quality, capture: report });
    const line = logs.find((l) => l.includes("capture:"));
    expect(line).toContain("fps=60");
    expect(line).toContain("track size=1920x1080 fps=30");
    expect(line).toContain("target videoBps=8100000 audioBps=256000");
    expect(line).toContain("warnings: x");
  });
});

describe("display loss races", () => {
  it.each(["removal", "stop", "track"])("finalizes once when %s happens first", async (first) => {
    const ctx = setup(); await startRecording(ctx);
    const remove = () => ctx.recorder.displayRemoved();
    const stop = () => ctx.recorder.stop();
    const track = () => ctx.host.emit({ type: "error", sessionId: "s1", code: "capture_failed", detail: "video ended" });
    if (first === "removal") remove(); else if (first === "stop") stop(); else track();
    remove(); track(); stop(); await flush();
    expect(ctx.events.filter((e) => e.type === "failed")).toHaveLength(1);
    expect(ctx.events.filter((e) => e.type === "saved")).toHaveLength(0);
    expect(ctx.writers[0]?.abandoned).toBe(true);
    expect(ctx.recorder.state.type).toBe("idle");
  });
  it("saves a stopped recording whose display is removed before the host replies", async () => {
    const logs: string[] = [];
    const ctx = setup({ log: (message) => logs.push(message) }); await startRecording(ctx); ctx.recorder.stop();
    ctx.recorder.displayRemoved();
    ctx.host.emit({ type: "stopped", sessionId: "s1" }); await flush();
    expect(ctx.events.filter((e) => e.type === "saved")).toHaveLength(1);
    expect(ctx.events.filter((e) => e.type === "failed" || e.type === "displayFailed")).toEqual([]);
    expect(ctx.writers[0]?.abandoned).toBe(false);
    expect(logs).toContainEqual(expect.stringContaining("display removed after the stop was sent"));
  });
  it("does not abandon a file already finalizing after a normal stop", async () => {
    const ctx = setup(); await startRecording(ctx); ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" }); ctx.recorder.displayRemoved(); await flush();
    expect(ctx.events.filter((e) => e.type === "saved")).toHaveLength(1);
    expect(ctx.writers[0]?.abandoned).toBe(false);
  });
});

it("retains video-loss diagnostics before idle even if removal arrives later", async () => {
  const ctx = setup(); await startRecording(ctx);
  ctx.host.emit({ type: "error", sessionId: "s1", code: "capture_failed", detail: "ended", displayFailure: "track_ended" });
  ctx.recorder.displayRemoved(); await flush();
  const diagnostic = ctx.events.findIndex((e) => e.type === "displayFailed");
  const idle = ctx.events.findIndex((e) => e.type === "state" && e.state.type === "idle");
  expect(diagnostic).toBeGreaterThan(-1); expect(diagnostic).toBeLessThan(idle);
  expect(ctx.events.filter((e) => e.type === "displayFailed")).toEqual([{ type: "displayFailed", detail: "track_ended" }]);
});
it("normal finalization followed by removal does not emit a display failure", async () => {
  const ctx = setup(); await startRecording(ctx); ctx.recorder.stop();
  ctx.host.emit({ type: "stopped", sessionId: "s1" }); ctx.recorder.displayRemoved(); await flush();
  expect(ctx.events.filter((e) => e.type === "displayFailed")).toEqual([]);
  expect(ctx.events.filter((e) => e.type === "saved")).toHaveLength(1);
});


describe("Recorder with real EngineFileWriter", () => {
  it.each(["disk_full", "output_write_failed"] as const)("reports the engine's write error (%s), keeps the partial, and records again", async (code) => {
    vi.useRealTimers();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordstuff-recorder-"));
    const host = new FakeHost();
    const events: RecorderEvent[] = [];
    const writers: EngineFileWriter[] = [];
    let session = 0;
    const recorder = new Recorder({
      host, outputDir: () => dir, quality: () => DEFAULT_QUALITY,
      ensureWritableDir: async () => undefined,
      now: () => new Date(2026, 8, 24, 12, 0, 0),
      newSessionId: () => `real-${++session}`,
      openWriter: async (recordingPath, finalPath) => {
        const failing = session === 1;
        const writer = await EngineFileWriter.open(recordingPath, finalPath, {
          outcome: async (file) => {
            if (failing) throw new FileWriteError(code, file, "write failed");
            return { bytes: (await fs.stat(file)).size, finalizeMs: 1 };
          },
        });
        writers.push(writer);
        return writer;
      },
    });
    recorder.subscribe((event) => events.push(event));
    try {
      recorder.toggle();
      await vi.waitFor(() => expect(host.started).toEqual(["real-1"]));
      host.emit(prepared("real-1"));
      await fs.appendFile(host.recordingPaths[0]!, Buffer.from([1, 2]));
      host.emit({ type: "progress", sessionId: "real-1", bytes: 2 });
      recorder.stop();
      host.emit({ type: "stopped", sessionId: "real-1" });
      await vi.waitFor(() => expect(events.filter((event) => event.type === "failed")).toHaveLength(1));
      const first = writers[0]!;
      expect(events.filter((event) => event.type === "failed")).toEqual([expect.objectContaining({ code, partialPath: first.recordingPath })]);
      expect(events.filter((event) => event.type === "saved")).toHaveLength(0);
      expect(await fs.readFile(first.recordingPath)).toEqual(Buffer.from([1, 2]));
      await expect(fs.stat(first.finalPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(recorder.state.type).toBe("idle");

      recorder.toggle();
      await vi.waitFor(() => expect(host.started).toEqual(["real-1", "real-2"]));
      host.emit(prepared("real-2"));
      await fs.appendFile(host.recordingPaths[1]!, Buffer.from([5, 6, 7, 8, 9]));
      host.emit({ type: "progress", sessionId: "real-2", bytes: 5 });
      recorder.stop();
      host.emit({ type: "stopped", sessionId: "real-2" });
      await vi.waitFor(() => expect(events.filter((event) => event.type === "saved")).toHaveLength(1));
      const saved = events.find((event) => event.type === "saved");
      if (saved?.type !== "saved") throw new Error("Missing saved event");
      expect(await fs.readFile(saved.path)).toEqual(Buffer.from([5, 6, 7, 8, 9]));
      expect(writers[1]!.bytesWritten).toBe(5);
      expect(events.filter((event) => event.type === "failed")).toHaveLength(1);
      expect(await fs.readFile(first.recordingPath)).toEqual(Buffer.from([1, 2]));
    } finally {
      host.crash();
      await recorder.shutdown();
      for (const writer of writers) await writer.abandon();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Recorder rejects zero-byte output with real EngineFileWriter", () => {
  async function real(options: {
    publishFailure?: (result: RecordingFailure) => Promise<void>;
    /** The engine's outcome for a file; defaults to finished at its current size. */
    outcome?: (recordingPath: string) => Promise<EngineFileReport | undefined>;
    deps?: Partial<RecorderDeps>;
  } = {}) {
    vi.useRealTimers();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordstuff-empty-"));
    const host = new FakeHost();
    const events: RecorderEvent[] = [];
    let session = 0;
    const recorder = new Recorder({
      host, outputDir: () => dir, quality: () => DEFAULT_QUALITY,
      ensureWritableDir: async () => undefined,
      now: () => new Date(2026, 8, 25, 12, 0, 0),
      newSessionId: () => `empty-${++session}`,
      ...(options.publishFailure ? { publishFailure: options.publishFailure } : {}),
      openWriter: (recordingPath, finalPath) => EngineFileWriter.open(recordingPath, finalPath, {
        outcome: options.outcome ?? (async (file) => ({ bytes: (await fs.stat(file)).size, finalizeMs: 1 })),
      }),
      ...options.deps,
    });
    recorder.subscribe((event) => events.push(event));
    const begin = async (id: string): Promise<void> => {
      recorder.toggle();
      await vi.waitFor(() => expect(host.started).toContain(id));
      host.emit(prepared(id));
    };
    /** The engine writes `values` to the session's file, then reports its size so far. */
    const media = async (sessionId: string, ...values: number[]): Promise<void> => {
      const file = host.recordingPaths[host.started.lastIndexOf(sessionId)]!;
      await fs.appendFile(file, Buffer.from(values));
      host.emit({ type: "progress", sessionId, bytes: (await fs.stat(file)).size });
    };
    const of = <T extends RecorderEvent["type"]>(type: T) =>
      events.filter((event): event is Extract<RecorderEvent, { type: T }> => event.type === type);
    const cleanup = async (): Promise<void> => {
      await recorder.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
    };
    return { dir, host, recorder, begin, media, of, cleanup };
  }

  it("reports a cancel after record as the cancel when capture stops before its first frame, and saves one that got frames", async () => {
    const ctx = await real();
    try {
      ctx.host.autoStart = false;
      await ctx.begin("empty-1");
      await vi.waitFor(() => expect(ctx.host.recorded).toContain("empty-1"));
      ctx.recorder.cancelCountdown("menu");
      // A sleep after the cancel keeps the cancel as the reason.
      ctx.recorder.systemWillSleep();
      // Capture starts after the cancel, and is stopped at once, before any frame.
      ctx.host.emit({ type: "started", sessionId: "empty-1" });
      expect(ctx.host.stopped).toContain("empty-1");
      ctx.host.emit({ type: "stopped", sessionId: "empty-1" });
      await vi.waitFor(() => expect(ctx.of("cancelled")).toHaveLength(1));
      expect(ctx.of("cancelled")[0]).toMatchObject({ reason: "menu", session: expect.objectContaining({ id: "empty-1" }) });
      expect([ctx.of("failed"), ctx.of("failureStatus"), ctx.of("saved")]).toEqual([[], [], []]);
      expect(ctx.recorder.state).toEqual({ type: "idle" });
      expect(await fs.readdir(ctx.dir)).toEqual([]);

      // The same cancel, but a frame made it out first: what was recorded is kept.
      await ctx.begin("empty-2");
      await vi.waitFor(() => expect(ctx.host.recorded).toContain("empty-2"));
      ctx.recorder.cancelCountdown("menu");
      ctx.host.emit({ type: "started", sessionId: "empty-2" });
      await ctx.media("empty-2", 5, 6, 7);
      ctx.host.emit({ type: "stopped", sessionId: "empty-2" });
      await vi.waitFor(() => expect(ctx.of("saved")).toHaveLength(1));
      expect(ctx.of("cancelled")).toHaveLength(1);
    } finally { await ctx.cleanup(); }
  });

  it.each([["no progress", 0], ["only empty progress", 2]] as const)(
    "fails a stop with %s as capture_start_failed, removes the empty file and records again",
    async (_label, empty) => {
      const ctx = await real();
      try {
        await ctx.begin("empty-1");
        for (let i = 0; i < empty; i++) await ctx.media("empty-1");
        ctx.recorder.stop();
        ctx.host.emit({ type: "stopped", sessionId: "empty-1" });
        ctx.host.emit({ type: "stopped", sessionId: "empty-1" });
        await vi.waitFor(() => expect(ctx.of("failed")).toHaveLength(1));
        expect(ctx.of("failed")).toEqual([{ type: "failed", code: "capture_start_failed", detail: expect.stringContaining(NO_MEDIA_DETAIL),
          outcome: "empty", session: expect.objectContaining({ id: "empty-1" }) }]);
        expect(ctx.of("failureStatus").at(-1)?.result).toMatchObject({ code: "capture_start_failed", outcome: "empty" });
        expect(ctx.of("failureStatus").at(-1)?.result).not.toHaveProperty("partialPath");
        expect(ctx.of("saved")).toHaveLength(0);
        expect(ctx.recorder.state).toEqual({ type: "idle" });
        expect(await fs.readdir(ctx.dir)).toEqual([]);

        // Immediate retry; its only media arrives right before stopped.
        await ctx.begin("empty-2");
        ctx.recorder.stop();
        await ctx.media("empty-2", 5, 6, 7);
        ctx.host.emit({ type: "stopped", sessionId: "empty-2" });
        await vi.waitFor(() => expect(ctx.of("saved")).toHaveLength(1));
        const saved = ctx.of("saved")[0]!.path;
        expect(await fs.readFile(saved)).toEqual(Buffer.from([5, 6, 7]));
        expect(await fs.readdir(ctx.dir)).toEqual([path.basename(saved)]);
        expect(ctx.recorder.state).toEqual({ type: "idle" });
        expect(ctx.of("failed")).toHaveLength(1);
      } finally {
        await ctx.cleanup();
      }
    },
  );

  it("keeps a same-second retry's file when it starts while the empty failure is still publishing", async () => {
    let release!: () => void;
    const publishing = new Promise<void>((resolve) => { release = resolve; });
    const ctx = await real({ publishFailure: async (result) => { if (result.outcome === "pending") await publishing; } });
    try {
      await ctx.begin("empty-1");
      ctx.recorder.stop();
      ctx.host.emit({ type: "stopped", sessionId: "empty-1" });
      await vi.waitFor(() => expect(ctx.of("failureStatus")).toHaveLength(1));
      expect(ctx.recorder.state).toEqual({ type: "idle" });
      // The empty file is already gone, so the retry reuses its name.
      await ctx.begin("empty-2");
      await ctx.media("empty-2", 5, 6, 7);
      release();
      await vi.waitFor(() => expect(ctx.of("failed")).toHaveLength(1));
      expect(ctx.of("failed")[0]).toMatchObject({ code: "capture_start_failed" });
      ctx.recorder.stop();
      ctx.host.emit({ type: "stopped", sessionId: "empty-2" });
      await vi.waitFor(() => expect(ctx.of("saved")).toHaveLength(1));
      const saved = ctx.of("saved")[0]!.path;
      expect(path.basename(saved)).toBe("2026-09-25 12-00-00.mp4");
      expect(await fs.readFile(saved)).toEqual(Buffer.from([5, 6, 7]));
      expect(ctx.of("failed")).toHaveLength(1);
    } finally {
      release();
      await ctx.cleanup();
    }
  });

  it.each(["finishes", "fails with disk_full"] as const)("waits for the engine's outcome that %s before deciding the result", async (result) => {
    let settle!: () => void;
    const gate = new Promise<void>((resolve) => { settle = resolve; });
    const ctx = await real({ outcome: async (file) => {
      await gate;
      if (result !== "finishes") throw new FileWriteError("disk_full", file, "no space");
      return { bytes: 3, finalizeMs: 1 };
    } });
    try {
      await ctx.begin("empty-1");
      await ctx.media("empty-1", 1, 2, 3);
      ctx.recorder.stop();
      ctx.host.emit({ type: "stopped", sessionId: "empty-1" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(ctx.of("saved")).toHaveLength(0);
      expect(ctx.of("failed")).toHaveLength(0);
      settle();
      if (result === "finishes") {
        await vi.waitFor(() => expect(ctx.of("saved")).toHaveLength(1));
        expect(await fs.readFile(ctx.of("saved")[0]!.path)).toEqual(Buffer.from([1, 2, 3]));
        expect(ctx.of("failed")).toHaveLength(0);
      } else {
        // A disk error keeps its own code, and what the engine wrote is kept.
        await vi.waitFor(() => expect(ctx.of("failed")).toHaveLength(1));
        const failed = ctx.of("failed")[0]!;
        expect(failed).toMatchObject({ code: "disk_full", outcome: "partial" });
        expect(await fs.readFile(failed.partialPath!)).toEqual(Buffer.from([1, 2, 3]));
        expect(ctx.of("saved")).toHaveLength(0);
      }
    } finally {
      settle();
      await ctx.cleanup();
    }
  });

  it.each(["disk_full", "output_write_failed"] as const)("reports an engine write error before media as %s, not as no media", async (code) => {
    const ctx = await real();
    try {
      await ctx.begin("empty-1");
      ctx.host.emit({ type: "writeError", sessionId: "empty-1", code, detail: "write failed" });
      await vi.waitFor(() => expect(ctx.of("failed")).toHaveLength(1));
      expect(ctx.of("failed")[0]).toMatchObject({ code, detail: "write failed", outcome: "empty" });
      expect(ctx.of("failed")[0]).not.toHaveProperty("partialPath");
      expect(ctx.of("saved")).toHaveLength(0);
      expect(await fs.readdir(ctx.dir)).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });

  describe("health guards with a real EngineFileWriter (plan 038)", () => {
    it("fails a stalled capture as capture_failed and keeps the nonempty temporary file", async () => {
      const log = vi.fn();
      const ctx = await real({ deps: { log, health: { stallWarnMs: 30, stallFailMs: 90 } } });
      try {
        await ctx.begin("empty-1");
        await ctx.media("empty-1", 1, 2, 3);
        await vi.waitFor(() => expect(ctx.of("failed")).toHaveLength(1));
        const failed = ctx.of("failed")[0]!;
        expect(failed).toMatchObject({ code: "capture_failed", detail: expect.stringContaining("no media for 90 ms") });
        expect(path.basename(failed.partialPath!)).toBe("2026-09-25 12-00-00.recording.mp4");
        expect(await fs.readFile(failed.partialPath!)).toEqual(Buffer.from([1, 2, 3]));
        expect(ctx.of("failureStatus").at(-1)?.result).toMatchObject({ code: "capture_failed", outcome: "partial" });
        expect(log.mock.calls.filter(([message]) => String(message).includes("no media for 30 ms"))).toHaveLength(1);
        expect(ctx.host.stopped).toContain("empty-1");
      } finally {
        await ctx.cleanup();
      }
    });

    it("names the temporary file in a sentinel before creating it and removes the sentinel once saved", async () => {
      const sentinelDir = await fs.mkdtemp(path.join(os.tmpdir(), "recordstuff-sessions-"));
      const sentinels = new SessionSentinels(sentinelDir);
      const seen: Array<{ sentinel: unknown; tempExists: boolean }> = [];
      const ctx = await real({ deps: { sentinels, openWriter: async (recordingPath, finalPath) => {
        seen.push({ sentinel: JSON.parse(await fs.readFile(path.join(sentinelDir, "empty-1.json"), "utf8")),
          tempExists: await fs.stat(recordingPath).then(() => true, () => false) });
        return EngineFileWriter.open(recordingPath, finalPath, { outcome: async () => ({ bytes: 1, finalizeMs: 1 }) });
      } } });
      try {
        await ctx.begin("empty-1");
        expect(seen).toEqual([{ tempExists: false, sentinel: { version: 1, sessionId: "empty-1", startedAt: expect.any(String),
          recordingPath: path.join(ctx.dir, "2026-09-25 12-00-00.recording.mp4") } }]);
        await ctx.media("empty-1", 7);
        // A normal quit stops, saves and clears the sentinel, so the next launch reports nothing.
        const quitting = ctx.recorder.shutdown();
        await vi.waitFor(() => expect(ctx.host.stopped).toContain("empty-1"));
        ctx.host.emit({ type: "stopped", sessionId: "empty-1" });
        expect(await quitting).toBe(true);
        expect(ctx.of("saved")).toHaveLength(1);
        expect(await fs.readdir(sentinelDir)).toEqual([]);
        expect(await new SessionSentinels(sentinelDir).leftovers()).toEqual([]);
      } finally {
        await ctx.cleanup();
        await fs.rm(sentinelDir, { recursive: true, force: true });
      }
    });
  });
});

it("an empty chunk does not satisfy the first-media deadline", async () => {
  const ctx = setup();
  ctx.recorder.toggle();
  await flush();
  ctx.host.emit(prepared("s1"));
  ctx.host.emit(chunk("s1", 0, 0));
  await vi.advanceTimersByTimeAsync(8000);
  expect(ctx.recorder.state).toEqual({ type: "idle" });
  expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "capture_start_failed", detail: expect.stringContaining("before the deadline") });

  ctx.recorder.toggle();
  await flush();
  ctx.host.emit(prepared("s1"));
  ctx.host.emit(chunk("s1", 0, 0));
  ctx.host.emit(chunk("s1", 1));
  await vi.advanceTimersByTimeAsync(20_000);
  expect(ctx.recorder.state.type).toBe("recording");
});

describe("failure presentation timing", () => {
  it("reports unknown when a writer cannot confirm preservation without throwing", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.writers[0]!.preservationUncertain = true;
    ctx.writers[0]!.abandon = async () => "/tmp/partial.recording.mp4";
    ctx.host.crash();
    await ctx.recorder.shutdown();
    const last = ctx.events.filter(event => event.type === "failureStatus").at(-1);
    expect(last).toMatchObject({ result: { outcome: "unknown" } });
    expect(last?.result.partialPath).toBeUndefined();
  });
  it("reports unknown when a real writer cannot read back what the engine wrote", async () => {
    vi.useRealTimers();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordstuff-unknown-"));
    const host = new FakeHost();
    const events: RecorderEvent[] = [];
    const recorder = new Recorder({ host, outputDir: () => dir, quality: () => DEFAULT_QUALITY,
      ensureWritableDir: async () => undefined, newSessionId: () => "real",
      openWriter: (partial, final) => EngineFileWriter.open(partial, final, {
        size: async () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); } }),
    });
    recorder.subscribe(e => events.push(e));
    try {
      recorder.toggle();
      await vi.waitFor(() => expect(host.started).toEqual(["real"]));
      host.emit(prepared("real"));
      await fs.appendFile(host.recordingPaths[0]!, Buffer.from([1, 2, 3])); host.emit({ type: "progress", sessionId: "real", bytes: 3 });
      host.crash();
      expect(await recorder.shutdown()).toBe(true);
      const last = events.filter(event => event.type === "failureStatus").at(-1);
      expect(last).toMatchObject({ result: { outcome: "unknown", code: "capture_host_crashed" } });
      expect(last?.result.partialPath).toBeUndefined();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
  it("announces failure before delayed cleanup, then publishes its file result once", async () => {
    const ctx = setup();
    await startRecording(ctx);
    let resolve!: (path: string) => void;
    ctx.writers[0]!.abandon = () => new Promise<string>(done => { resolve = done; });
    ctx.host.crash();
    const status = ctx.events.filter(event => event.type === "failureStatus");
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ result: { outcome: "pending", code: "capture_host_crashed" } });
    expect(ctx.events.filter(event => event.type === "failed")).toHaveLength(0);
    await flush();
    resolve("/tmp/partial.recording.mp4");
    await flush();
    expect(ctx.events.filter(event => event.type === "failureStatus")).toHaveLength(2);
    expect(ctx.events.filter(event => event.type === "failureStatus")[1]).toMatchObject({
      result: { outcome: "partial", partialPath: "/tmp/partial.recording.mp4" },
    });
    expect(ctx.events.filter(event => event.type === "failed")).toHaveLength(1);
  });
  it("reports unknown preservation when cleanup throws instead of claiming an empty recording", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.writers[0]!.abandon = async () => { throw new Error("close failed"); };
    ctx.host.crash();
    await ctx.recorder.shutdown();
    expect(ctx.events.filter(event => event.type === "failureStatus").at(-1)).toMatchObject({ result: { outcome: "unknown" } });
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "capture_host_crashed" });
  });
});

it("uses different failure identities across recorder instances and preserves the pending candidate path", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const ctx = setup();
    await startRecording(ctx);
    ctx.host.crash();
    const pending = ctx.events.find(event => event.type === "failureStatus");
    expect(pending).toMatchObject({ type: "failureStatus", result: { outcome: "pending", recordingPath: ctx.writers[0]!.recordingPath } });
    if (pending?.type === "failureStatus") ids.push(pending.result.id);
    await ctx.recorder.shutdown();
    const final = ctx.events.filter(event => event.type === "failureStatus").at(-1);
    expect(final?.result.recordingPath).toBeUndefined();
  }
  expect(ids).toHaveLength(2);
  expect(ids[0]).not.toBe(ids[1]);
});

it("sets idle before pending failure subscribers can block on persistence", async () => {
  const ctx = setup();
  await startRecording(ctx);
  const states: string[] = [];
  ctx.recorder.subscribe(event => { if (event.type === "failureStatus" && event.result.outcome === "pending") states.push(ctx.recorder.state.type); });
  ctx.host.crash(); await ctx.recorder.shutdown();
  expect(states).toEqual(["idle"]);
});

describe("terminal ownership and quit admission", () => {
  it.each([false, true])("retains both failure cleanups (reverse=%s) before admitting quit", async (reverse) => {
    const ctx = setup();
    const releases: Array<() => void> = [];
    for (let i = 0; i < 2; i++) {
      await startRecording(ctx);
      const writer = ctx.writers[i]!;
      writer.abandon = () => new Promise(resolve => { releases.push(() => resolve(writer.recordingPath)); });
      ctx.host.crash();
    }
    let safe = false;
    const quitting = ctx.recorder.shutdown().then(result => { safe = result; });
    expect(ctx.recorder.shutdown()).toBe(ctx.recorder.shutdown());
    ctx.recorder.toggle();
    await flush();
    expect(ctx.writers).toHaveLength(2);
    releases[reverse ? 1 : 0]!();
    await flush();
    expect(safe).toBe(false);
    releases[reverse ? 0 : 1]!();
    await quitting;
    expect(safe).toBe(true);
    expect(ctx.events.filter(e => e.type === "failed")).toHaveLength(2);
  });

  it("registers failure cleanup before an idle subscriber requests quit", async () => {
    const ctx = setup();
    await startRecording(ctx);
    let release!: () => void;
    ctx.writers[0]!.abandon = () => new Promise(resolve => { release = () => resolve("/partial"); });
    let safe = false;
    ctx.recorder.subscribe(e => {
      if (e.type === "state" && e.state.type === "idle") void ctx.recorder.shutdown().then(value => { safe = value; });
    });
    ctx.host.crash();
    await flush();
    expect(safe).toBe(false);
    release(); await flush();
    expect(safe).toBe(true);
  });

  it("owns a late writer open and its close even after the opening timeout", async () => {
    let open!: (writer: FakeWriter) => void;
    const ctx = setup({ openWriter: () => new Promise(resolve => { open = resolve; }) });
    ctx.recorder.toggle(); await flush();
    await vi.advanceTimersByTimeAsync(8000);
    let safe = false;
    const quitting = ctx.recorder.shutdown().then(value => { safe = value; });
    await flush(); expect(safe).toBe(false);
    const writer = new FakeWriter("/partial", "/final");
    let close!: () => void;
    writer.abandon = () => new Promise(resolve => { close = () => resolve(undefined); });
    open(writer); await flush(); expect(safe).toBe(false);
    close(); await quitting; expect(safe).toBe(true);
  });

  it.each(["crash", "error", "duplicate-stop"])("ignores %s after stopped while a real publication is pending", async (late) => {
    vi.useRealTimers();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordstuff-terminal-"));
    let copy!: () => void;
    const gate = new Promise<void>(resolve => { copy = resolve; });
    const host = new FakeHost();
    const events: RecorderEvent[] = [];
    const recorder = new Recorder({ host, outputDir: () => dir, quality: () => DEFAULT_QUALITY,
      ensureWritableDir: async () => undefined, newSessionId: () => "real",
      openWriter: (partial, final) => EngineFileWriter.open(partial, final, { outcome: async () => ({ bytes: 3, finalizeMs: 1 }), io: { ...nodeFs,
        link: async (from, to) => { await gate; await nodeFs.link(from, to); },
      } }),
    });
    recorder.subscribe(e => events.push(e));
    try {
      recorder.toggle();
      while (host.started.length === 0) await new Promise(resolve => setTimeout(resolve, 1));
      host.emit(prepared("real"));
      await fs.appendFile(host.recordingPaths[0]!, Buffer.from([1, 2, 3])); host.emit({ type: "progress", sessionId: "real", bytes: 3 });
      recorder.stop(); host.emit({ type: "stopped", sessionId: "real" });
      if (late === "crash") host.crash();
      else if (late === "error") host.emit({ type: "error", sessionId: "real", code: "capture_failed", detail: "late" });
      else host.emit({ type: "stopped", sessionId: "real" });
      copy(); expect(await recorder.shutdown()).toBe(true);
      expect(events.filter(e => e.type === "failed")).toHaveLength(0);
      const saved = events.filter(e => e.type === "saved");
      expect(saved).toHaveLength(1);
      expect([...await fs.readFile(saved[0]!.path)]).toEqual([1, 2, 3]);
    } finally { copy(); await recorder.shutdown(); await fs.rm(dir, { recursive: true, force: true }); }
  });
});

it("retains a late-open candidate as uncertain when its close cannot be confirmed", async () => {
  let open!: (writer: FakeWriter) => void;
  const ctx = setup({ openWriter: () => new Promise(resolve => { open = resolve; }) });
  ctx.recorder.toggle(); await flush();
  await vi.advanceTimersByTimeAsync(8000);
  const late = new FakeWriter(path.join("/out", "late.recording.mp4"), path.join("/out", "late.mp4"));
  late.abandon = async () => { throw new Error("close failed"); };
  open(late); await flush();
  expect(await ctx.recorder.shutdown()).toBe(true);
  const statuses = ctx.events.filter(event => event.type === "failureStatus");
  expect(statuses.at(-1)).toMatchObject({ result: { outcome: "unknown", recordingPath: late.recordingPath } });
  expect(statuses.at(-1)).not.toHaveProperty("result.partialPath");
  expect(ctx.events.filter(event => event.type === "failed")).toHaveLength(1);
});

it("quits at once during an interactive capture request instead of waiting up to two minutes (plan 065)", async () => {
  const logs: string[] = [];
  const ctx = setup({ captureRequestTimeoutMs: "default", log: (message) => logs.push(message) });
  ctx.recorder.toggle(); await flush();
  const quitting = ctx.recorder.shutdown();
  await flush();
  expect(await quitting).toBe(true);
  expect(ctx.recorder.state.type).toBe("idle");
  expect(ctx.host.stopped).toEqual(["s1"]);
  expect(logs).toContain("recorder: session s1 cancelled (quit) while preparing capture");
  // The capture request's timer went with the session: nothing fails two minutes later.
  await vi.advanceTimersByTimeAsync(120_000);
  ctx.host.emit(prepared("s1")); await flush();
  expect(ctx.host.recorded).toEqual([]);
  expect(ctx.events.filter(event => event.type === "cancelled")).toHaveLength(1);
  expect(ctx.events.some(event => event.type === "failed" || event.type === "failureStatus" || event.type === "saved")).toBe(false);
});

describe("disk headroom guard", () => {
  const MIB = 1024 * 1024;
  const logged = (log: ReturnType<typeof vi.fn>, text: string) => log.mock.calls.filter(([message]) => String(message).includes(text));

  it("warns once below 1 GiB, requests one normal stop below 200 MiB and saves with the reason", async () => {
    const free = [2048, 2048, 900, 800, 150, 100].map((mib) => mib * MIB);
    const polled: string[] = [];
    const log = vi.fn();
    const ctx = setup({ log, deps: { freeSpace: async (dir) => { polled.push(dir); return free.shift()!; } } });
    await startRecording(ctx);
    for (let seq = 1; seq <= 3; seq++) {
      await vi.advanceTimersByTimeAsync(5000);
      ctx.host.emit(chunk("s1", seq));
    }
    expect(ctx.recorder.state.type).toBe("recording");
    expect(logged(log, "below 1073741824")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.recorder.state).toEqual({ type: "stopping" });
    expect(ctx.host.stopped).toEqual(["s1"]);
    expect(logged(log, "stopping early")).toHaveLength(1);
    // No poll while stopping, so the stop is requested only once.
    await vi.advanceTimersByTimeAsync(5000);
    expect(polled).toEqual(["/out", "/out", "/out", "/out", "/out"]);
    ctx.host.emit(chunk("s1", 4));
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(ctx.events.filter((event) => event.type === "saved")).toEqual([
      { type: "saved", path: path.join("/out", "2026-09-11 14-30-00.mp4"), stoppedEarly: "lowDisk", session: traced() },
    ]);
    expect(ctx.writers[0]!.written).toHaveLength(5);
    expect(ctx.events.some((event) => event.type === "failed" || event.type === "failureStatus")).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`file finalized ${path.join("/out", "2026-09-11 14-30-00.mp4")} (stopped early: disk almost full)`));
  });

  it("logs a failed poll once and never stops the recording because of it", async () => {
    const log = vi.fn();
    const freeSpace = vi.fn(async (): Promise<number> => { throw new Error("statfs unavailable"); }).mockResolvedValueOnce(2048 * MIB);
    const ctx = setup({ log, deps: { freeSpace } });
    await startRecording(ctx);
    for (let seq = 1; seq <= 3; seq++) {
      await vi.advanceTimersByTimeAsync(5000);
      ctx.host.emit(chunk("s1", seq));
    }
    expect(freeSpace).toHaveBeenCalledTimes(4);
    expect(ctx.recorder.state.type).toBe("recording");
    expect(logged(log, "free-space check failed: statfs unavailable")).toHaveLength(1);
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(ctx.events.at(-1)).toEqual({ type: "saved", path: path.join("/out", "2026-09-11 14-30-00.mp4"), session: traced() });
  });

  it("refuses to start below the stop threshold as disk_full, without calling the folder unavailable", async () => {
    const ctx = setup({ deps: { freeSpace: async () => 100 * MIB } });
    ctx.recorder.toggle();
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "disk_full", detail: "Insufficient free space to begin recording", outcome: "empty" });
    expect(ctx.writers).toEqual([]);
    expect(ctx.host.started).toEqual([]);
  });

  it("starts without the guard when the free-space lookup before start fails, instead of refusing the folder", async () => {
    const log = vi.fn();
    const freeSpace = vi.fn(async (): Promise<number> => { throw new Error("statfs unavailable"); });
    const ctx = setup({ log, deps: { freeSpace } });
    ctx.recorder.toggle();
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "starting" });
    expect(ctx.events.some((event) => event.type === "failed" || event.type === "failureStatus")).toBe(false);
    expect(logged(log, "free-space check before start failed: statfs unavailable; starting without it")).toHaveLength(1);
    ctx.host.emit(prepared("s1"));
    await flush();
    expect(ctx.recorder.state.type).toBe("recording");
    expect(ctx.recorder.state).not.toHaveProperty("outputDirUnavailable");
  });
});

describe("stalled capture guard", () => {
  const warnings = (log: ReturnType<typeof vi.fn>) => log.mock.calls.filter(([message]) => String(message).includes("no media for 10000 ms"));

  it("warns once at 10 s and fails at 30 s without media; nonempty chunks reset it, empty ones do not", async () => {
    const log = vi.fn();
    const ctx = setup({ log });
    await startRecording(ctx);
    await vi.advanceTimersByTimeAsync(9999);
    ctx.host.emit(chunk("s1", 1));
    await vi.advanceTimersByTimeAsync(9999);
    expect(warnings(log)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(warnings(log)).toHaveLength(1);
    ctx.host.emit(chunk("s1", 2, 0));
    await vi.advanceTimersByTimeAsync(19_999);
    expect(ctx.recorder.state.type).toBe("recording");
    await vi.advanceTimersByTimeAsync(1);
    const writer = ctx.writers[0]!;
    expect(ctx.events.at(-1)).toEqual({ type: "failed", code: "capture_failed",
      detail: "capture stalled: no media for 30000 ms while the capture host still responded", partialPath: writer.recordingPath,
      outcome: "partial", session: traced() });
    expect(warnings(log)).toHaveLength(1);
    expect(ctx.host.stopped).toEqual(["s1"]);
  });

  it("never reads a slow finish after a normal stop as a stall", async () => {
    let publish!: () => void;
    const ctx = setup({ openWriter: async (recordingPath, finalPath) => {
      const writer = new FakeWriter(recordingPath, finalPath);
      writer.finish = () => new Promise((resolve) => { publish = () => resolve(finalPath); });
      ctx.writers.push(writer);
      return writer;
    } });
    await startRecording(ctx);
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ctx.events.some((event) => event.type === "failed")).toBe(false);
    publish();
    await flush();
    expect(ctx.events.at(-1)).toEqual({ type: "saved", path: path.join("/out", "2026-09-11 14-30-00.mp4"), session: traced() });
  });
});

describe("interruption sentinel lifecycle", () => {
  /** `failWrites` fails that many writes first; `fail` fails every one. */
  function sentinels(options: { fail?: boolean; failWrites?: number; complete?: (sessionId: string) => Promise<void>; failing?: boolean } = {}) {
    const files = new Map<string, SessionSentinel>();
    const calls: string[] = [];
    let failures = options.failWrites ?? 0;
    return { files, calls,
      write: async (sentinel: SessionSentinel) => {
        calls.push(`write ${path.basename(sentinel.recordingPath)}`);
        if (options.fail || failures-- > 0) throw new Error("userData is read-only");
        files.set(sentinel.sessionId, sentinel);
      },
      ...(options.complete ? { complete: async (sessionId: string) => { calls.push(`complete ${sessionId}`); await options.complete!(sessionId); } } : {}),
      ...(options.failing ? { failing: async (sessionId: string, failureId: string) => { calls.push(`failing ${sessionId} ${failureId}`); } } : {}),
      remove: async (sessionId: string) => { calls.push(`remove ${sessionId}`); files.delete(sessionId); } };
  }
  const timingLine = (log: ReturnType<typeof vi.fn>): string | undefined =>
    log.mock.calls.map(([message]) => String(message)).find(message => message.includes("finalize timing"));
  type Ctx = ReturnType<typeof setup>;

  it("names the file from the start request, the instant its sentinel records, however long the folder takes", async () => {
    const store = sentinels();
    let clock = new Date(2026, 8, 11, 14, 30, 0).getTime();
    // Each reading is later than the last, as when a slow folder delays the writer past a second boundary.
    const ctx: Ctx = setup({ deps: { sentinels: store, now: () => new Date((clock += 1500)) } });
    await startRecording(ctx);
    const sentinel = store.files.get("s1")!;
    expect(sentinel.recordingPath).toBe(path.join("/out", `${formatTimestamp(new Date(sentinel.startedAt))}.recording.mp4`));
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
  });

  it("writes before each temporary-name attempt and removes it after the saved event", async () => {
    const store = sentinels();
    let attempt = 0;
    const ctx: Ctx = setup({ deps: { sentinels: store }, openWriter: async (recordingPath, finalPath) => {
      store.calls.push(`open ${path.basename(recordingPath)}`);
      if (++attempt === 1) throw Object.assign(new Error("exists"), { cause: { code: "EEXIST" } });
      const writer = new FakeWriter(recordingPath, finalPath);
      ctx.writers.push(writer);
      return writer;
    } });
    ctx.recorder.subscribe((event) => { if (event.type === "saved") store.calls.push("saved"); });
    await startRecording(ctx);
    expect(store.files.get("s1")).toEqual({ sessionId: "s1", startedAt: expect.any(String), recordingPath: path.join("/out", "2026-09-11 14-30-00-2.recording.mp4") });
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(store.calls).toEqual([
      "write 2026-09-11 14-30-00.recording.mp4", "open 2026-09-11 14-30-00.recording.mp4",
      "write 2026-09-11 14-30-00-2.recording.mp4", "open 2026-09-11 14-30-00-2.recording.mp4",
      "saved", "remove s1",
    ]);
    expect(store.files.size).toBe(0);
  });

  it.each<[string, (ctx: Ctx) => Promise<void>]>([
    ["capture_start_failed", async (ctx) => { ctx.recorder.toggle(); await flush(); ctx.host.emit(prepared("s1")); await vi.advanceTimersByTimeAsync(8000); }],
    ["no_audio_track", async (ctx) => { ctx.recorder.toggle(); await flush(); ctx.host.emit({ type: "error", sessionId: "s1", code: "no_audio_track", detail: "" }); await flush(); }],
    ["capture_failed", async (ctx) => { await startRecording(ctx); ctx.host.emit({ type: "stopped", sessionId: "s1" }); await flush(); }],
    ["capture_host_crashed", async (ctx) => { await startRecording(ctx); ctx.host.crash(); await flush(); }],
    ["disk_full", async (ctx) => {
      await startRecording(ctx);
      ctx.host.emit({ type: "writeError", sessionId: "s1", code: "disk_full", detail: "ENOSPC" }); await flush();
    }],
    ["stop_timeout", async (ctx) => { await startRecording(ctx); ctx.recorder.stop(); await vi.advanceTimersByTimeAsync(10_000); }],
  ])("removes the sentinel after a %s failure settles", async (code, trigger) => {
    const store = sentinels();
    const ctx = setup({ deps: { sentinels: store } });
    await trigger(ctx);
    expect(ctx.events.filter((event) => event.type === "failed")).toEqual([expect.objectContaining({ code })]);
    expect(store.calls).toEqual(["write 2026-09-11 14-30-00.recording.mp4", "remove s1"]);
    expect(store.files.size).toBe(0);
  });

  it("names the failure on the sentinel before its report is published, so a crash during its cleanup reports it once", async () => {
    const store = sentinels({ failing: true });
    const ctx = setup({ deps: { sentinels: store } });
    ctx.recorder.subscribe((event) => { if (event.type === "failureStatus") store.calls.push(`report ${event.result.outcome}`); });
    await startRecording(ctx);
    ctx.host.crash();
    await flush();
    const reported = ctx.events.find((event) => event.type === "failureStatus");
    const id = reported?.type === "failureStatus" ? reported.result.id : "";
    expect(store.calls).toEqual(["write 2026-09-11 14-30-00.recording.mp4", `failing s1 ${id}`, "report pending", "report partial", "remove s1"]);
  });

  it("names the failure after a sentinel write still running, and tries no further name once the attempt ended (review pass 1, F1)", async () => {
    const store = sentinels({ failing: true });
    let releaseWrite: (() => void) | undefined;
    const write = store.write;
    // The first write is still running when the opening deadline fails the attempt.
    store.write = async (sentinel) => { await new Promise<void>((resolve) => { releaseWrite = resolve; }); store.write = write; await write(sentinel); };
    let rejectOpen: ((cause: unknown) => void) | undefined;
    const ctx = setup({ deps: { sentinels: store }, openWriter: () => new Promise((_resolve, reject) => { rejectOpen = reject; }) });
    ctx.recorder.toggle();
    await vi.advanceTimersByTimeAsync(8000);
    releaseWrite!();
    await flush();
    // The name was taken after all: the ended attempt does not move on to "-2" and rewrite its sentinel.
    rejectOpen!(Object.assign(new Error("exists"), { cause: { code: "EEXIST" } }));
    await flush();
    const reported = ctx.events.find((event) => event.type === "failureStatus");
    const id = reported?.type === "failureStatus" ? reported.result.id : "";
    expect(store.calls).toEqual(["write 2026-09-11 14-30-00.recording.mp4", `failing s1 ${id}`, "remove s1"]);
  });

  it("isolates a throwing subscriber: the others still hear the failure and the sentinel is still removed", async () => {
    const store = sentinels();
    const logs: string[] = [];
    const ctx = setup({ log: (m) => logs.push(m), deps: { sentinels: store } });
    ctx.recorder.subscribe((event) => { if (event.type === "failed" || event.type === "state") throw new Error("tray broke"); });
    const later: string[] = [];
    ctx.recorder.subscribe((event) => { later.push(event.type); });
    await startRecording(ctx);
    ctx.host.crash();
    await flush();
    expect(later).toContain("failed");
    expect(ctx.recorder.state.type).toBe("idle");
    expect(store.calls).toEqual(["write 2026-09-11 14-30-00.recording.mp4", "remove s1"]);
    expect(logs).toContainEqual("recorder: failed subscriber failed: tray broke");
  });

  it("removes a sentinel whose late writer opened after the opening deadline", async () => {
    const store = sentinels();
    let open!: (writer: FakeWriter) => void;
    const ctx = setup({ deps: { sentinels: store }, openWriter: () => new Promise((resolve) => { open = resolve; }) });
    ctx.recorder.toggle(); await flush();
    await vi.advanceTimersByTimeAsync(8000);
    expect(store.files.has("s1")).toBe(true);
    open(new FakeWriter(path.join("/out", "2026-09-11 14-30-00.recording.mp4"), path.join("/out", "2026-09-11 14-30-00.mp4")));
    await flush();
    expect(ctx.events.filter((event) => event.type === "failed")).toEqual([expect.objectContaining({ code: "output_open_failed" })]);
    expect(store.files.size).toBe(0);
    expect(await ctx.recorder.shutdown()).toBe(true);
  });

  it("logs a failed sentinel write once and still records", async () => {
    const store = sentinels({ fail: true });
    const log = vi.fn();
    let attempt = 0;
    const ctx: Ctx = setup({ log, deps: { sentinels: store }, openWriter: async (recordingPath, finalPath) => {
      if (++attempt === 1) throw Object.assign(new Error("exists"), { cause: { code: "EEXIST" } });
      const writer = new FakeWriter(recordingPath, finalPath);
      ctx.writers.push(writer);
      return writer;
    } });
    await startRecording(ctx);
    expect(ctx.host.started).toEqual(["s1"]);
    expect(ctx.recorder.state.type).toBe("recording");
    expect(store.calls.filter((call) => call.startsWith("write"))).toHaveLength(2);
    expect(log.mock.calls.filter(([message]) => String(message).includes("interruption sentinel not written: userData is read-only"))).toHaveLength(1);
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(ctx.events.filter((event) => event.type === "saved")).toHaveLength(1);
  });

  it("removes an earlier attempt's sentinel when the rewrite for the next name fails", async () => {
    const store = sentinels();
    let attempt = 0;
    const write = store.write;
    store.write = async (sentinel) => { if (attempt === 1) throw new Error("userData is read-only"); await write(sentinel); };
    const ctx: Ctx = setup({ deps: { sentinels: store }, openWriter: async (recordingPath, finalPath) => {
      if (++attempt === 1) throw Object.assign(new Error("exists"), { cause: { code: "EEXIST" } });
      const writer = new FakeWriter(recordingPath, finalPath);
      ctx.writers.push(writer);
      return writer;
    } });
    await startRecording(ctx);
    expect(ctx.recorder.state.type).toBe("recording");
    // The collided name belongs to another session's partial; no sentinel may name it for this one.
    expect(store.files.has("s1")).toBe(false);
    expect(store.calls).toEqual(["write 2026-09-11 14-30-00.recording.mp4", "remove s1"]);
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(ctx.events.filter((event) => event.type === "saved")).toHaveLength(1);
  });

  it("times the completion checkpoint in the finalize timing line", async () => {
    let clock = 0;
    const log = vi.fn();
    const store = sentinels({ complete: async () => { clock += 7; } });
    const ctx = setup({ log, deps: { sentinels: store, monotonic: () => clock } });
    await startRecording(ctx);
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(store.calls).toEqual(["write 2026-09-11 14-30-00.recording.mp4", "complete s1", "remove s1"]);
    expect(timingLine(log)).toContain(", checkpoint 7 ms; ");
  });

  it("times a failed checkpoint too, and still saves", async () => {
    let clock = 0;
    const log = vi.fn();
    const store = sentinels({ complete: async () => { clock += 3; throw new Error("EIO"); } });
    const ctx = setup({ log, deps: { sentinels: store, monotonic: () => clock } });
    await startRecording(ctx);
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(log).toHaveBeenCalledWith("recorder: completion checkpoint failed: EIO");
    expect(timingLine(log)).toContain(", checkpoint 3 ms; ");
    expect(ctx.events.filter((event) => event.type === "saved")).toHaveLength(1);
  });

  it("skips the checkpoint when the sentinel was never written", async () => {
    const log = vi.fn();
    const store = sentinels({ fail: true, complete: async () => undefined });
    const ctx = setup({ log, deps: { sentinels: store } });
    await startRecording(ctx);
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(store.calls).not.toContain("complete s1");
    expect(log.mock.calls.some(([message]) => String(message).includes("completion checkpoint failed"))).toBe(false);
    expect(timingLine(log)).toContain(", checkpoint ? ms; ");
    expect(ctx.events.filter((event) => event.type === "saved")).toHaveLength(1);
  });

  it("checkpoints when only an earlier attempt's write failed", async () => {
    const store = sentinels({ failWrites: 1, complete: async () => undefined });
    let attempt = 0;
    const ctx: Ctx = setup({ deps: { sentinels: store }, openWriter: async (recordingPath, finalPath) => {
      if (++attempt === 1) throw Object.assign(new Error("exists"), { cause: { code: "EEXIST" } });
      const writer = new FakeWriter(recordingPath, finalPath);
      ctx.writers.push(writer);
      return writer;
    } });
    await startRecording(ctx);
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(store.calls).toEqual([
      "write 2026-09-11 14-30-00.recording.mp4", "write 2026-09-11 14-30-00-2.recording.mp4", "complete s1", "remove s1",
    ]);
  });

  it("skips the checkpoint when a later attempt's write failed after an earlier one succeeded", async () => {
    let writes = 0;
    const store = { ...sentinels({ complete: async () => undefined }) };
    const write = store.write;
    store.write = async (sentinel) => { if (++writes === 2) { store.calls.push("write failed"); throw new Error("EIO"); } await write(sentinel); };
    let attempt = 0;
    const ctx: Ctx = setup({ deps: { sentinels: store }, openWriter: async (recordingPath, finalPath) => {
      if (++attempt === 1) throw Object.assign(new Error("exists"), { cause: { code: "EEXIST" } });
      const writer = new FakeWriter(recordingPath, finalPath);
      ctx.writers.push(writer);
      return writer;
    } });
    await startRecording(ctx);
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(store.calls).not.toContain("complete s1");
  });
});

/** Records each call with the fake clock's time; the dismissal settles when the test says. */
class FakePresenter implements CountdownPresenter {
  calls: Array<[string, number]> = [];
  dismissal: Promise<void> = Promise.resolve();
  fail: string | undefined;
  private note(call: string): void {
    this.calls.push([call, Date.now()]);
    if (this.fail === call.split(" ")[0]) throw new Error(`${call} broke`);
  }
  /** The presentation each `prepare` and `show` received (plan 046). */
  presentations: Array<[string, CountdownPresentation]> = [];
  prepare(presentation: CountdownPresentation): void { this.presentations.push(["prepare", presentation]); this.note("prepare"); }
  show(remaining: number, presentation: CountdownPresentation): void { this.presentations.push([`show ${remaining}`, presentation]); this.note(`show ${remaining}`); }
  update(remaining: number): void { this.note(`update ${remaining}`); }
  dismiss(): Promise<void> { this.note("dismiss"); return this.dismissal; }
  close(): void { this.note("close"); }
  names(): string[] { return this.calls.map(([call]) => call); }
}

describe("Recorder countdown (plan 040)", () => {
  const { tickMs, overlayLeadMs, dismissTimeoutMs } = COUNTDOWN_TIMING;

  function counting(seconds: 0 | 3 | 5 | 10 = 3, extra: Partial<RecorderDeps> = {}) {
    const presenter = new FakePresenter();
    const logs: string[] = [];
    const ctx = setup({ log: (m) => logs.push(m), deps: { countdownSeconds: () => seconds, countdown: presenter, monotonic: () => Date.now(), ...extra } });
    const recordedAt: number[] = [];
    const record = ctx.host.record.bind(ctx.host);
    ctx.host.record = (sessionId) => { recordedAt.push(Date.now()); record(sessionId); };
    const stateTimes: Array<[string, number]> = [];
    ctx.recorder.subscribe((event) => {
      if (event.type === "state") stateTimes.push([event.state.type === "countdown" ? `countdown ${event.state.remaining}` : event.state.type, Date.now()]);
    });
    /** Toggle and answer `prepared`; returns the anchor time. */
    const prepare = async (): Promise<number> => {
      ctx.recorder.toggle();
      await flush();
      await vi.advanceTimersByTimeAsync(40);
      const anchor = Date.now();
      ctx.host.emit(prepared("s1"));
      return anchor;
    };
    return { ...ctx, presenter, logs, recordedAt, stateTimes, prepare };
  }

  it("Off sends record at prepared and never shows a countdown or the overlay", async () => {
    const ctx = counting(0);
    await ctx.prepare();
    expect(ctx.host.recorded).toEqual(["s1"]);
    expect(ctx.states.map((state) => state.type)).toEqual(["starting", "recording"]);
    expect(ctx.presenter.calls).toEqual([]);
    expect(ctx.logs).toContainEqual(expect.stringContaining("record sent without a countdown"));
  });

  it("Off: Cancel recording after record was sent stops the capture once it starts", async () => {
    const ctx = counting(0);
    ctx.host.autoStart = false;
    await ctx.prepare();
    expect(ctx.host.recorded).toEqual(["s1"]);
    expect(ctx.recorder.state.type).toBe("starting");
    ctx.recorder.cancelCountdown("menu");
    ctx.recorder.cancelCountdown("menu");
    expect(ctx.host.stopped).toEqual([]);
    expect(ctx.logs.filter((line) => line.includes("cancel (menu) arrived after record was sent"))).toHaveLength(1);
    ctx.host.emit({ type: "started", sessionId: "s1" });
    expect(ctx.states.slice(-2).map((state) => state.type)).toEqual(["recording", "stopping"]);
    expect(ctx.host.stopped).toEqual(["s1"]);
  });

  it("ticks from one anchor, dismisses the overlay ahead of capture and records at N seconds", async () => {
    const ctx = counting(3);
    const anchor = await ctx.prepare();
    expect(ctx.recorder.state).toEqual({ type: "countdown", remaining: 3 });
    await vi.advanceTimersByTimeAsync(3 * tickMs);
    expect(ctx.stateTimes).toEqual([
      ["starting", anchor - 40],
      ["countdown 3", anchor],
      ["countdown 2", anchor + tickMs],
      ["countdown 1", anchor + 2 * tickMs],
      ["recording", anchor + 3 * tickMs],
    ]);
    expect(ctx.presenter.calls).toEqual([
      ["prepare", anchor - 40],
      ["show 3", anchor],
      ["update 2", anchor + tickMs],
      ["update 1", anchor + 2 * tickMs],
      ["dismiss", anchor + 3 * tickMs - overlayLeadMs],
      ["close", anchor + 3 * tickMs - overlayLeadMs],
    ]);
    expect(ctx.recordedAt).toEqual([anchor + 3 * tickMs]);
    expect(ctx.events.filter((event) => event.type === "captureStarted")).toHaveLength(1);
    expect(ctx.logs).toContainEqual(expect.stringContaining("prepared after 40 ms; countdown 3 s"));
    expect(ctx.logs).toContainEqual(expect.stringContaining("record sent 3000 ms after the 3 s countdown began"));
  });

  it("passes the session's sound snapshot to the overlay and logs it with the countdown (plan 046)", async () => {
    let sound = true;
    const ctx = counting(3, { countdownSound: () => sound });
    ctx.recorder.toggle();
    await flush();
    // A change after the session began affects the next recording only.
    sound = false;
    ctx.host.emit(prepared("s1"));
    expect(ctx.presenter.presentations).toEqual([["prepare", { sound: true }], ["show 3", { sound: true }]]);
    expect(ctx.logs).toContainEqual(expect.stringContaining("prepared after 0 ms; countdown 3 s; sound on"));
  });

  it("is silent without the dependency, when the switch is off and when the countdown is Off", async () => {
    const plain = counting(3);
    await plain.prepare();
    expect(plain.presenter.presentations).toEqual([["prepare", { sound: false }], ["show 3", { sound: false }]]);
    expect(plain.logs).toContainEqual(expect.stringContaining("countdown 3 s; sound off"));
    const off = counting(3, { countdownSound: () => false });
    await off.prepare();
    expect(off.presenter.presentations.map(([, p]) => p.sound)).toEqual([false, false]);
    const none = counting(0, { countdownSound: () => true });
    await none.prepare();
    expect(none.presenter.presentations).toEqual([]);
    expect(none.logs).toContainEqual(expect.stringContaining("countdown 0 s; sound off"));
  });

  it("starts from the tray's Start recording only when idle; a stale Start never stops or cancels (plan 048)", async () => {
    const ctx = counting(3);
    expect(ctx.recorder.startIfIdle()).toBe(true);
    await flush();
    await vi.advanceTimersByTimeAsync(40);
    ctx.host.emit(prepared("s1"));
    expect(ctx.recorder.state).toEqual({ type: "countdown", remaining: 3 });
    // A Start chosen from a menu opened before the countdown does nothing now.
    expect(ctx.recorder.startIfIdle()).toBe(false);
    expect(ctx.recorder.state).toEqual({ type: "countdown", remaining: 3 });
    await vi.advanceTimersByTimeAsync(3 * tickMs);
    expect(ctx.recorder.state.type).toBe("recording");
    expect(ctx.recorder.startIfIdle()).toBe(false);
    expect(ctx.recorder.state.type).toBe("recording");
    expect(ctx.host.stopped).toEqual([]);
  });

  it("counts ten seconds as two-digit values and keeps the snapshot taken at start", async () => {
    let seconds: 3 | 10 = 10;
    const ctx = counting(3, { countdownSeconds: () => seconds });
    ctx.recorder.toggle();
    seconds = 3;
    await flush();
    ctx.host.emit(prepared("s1"));
    expect(ctx.recorder.state).toEqual({ type: "countdown", remaining: 10 });
    await vi.advanceTimersByTimeAsync(9 * tickMs);
    expect(ctx.recorder.state).toEqual({ type: "countdown", remaining: 1 });
    expect(ctx.host.recorded).toEqual([]);
    await vi.advanceTimersByTimeAsync(tickMs);
    expect(ctx.host.recorded).toEqual(["s1"]);
  });

  it("waits for a dismissal that settles after N seconds", async () => {
    const ctx = counting(3);
    let settle!: () => void;
    ctx.presenter.dismissal = new Promise((resolve) => { settle = resolve; });
    const anchor = await ctx.prepare();
    await vi.advanceTimersByTimeAsync(3 * tickMs + 100);
    expect(ctx.host.recorded).toEqual([]);
    expect(ctx.recorder.state).toEqual({ type: "countdown", remaining: 1 });
    settle();
    await flush();
    expect(ctx.recordedAt).toEqual([anchor + 3 * tickMs + 100]);
  });

  it("destroys an overlay that never confirms, logs it and records at the bound", async () => {
    const ctx = counting(3);
    ctx.presenter.dismissal = new Promise(() => undefined);
    const anchor = await ctx.prepare();
    const bound = anchor + 3 * tickMs - overlayLeadMs + dismissTimeoutMs;
    await vi.advanceTimersByTimeAsync(bound - Date.now() - 1);
    expect(ctx.host.recorded).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.recordedAt).toEqual([bound]);
    expect(ctx.presenter.calls.at(-1)).toEqual(["close", bound]);
    expect(ctx.logs).toContainEqual(expect.stringContaining(`did not confirm dismissal within ${dismissTimeoutMs} ms`));
  });

  it("logs presenter errors and still records: the tray carries the countdown", async () => {
    const ctx = counting(3);
    ctx.presenter.fail = "show";
    await ctx.prepare();
    expect(ctx.recorder.state).toEqual({ type: "countdown", remaining: 3 });
    await vi.advanceTimersByTimeAsync(3 * tickMs);
    expect(ctx.recorder.state.type).toBe("recording");
    expect(ctx.logs).toContainEqual(expect.stringContaining("countdown overlay show failed: show 3 broke"));
    expect(ctx.events.some((event) => event.type === "failed")).toBe(false);
  });

  describe("cancel before record", () => {
    const cases: Array<[string, "toggle" | "menu" | "quit" | "sleep", (recorder: Recorder) => unknown]> = [
      ["a second click or the shortcut", "toggle", (recorder) => recorder.toggle()],
      ["Cancel recording", "menu", (recorder) => recorder.cancelCountdown("menu")],
      ["Quit", "quit", (recorder) => recorder.shutdown()],
      ["the Mac going to sleep (plan 050)", "sleep", (recorder) => recorder.systemWillSleep()],
    ];
    for (const [name, reason, act] of cases) {
      it(`${name} returns to idle with no failure, file or later record`, async () => {
        const ctx = counting(3);
        // One saved recording first, so the cancel returns to the idle a save left.
        ctx.recorder.toggle();
        await flush();
        ctx.host.emit(prepared("s1"));
        await vi.advanceTimersByTimeAsync(3 * tickMs);
        ctx.host.emit(chunk("s1", 0));
        ctx.recorder.stop();
        ctx.host.emit({ type: "stopped", sessionId: "s1" });
        await flush();
        expect(ctx.recorder.state).toEqual({ type: "idle" });
        const before = ctx.events.length;
        ctx.presenter.calls = [];

        ctx.recorder.toggle();
        await flush();
        ctx.host.emit(prepared("s1"));
        await vi.advanceTimersByTimeAsync(1500);
        expect(ctx.recorder.state).toEqual({ type: "countdown", remaining: 2 });
        const quit = act(ctx.recorder);
        await flush();
        expect(ctx.recorder.state).toEqual({ type: "idle" });
        if (quit instanceof Promise) expect(await quit).toBe(true);
        expect(ctx.host.stopped.at(-1)).toBe("s1");
        expect(ctx.writers[1]!.abandoned).toBe(true);
        expect(ctx.writers[1]!.finished).toBe(false);
        expect(ctx.presenter.names()).toEqual(["prepare", "show 3", "update 2", "close"]);
        const after = ctx.events.slice(before);
        expect(after.filter((event) => event.type !== "state")).toEqual([{ type: "cancelled", reason, session: traced() }]);
        expect(ctx.logs).toContainEqual(expect.stringContaining(`cancelled (${reason}) while counting down`));
        // Its timers are gone: nothing records or ticks later.
        await vi.advanceTimersByTimeAsync(20_000);
        expect(ctx.host.recorded).toEqual(["s1"]);
        expect(ctx.recorder.state).toEqual({ type: "idle" });
      });
    }

    it("ignores repeated toggles but permits explicit preparation cancellation", async () => {
      const ctx = counting(3);
      ctx.recorder.toggle();
      await flush();
      ctx.recorder.toggle();
      ctx.recorder.cancelCountdown("menu");
      await flush();
      expect(ctx.recorder.state.type).toBe("idle");
      expect(ctx.host.stopped).toEqual(["s1"]);
    });
  });

  it("a Cancel recording from a menu opened during the countdown stops a capture that already began", async () => {
    const ctx = counting(3);
    await ctx.prepare();
    await vi.advanceTimersByTimeAsync(3 * tickMs);
    expect(ctx.recorder.state.type).toBe("recording");
    ctx.recorder.cancelCountdown("menu");
    expect(ctx.recorder.state.type).toBe("stopping");
    expect(ctx.host.stopped).toEqual(["s1"]);
    expect(ctx.logs).toContainEqual(expect.stringContaining("Cancel recording arrived after capture started"));
    ctx.host.emit(chunk("s1", 0));
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    // Nothing is discarded: the short recording is saved, not cancelled.
    expect(ctx.events.filter((event) => event.type === "saved")).toHaveLength(1);
    expect(ctx.events.some((event) => event.type === "cancelled" || event.type === "failed")).toBe(false);
    // Outside a recording a late Cancel recording does nothing.
    ctx.recorder.cancelCountdown("menu");
    expect(ctx.recorder.state.type).toBe("idle");
    expect(ctx.host.stopped).toEqual(["s1"]);
  });

  it("after record was sent, a toggle stops the capture once it starts", async () => {
    const ctx = counting(3);
    ctx.host.autoStart = false;
    await ctx.prepare();
    await vi.advanceTimersByTimeAsync(3 * tickMs);
    expect(ctx.host.recorded).toEqual(["s1"]);
    expect(ctx.recorder.state).toEqual({ type: "countdown", remaining: 1 });
    ctx.recorder.toggle();
    expect(ctx.recorder.state).toEqual({ type: "countdown", remaining: 1 });
    expect(ctx.host.stopped).toEqual([]);
    ctx.host.emit({ type: "started", sessionId: "s1" });
    expect(ctx.states.slice(-2).map((state) => state.type)).toEqual(["recording", "stopping"]);
    expect(ctx.host.stopped).toEqual(["s1"]);
  });

  describe("the Mac going to sleep (plan 050)", () => {
    it("stops and saves a recording with the sleep reason instead of failing it", async () => {
      const ctx = counting(0);
      await ctx.prepare();
      ctx.host.emit(chunk("s1", 0));
      ctx.recorder.systemWillSleep();
      expect(ctx.recorder.state).toEqual({ type: "stopping" });
      expect(ctx.host.stopped).toEqual(["s1"]);
      expect(ctx.logs).toContainEqual(expect.stringContaining("the Mac is going to sleep; stopped to save the recording"));
      ctx.host.emit(chunk("s1", 1));
      ctx.host.emit({ type: "stopped", sessionId: "s1" });
      await flush();
      expect(ctx.events.filter((event) => event.type === "saved")).toEqual([
        { type: "saved", path: path.join("/out", "2026-09-11 14-30-00.mp4"), stoppedEarly: "sleep", session: traced() },
      ]);
      expect(ctx.events.some((event) => event.type === "failed" || event.type === "failureStatus")).toBe(false);
      expect(ctx.logs).toContainEqual(expect.stringContaining(`file finalized ${path.join("/out", "2026-09-11 14-30-00.mp4")} (stopped early: the Mac went to sleep)`));
    });

    it("sends the stop to the host before the stopping state reaches subscribers (review pass 1)", async () => {
      const ctx = counting(0);
      await ctx.prepare();
      ctx.host.emit(chunk("s1", 0));
      const stoppedAtPublish: string[][] = [];
      ctx.recorder.subscribe((event) => { if (event.type === "state" && event.state.type === "stopping") stoppedAtPublish.push([...ctx.host.stopped]); });
      ctx.recorder.systemWillSleep();
      expect(stoppedAtPublish).toEqual([["s1"]]);
    });

    it("after record was sent, stops the capture once it starts and saves it with the sleep reason", async () => {
      const ctx = counting(3);
      ctx.host.autoStart = false;
      await ctx.prepare();
      await vi.advanceTimersByTimeAsync(3 * tickMs);
      expect(ctx.host.recorded).toEqual(["s1"]);
      ctx.recorder.systemWillSleep();
      expect(ctx.host.stopped).toEqual([]);
      ctx.host.emit({ type: "started", sessionId: "s1" });
      expect(ctx.states.slice(-2).map((state) => state.type)).toEqual(["recording", "stopping"]);
      ctx.host.emit(chunk("s1", 0));
      ctx.host.emit({ type: "stopped", sessionId: "s1" });
      await flush();
      expect(ctx.events.filter((event) => event.type === "saved").map((event) => event.type === "saved" && event.stoppedEarly)).toEqual(["sleep"]);
    });

    it("cancels an attempt still preparing once prepared arrives, with the sleep reason", async () => {
      const ctx = counting(3);
      ctx.recorder.toggle();
      await flush();
      ctx.recorder.systemWillSleep();
      expect(ctx.recorder.state.type).toBe("starting");
      ctx.host.emit(prepared("s1"));
      await flush();
      expect(ctx.recorder.state.type).toBe("idle");
      expect(ctx.host.recorded).toEqual([]);
      expect(ctx.events.filter((event) => event.type === "cancelled")).toEqual([{ type: "cancelled", reason: "sleep", session: traced() }]);
      expect(ctx.events.some((event) => event.type === "failed" || event.type === "saved")).toBe(false);
    });

    it("cancels, not fails, an attempt still preparing whose tracks end on the way to sleep", async () => {
      for (const code of ["capture_start_failed", "no_audio_track"] as const) {
        const ctx = counting(3);
        ctx.recorder.toggle();
        await flush();
        ctx.recorder.systemWillSleep();
        ctx.host.emit({ type: "error", sessionId: "s1", code, detail: "capture track ended while applying quality settings", displayFailure: "track_ended" });
        await flush();
        expect(ctx.recorder.state.type).toBe("idle");
        expect(ctx.host.recorded).toEqual([]);
        expect(ctx.events.filter((event) => event.type === "cancelled")).toEqual([{ type: "cancelled", reason: "sleep", session: traced() }]);
        expect(ctx.events.some((event) => event.type === "failed" || event.type === "failureStatus" || event.type === "displayFailed")).toBe(false);
        expect(ctx.logs).toContainEqual(expect.stringContaining(`host reported ${code} after cancel (sleep) was requested`));
      }
    });

    // Quit cancels at once (plan 065) and never waits for these; sleep still does.
    it("cancels, not fails, a marked attempt that times out, loses its host or its display before prepared", async () => {
      const reason = "sleep";
      const triggers: Array<[string, (ctx: ReturnType<typeof counting>) => Promise<unknown> | void, string]> = [
        ["capture request timeout", () => vi.advanceTimersByTimeAsync(8000), "capture request timed out"],
        ["host crash", (ctx) => ctx.host.crash(), "capture_host_crashed after cancel (sleep) was requested: killed"],
        ["unresponsive host", (ctx) => ctx.host.hang(), "capture_host_unresponsive"],
        ["display removal", (ctx) => ctx.recorder.displayRemoved(), "recording display removed"],
      ];
      for (const [name, trigger, logged] of triggers) {
        const ctx = counting(3);
        ctx.recorder.toggle();
        await flush();
        ctx.recorder.systemWillSleep();
        await trigger(ctx);
        await flush();
        expect(ctx.recorder.state.type, name).toBe("idle");
        expect(ctx.host.recorded, name).toEqual([]);
        expect(ctx.events.filter((event) => event.type === "cancelled"), name).toEqual([{ type: "cancelled", reason, session: traced() }]);
        expect(ctx.events.some((event) => event.type === "failed" || event.type === "failureStatus" || event.type === "displayFailed"), name).toBe(false);
        expect(ctx.logs, name).toContainEqual(expect.stringContaining(logged));
      }
    });

    it("still fails an unmarked attempt whose capture request times out", async () => {
      const ctx = counting(3);
      ctx.recorder.toggle();
      await flush();
      await vi.advanceTimersByTimeAsync(8000);
      expect(ctx.events.filter((event) => event.type === "failed").map((event) => event.type === "failed" && event.code)).toEqual(["capture_start_failed"]);
    });

    it("does nothing while saving or without a session", async () => {
      const ctx = counting(0);
      ctx.recorder.systemWillSleep();
      expect(ctx.recorder.state.type).toBe("idle");
      await ctx.prepare();
      ctx.host.emit(chunk("s1", 0));
      ctx.recorder.stop();
      ctx.recorder.systemWillSleep();
      expect(ctx.host.stopped).toEqual(["s1"]);
      ctx.host.emit({ type: "stopped", sessionId: "s1" });
      await flush();
      expect(ctx.events.filter((event) => event.type === "saved").map((event) => event.type === "saved" && event.stoppedEarly)).toEqual([undefined]);
    });
  });

  describe("failures before capture are start failures with an empty outcome", () => {
    async function failing(act: (ctx: ReturnType<typeof counting>) => void | Promise<void>) {
      const ctx = counting(3);
      await ctx.prepare();
      await vi.advanceTimersByTimeAsync(1200);
      await act(ctx);
      await flush();
      const failed = ctx.events.find((event) => event.type === "failed");
      expect(ctx.recorder.state).toEqual({ type: "idle" });
      expect(ctx.presenter.names().at(-1)).toBe("close");
      expect(ctx.host.recorded).toEqual([]);
      return { ctx, failed };
    }

    it("a crashed host", async () => {
      const { failed } = await failing((ctx) => ctx.host.crash());
      expect(failed).toMatchObject({ code: "capture_start_failed", detail: "capture host crashed: killed (while counting down)", outcome: "empty" });
    });

    it("an unresponsive host", async () => {
      const { failed } = await failing((ctx) => ctx.host.hang());
      expect(failed).toMatchObject({ code: "capture_start_failed", detail: expect.stringContaining("stopped responding"), outcome: "empty" });
    });

    it("a track that ended, keeping the display diagnostic", async () => {
      const { ctx, failed } = await failing((ctx) => ctx.host.emit({ type: "error", sessionId: "s1", code: "capture_failed", detail: "ended", displayFailure: "track_ended" }));
      expect(ctx.events).toContainEqual({ type: "displayFailed", detail: "track_ended" });
      expect(failed).toMatchObject({ code: "capture_start_failed", detail: "ended (while counting down)", outcome: "empty" });
    });

    it("a removed display, keeping the display diagnostic", async () => {
      const { ctx, failed } = await failing((ctx) => ctx.recorder.displayRemoved());
      expect(ctx.events).toContainEqual({ type: "displayFailed", detail: "target_removed" });
      expect(failed).toMatchObject({ code: "capture_start_failed", detail: "recording display removed (while counting down)" });
    });

    it("a refused record", async () => {
      const ctx = counting(3);
      ctx.host.recordError = new Error("capture host is not running this session");
      await ctx.prepare();
      await vi.advanceTimersByTimeAsync(3 * tickMs);
      expect(ctx.events.find((event) => event.type === "failed")).toMatchObject({
        code: "capture_start_failed", detail: "record refused: capture host is not running this session (while starting capture)", outcome: "empty" });
    });

    it("a host that refuses record by message", async () => {
      const ctx = counting(0);
      ctx.host.autoStart = false;
      await ctx.prepare();
      ctx.host.emit({ type: "error", sessionId: "s1", code: "capture_start_failed", detail: "record refused: this session is not prepared" });
      await flush();
      expect(ctx.events.find((event) => event.type === "failed")).toMatchObject({
        code: "capture_start_failed", detail: "record refused: this session is not prepared (while starting capture)" });
    });

    it("a record that times out after the start deadline", async () => {
      const ctx = counting(3);
      ctx.host.autoStart = false;
      await ctx.prepare();
      await vi.advanceTimersByTimeAsync(3 * tickMs + 7999);
      expect(ctx.recorder.state).toEqual({ type: "countdown", remaining: 1 });
      await vi.advanceTimersByTimeAsync(1);
      expect(ctx.events.find((event) => event.type === "failed")).toMatchObject({
        code: "capture_start_failed", detail: expect.stringContaining("did not confirm recording started"), outcome: "empty" });
    });

    it("a permission refusal while preparing keeps its code and closes the prepared overlay", async () => {
      const ctx = counting(3);
      ctx.recorder.toggle();
      await flush();
      ctx.host.emit({ type: "error", sessionId: "s1", code: "permission_denied", detail: "NotAllowedError" });
      await flush();
      expect(ctx.events.find((event) => event.type === "failed")).toMatchObject({ code: "permission_denied", detail: "NotAllowedError" });
      expect(ctx.presenter.names()).toEqual(["prepare", "close"]);
    });
  });

  it("stops the host for a stale prepared or started", async () => {
    const ctx = counting(3);
    ctx.recorder.toggle();
    await flush();
    ctx.host.emit(prepared("old"));
    ctx.host.emit({ type: "started", sessionId: "older" });
    expect(ctx.host.stopped).toEqual(["old", "older"]);
    expect(ctx.recorder.state.type).toBe("starting");
  });

  it("ignores a duplicate prepared and an early started", async () => {
    const ctx = counting(3);
    ctx.host.autoStart = false;
    ctx.recorder.toggle();
    await flush();
    ctx.host.emit({ type: "started", sessionId: "s1" });
    expect(ctx.recorder.state.type).toBe("starting");
    ctx.host.emit(prepared("s1"));
    ctx.host.emit(prepared("s1"));
    expect(ctx.presenter.names()).toEqual(["prepare", "show 3"]);
  });
});

describe("no timer outlives a settled session (plan 049)", () => {
  // Idle must not wake the app: every deadline, tick and bound belongs to one session and ends with it.
  it("after a saved recording", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1", tracksStoppedAt: Date.now() });
    await flush();
    expect(ctx.events.at(-1)?.type).toBe("saved");
    expect(ctx.recorder.state.type).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("after a failed recording", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.host.emit({ type: "error", sessionId: "s1", code: "capture_failed", detail: "video ended" });
    await flush();
    expect(ctx.events.some((event) => event.type === "failed")).toBe(true);
    expect(ctx.recorder.state.type).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("after a start that failed before capture, and after a countdown was cancelled", async () => {
    const failing = setup();
    failing.recorder.toggle();
    await flush();
    failing.host.emit({ type: "error", sessionId: "s1", code: "capture_start_failed", detail: "refused" });
    await flush();
    expect(failing.recorder.state.type).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);

    const presenter = { show: vi.fn(), update: vi.fn(), dismiss: vi.fn(async () => undefined), close: vi.fn() };
    const counting = setup({ deps: { countdownSeconds: () => 3, countdown: presenter } });
    counting.recorder.toggle();
    await flush();
    counting.host.emit(prepared("s1"));
    expect(counting.recorder.state).toEqual({ type: "countdown", remaining: 3 });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    counting.recorder.toggle();
    await flush();
    expect(counting.recorder.state.type).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);
  });
});
