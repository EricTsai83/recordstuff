import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileWriter, NO_MEDIA_DETAIL, nodeFs } from "./file-writer";
import { SavedNotification, SAVED_NOTIFICATION_DELAY_MS } from "./saved-notification";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostMessage } from "../shared/protocol";
import { DEFAULT_QUALITY, type CaptureReport, type QualitySettings } from "../shared/quality";
import type { RecordingState } from "../shared/state";
import type { RecordingFailure } from "../shared/recording-result";
import { Recorder, formatTimestamp, type CountdownPresenter, type RecorderDeps, type RecorderEvent, type RecorderHost, type RecorderWriter } from "./recorder";
import { COUNTDOWN_TIMING } from "../shared/countdown";
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

  async start(sessionId: string, quality: QualitySettings): Promise<void> {
    if (this.startError) throw this.startError;
    this.started.push(sessionId);
    this.startedWith.push(quality);
  }
  record(sessionId: string): void {
    if (this.recordError) throw this.recordError;
    this.recorded.push(sessionId);
    if (this.autoStart) this.emit({ type: "started", sessionId });
  }
  stop(sessionId: string): void {
    this.stopped.push(sessionId);
  }
  onMessage(listener: (m: HostMessage) => void): void {
    this.messageListener = listener;
  }
  onFailure(listener: (code: "capture_host_crashed" | "capture_host_unresponsive", detail: string) => void): void {
    this.failureListener = listener;
  }
  emit(message: HostMessage): void {
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
  chunks: Uint8Array[] = [];
  finished = false;
  abandoned = false;
  appendError: Error | undefined;
  finishError: Error | undefined;
  constructor(
    readonly recordingPath: string,
    readonly finalPath: string,
  ) {}
  async append(bytes: Uint8Array): Promise<void> {
    if (this.appendError) throw this.appendError;
    this.chunks.push(bytes);
  }
  async finish(): Promise<string> {
    if (this.finishError) throw this.finishError;
    this.finished = true;
    return this.finalPath;
  }
  async abandon(): Promise<string | undefined> {
    this.abandoned = true;
    return this.chunks.length > 0 ? this.recordingPath : undefined;
  }
}

/** Terminal events name their session (plan 029); most assertions here are about the outcome itself. */
const traced = (id = "s1") => expect.objectContaining({ id });

function chunk(sessionId: string, seq: number, size = 4): HostMessage {
  return { type: "chunk", sessionId, seq, bytes: new ArrayBuffer(size) };
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

describe("formatTimestamp", () => {
  it("uses the local time with dashes only", () => {
    expect(formatTimestamp(new Date(2026, 8, 11, 14, 30, 5))).toBe("2026-09-11 14-30-05");
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

  it("idle → starting → recording → stopping → idle with lastSavedPath", async () => {
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
    expect(writer.chunks).toHaveLength(3);
    expect(writer.finished).toBe(true);
    expect(writer.recordingPath).toBe("/out/2026-09-11 14-30-00.recording.mp4");
    expect(ctx.recorder.state).toEqual({ type: "idle", lastSavedPath: "/out/2026-09-11 14-30-00.mp4" });
    expect(ctx.events.at(-1)).toEqual({ type: "saved", path: "/out/2026-09-11 14-30-00.mp4", session: {
      id: "s1", recordingPath: "/out/2026-09-11 14-30-00.recording.mp4",
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
        return new FakeWriter("/out/a.recording.mp4", "/out/a.mp4");
      },
    });
    ctx.recorder.toggle();
    await flush();
    expect(order).toEqual(["ensure", "open"]);
  });
});

describe("Recorder ignores illegal transitions", () => {
  it("ignores clicks while starting and stopping", async () => {
    const ctx = setup();
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
    expect(ctx.writers[0]!.chunks).toHaveLength(1);
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
      partialPath: "/out/2026-09-11 14-30-00.recording.mp4",
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

  it("host.start rejection → capture_start_failed", async () => {
    const ctx = setup();
    ctx.host.startError = new Error("no renderer");
    ctx.recorder.toggle();
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(ctx.events.at(-1)).toEqual({ type: "failed", code: "capture_start_failed", detail: "no renderer", outcome: "empty",
      session: { id: "s1", recordingPath: "/out/2026-09-11 14-30-00.recording.mp4" } });
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
      partialPath: "/out/2026-09-11 14-30-00.recording.mp4",
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

  it("write error → disk_full from the writer's code", async () => {
    const ctx = setup();
    await startRecording(ctx);
    const writer = ctx.writers[0]!;
    writer.appendError = Object.assign(new Error("ENOSPC"), { code: "disk_full" });
    ctx.host.emit(chunk("s1", 1));
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

  it("a chunk gap is a failure, never silent data loss", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.host.emit(chunk("s1", 2));
    await flush();
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "capture_failed" });
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
  it("stops a session it no longer owns when the host reports started/chunk for it", async () => {
    const ctx = setup();
    ctx.recorder.toggle();
    await flush();
    // start timeout fires while the host is still inside getDisplayMedia
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
    expect(ctx.events.at(-1)).toMatchObject({ type: "failureStatus", result: { code: "output_open_failed", outcome: "pending" } });
    expect(ctx.host.started).toEqual([]);
  });

  it("a writer opened after the deadline is abandoned, not used", async () => {
    let resolveOpen: ((w: FakeWriter) => void) | undefined;
    const late = new FakeWriter("/out/late.recording.mp4", "/out/late.mp4");
    const ctx = setup({ openWriter: () => new Promise((r) => (resolveOpen = r)) });
    ctx.recorder.toggle();
    await vi.advanceTimersByTimeAsync(8000);
    expect(ctx.recorder.state).toEqual({ type: "idle", outputDirUnavailable: true });
    resolveOpen!(late);
    await flush();
    expect(late.abandoned).toBe(true);
    expect(ctx.host.started).toEqual([]);
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
    expect(ctx.recorder.state.type).toBe("stopping");
    expect(ctx.events.some((e) => e.type === "failed")).toBe(false);
    releaseFinish!();
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "idle", lastSavedPath: writer.finalPath });
    expect(ctx.events.at(-1)).toEqual({ type: "saved", path: writer.finalPath, session: traced() });
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
    expect(opened).toEqual(["/out/2026-09-11 14-30-00.recording.mp4", "/out/2026-09-11 14-30-00-2.recording.mp4"]);
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
  const SAVED = "/out/2026-09-11 14-30-00.mp4";
  const saveRecording = async (ctx: ReturnType<typeof setup>): Promise<void> => {
    if (ctx.recorder.state.type === "recording") ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
  };

  it("a revoke during recording settles the save into needsPermission and keeps the file discoverable", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.recorder.setPermission({ granted: false, needsRelaunch: false });
    await saveRecording(ctx);
    expect(ctx.recorder.state).toEqual({ type: "needsPermission", needsRelaunch: false, lastSavedPath: SAVED });
    expect(ctx.events.at(-1)).toEqual({ type: "saved", path: SAVED, session: traced() });
    ctx.recorder.toggle();
    expect(ctx.events.at(-1)).toEqual({ type: "permissionRequested", needsRelaunch: false });
    expect(ctx.host.started).toEqual(["s1"]);
    ctx.recorder.setPermission({ granted: true, needsRelaunch: false });
    expect(ctx.recorder.state).toEqual({ type: "idle", lastSavedPath: SAVED });
  });

  it("a revoke during stopping settles into the latest needsRelaunch", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.recorder.stop();
    ctx.recorder.setPermission({ granted: false, needsRelaunch: true });
    expect(ctx.recorder.state.type).toBe("stopping");
    await saveRecording(ctx);
    expect(ctx.recorder.state).toEqual({ type: "needsPermission", needsRelaunch: true, lastSavedPath: SAVED });
  });

  it("a capture failure after a revoke settles into needsPermission and still reports the failure", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.recorder.setPermission({ granted: false, needsRelaunch: false });
    ctx.host.crash();
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "needsPermission", needsRelaunch: false });
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "capture_host_crashed", partialPath: "/out/2026-09-11 14-30-00.recording.mp4" });
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
    expect(ctx.recorder.state).toEqual({ type: "idle", lastSavedPath: SAVED });
    expect(ctx.states.map((s) => s.type)).toEqual(["starting", "recording", "stopping", "idle"]);
  });

  it("needsRelaunch transitions after a save keep its path until the grant returns", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.recorder.setPermission({ granted: false, needsRelaunch: true });
    await saveRecording(ctx);
    ctx.recorder.setPermission({ granted: false, needsRelaunch: false });
    ctx.recorder.setPermission({ granted: false, needsRelaunch: false });
    expect(ctx.recorder.state).toEqual({ type: "needsPermission", needsRelaunch: false, lastSavedPath: SAVED });
    ctx.recorder.setPermission({ granted: true, needsRelaunch: false });
    expect(ctx.recorder.state).toEqual({ type: "idle", lastSavedPath: SAVED });
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

  it("cancels an attempt still preparing when prepared arrives: no media existed, so nothing records or fails", async () => {
    const ctx = setup({ deps: { countdownSeconds: () => 3 } });
    ctx.recorder.toggle();
    await flush();
    const shutdown = ctx.recorder.shutdown();
    await flush();
    expect(ctx.recorder.state.type).toBe("starting");
    ctx.host.emit(prepared("s1"));
    await flush();
    expect(await shutdown).toBe(true);
    expect(ctx.host.recorded).toEqual([]);
    expect(ctx.host.stopped).toEqual(["s1"]);
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
    ctx.host.emit(prepared("s1"));
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

  it("cancels at prepared with the countdown Off too", async () => {
    const ctx = setup();
    ctx.recorder.toggle();
    await flush();
    const shutdown = ctx.recorder.shutdown();
    ctx.host.emit(prepared("s1"));
    await flush();
    expect(await shutdown).toBe(true);
    expect(ctx.host.recorded).toEqual([]);
    expect(ctx.events.map((event) => event.type)).not.toContain("captureStarted");
    expect(ctx.events.filter((event) => event.type === "cancelled")).toHaveLength(1);
  });

  it("cancels during opening without asking for capture at all", async () => {
    let open!: () => void;
    const ctx = setup({ ensureWritableDir: () => new Promise<void>((resolve) => { open = resolve; }) });
    ctx.recorder.toggle();
    await flush();
    const shutdown = ctx.recorder.shutdown();
    open();
    await flush();
    expect(await shutdown).toBe(true);
    expect(ctx.host.started).toEqual([]);
    expect(ctx.host.stopped).toEqual([]);
    expect(ctx.writers[0]!.abandoned).toBe(true);
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


describe("Recorder with real FileWriter", () => {
  it.each(["ENOSPC", "EIO", "zero"])("reports partial first-chunk failure (%s), closes, and records again", async (fault) => {
    vi.useRealTimers();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordstuff-recorder-"));
    const host = new FakeHost();
    const events: RecorderEvent[] = [];
    const writers: FileWriter[] = [];
    const closed: string[] = [];
    let session = 0;
    const recorder = new Recorder({
      host, outputDir: () => dir, quality: () => DEFAULT_QUALITY,
      ensureWritableDir: async () => undefined,
      now: () => new Date(2026, 8, 24, 12, 0, 0),
      newSessionId: () => `real-${++session}`,
      openWriter: async (recordingPath, finalPath) => {
        const injectFailure = session === 1;
        const writer = await FileWriter.open(recordingPath, finalPath, {
          io: {
            ...nodeFs,
            open: async (file, flags) => {
              const handle = await nodeFs.open(file, flags);
              let calls = 0;
              return {
                sync: () => handle.sync(),
                close: async () => { await handle.close(); closed.push(file); },
                write: async (data) => {
                  calls += 1;
                  if (injectFailure && calls > 1) {
                    if (fault === "zero") return { bytesWritten: 0 };
                    throw Object.assign(new Error(fault), { code: fault });
                  }
                  return handle.write(data.subarray(0, 2));
                },
              };
            },
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
      host.emit({ type: "chunk", sessionId: "real-1", seq: 0, bytes: new Uint8Array([1, 2, 3, 4]).buffer });
      // A stop arriving while the append is pending must not publish success.
      recorder.stop();
      host.emit({ type: "stopped", sessionId: "real-1" });
      await vi.waitFor(() => expect(events.filter((event) => event.type === "failed")).toHaveLength(1));
      const first = writers[0]!;
      expect(events.filter((event) => event.type === "failed")).toEqual([expect.objectContaining({
        code: fault === "ENOSPC" ? "disk_full" : "output_write_failed", partialPath: first.recordingPath,
      })]);
      expect(events.filter((event) => event.type === "saved")).toHaveLength(0);
      expect(first.bytesWritten).toBe(2);
      expect(closed).toEqual([first.recordingPath]);
      expect(await fs.readFile(first.recordingPath)).toEqual(Buffer.from([1, 2]));
      await expect(fs.stat(first.finalPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(recorder.state.type).toBe("idle");

      recorder.toggle();
      await vi.waitFor(() => expect(host.started).toEqual(["real-1", "real-2"]));
      host.emit(prepared("real-2"));
      host.emit({ type: "chunk", sessionId: "real-2", seq: 0, bytes: new Uint8Array([5, 6, 7, 8, 9]).buffer });
      recorder.stop();
      host.emit({ type: "stopped", sessionId: "real-2" });
      await vi.waitFor(() => expect(events.filter((event) => event.type === "saved")).toHaveLength(1));
      const saved = events.find((event) => event.type === "saved");
      expect(saved?.type).toBe("saved");
      if (saved?.type !== "saved") throw new Error("Missing saved event");
      expect(await fs.readFile(saved.path)).toEqual(Buffer.from([5, 6, 7, 8, 9]));
      expect(writers[1]!.bytesWritten).toBe(5);
      expect(closed).toEqual(writers.map((writer) => writer.recordingPath));
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

describe("Recorder rejects zero-byte output with real FileWriter", () => {
  async function real(options: {
    beforeWrite?: () => Promise<void>; syncError?: string; publishFailure?: (result: RecordingFailure) => Promise<void>;
    /** Replaces the sync; overrides `syncError`. */
    sync?: () => Promise<void>; backlogLimitBytes?: number; deps?: Partial<RecorderDeps>;
  } = {}) {
    vi.useRealTimers();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordstuff-empty-"));
    const host = new FakeHost();
    const events: RecorderEvent[] = [];
    const closed: string[] = [];
    const syncs: string[] = [];
    let session = 0;
    const recorder = new Recorder({
      host, outputDir: () => dir, quality: () => DEFAULT_QUALITY,
      ensureWritableDir: async () => undefined,
      now: () => new Date(2026, 8, 25, 12, 0, 0),
      newSessionId: () => `empty-${++session}`,
      ...(options.publishFailure ? { publishFailure: options.publishFailure } : {}),
      openWriter: (recordingPath, finalPath) => FileWriter.open(recordingPath, finalPath, {
        ...(options.syncError || options.sync ? { fsyncIntervalMs: 5 } : {}),
        ...(options.backlogLimitBytes ? { backlogLimitBytes: options.backlogLimitBytes } : {}),
        io: { ...nodeFs,
          open: async (file, flags) => {
            const handle = await nodeFs.open(file, flags);
            return {
              sync: async () => {
                syncs.push(file);
                if (options.sync) return options.sync();
                if (options.syncError) throw Object.assign(new Error(options.syncError), { code: options.syncError });
                await handle.sync();
              },
              close: async () => { await handle.close(); closed.push(file); },
              write: async (data) => { await options.beforeWrite?.(); return handle.write(data); },
            };
          },
        },
      }),
      ...options.deps,
    });
    recorder.subscribe((event) => events.push(event));
    const begin = async (id: string): Promise<void> => {
      recorder.toggle();
      await vi.waitFor(() => expect(host.started).toContain(id));
      host.emit(prepared(id));
    };
    const of = <T extends RecorderEvent["type"]>(type: T) =>
      events.filter((event): event is Extract<RecorderEvent, { type: T }> => event.type === type);
    const cleanup = async (): Promise<void> => {
      await recorder.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
    };
    return { dir, host, recorder, closed, syncs, begin, of, cleanup };
  }
  const media = (sessionId: string, seq: number, ...values: number[]): HostMessage =>
    ({ type: "chunk", sessionId, seq, bytes: new Uint8Array(values).buffer });

  it.each([["no chunks", 0], ["only empty chunks", 2]] as const)(
    "fails a stop with %s as capture_start_failed, removes the empty file and records again",
    async (_label, empty) => {
      const ctx = await real();
      try {
        await ctx.begin("empty-1");
        for (let seq = 0; seq < empty; seq++) ctx.host.emit(media("empty-1", seq));
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
        expect(ctx.closed).toHaveLength(1);
        expect(await fs.readdir(ctx.dir)).toEqual([]);

        // Immediate retry; its only nonempty chunk arrives right before stopped.
        await ctx.begin("empty-2");
        ctx.recorder.stop();
        ctx.host.emit(media("empty-2", 0, 5, 6, 7));
        ctx.host.emit({ type: "stopped", sessionId: "empty-2" });
        await vi.waitFor(() => expect(ctx.of("saved")).toHaveLength(1));
        const saved = ctx.of("saved")[0]!.path;
        expect(await fs.readFile(saved)).toEqual(Buffer.from([5, 6, 7]));
        expect(await fs.readdir(ctx.dir)).toEqual([path.basename(saved)]);
        expect(ctx.recorder.state).toEqual({ type: "idle", lastSavedPath: saved });
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
      ctx.host.emit(media("empty-2", 0, 5, 6, 7));
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

  it.each(["completes", "fails with ENOSPC"] as const)("waits for a pending first append that %s before deciding the result", async (result) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ctx = await real({ beforeWrite: async () => {
      await gate;
      if (result !== "completes") throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    } });
    try {
      await ctx.begin("empty-1");
      ctx.host.emit(media("empty-1", 0, 1, 2, 3));
      ctx.recorder.stop();
      ctx.host.emit({ type: "stopped", sessionId: "empty-1" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(ctx.of("saved")).toHaveLength(0);
      expect(ctx.of("failed")).toHaveLength(0);
      release();
      if (result === "completes") {
        await vi.waitFor(() => expect(ctx.of("saved")).toHaveLength(1));
        expect(await fs.readFile(ctx.of("saved")[0]!.path)).toEqual(Buffer.from([1, 2, 3]));
        expect(ctx.of("failed")).toHaveLength(0);
      } else {
        // A real disk error keeps its own code rather than becoming "no media".
        await vi.waitFor(() => expect(ctx.of("failed")).toHaveLength(1));
        expect(ctx.of("failed")[0]).toMatchObject({ code: "disk_full" });
        expect(ctx.of("failed")[0]).not.toHaveProperty("partialPath");
        expect(ctx.of("saved")).toHaveLength(0);
        expect(await fs.readdir(ctx.dir)).toEqual([]);
      }
    } finally {
      release();
      await ctx.cleanup();
    }
  });

  it.each([["ENOSPC", "disk_full"], ["EIO", "output_write_failed"]] as const)(
    "reports a background sync failure (%s) before media as %s, not as no media",
    async (errno, code) => {
      const ctx = await real({ syncError: errno });
      try {
        await ctx.begin("empty-1");
        await vi.waitFor(() => expect(ctx.syncs.length).toBeGreaterThan(0));
        ctx.recorder.stop();
        ctx.host.emit({ type: "stopped", sessionId: "empty-1" });
        await vi.waitFor(() => expect(ctx.of("failed")).toHaveLength(1));
        expect(ctx.of("failed")[0]).toMatchObject({ code, detail: expect.stringContaining(errno) });
        expect(ctx.of("failed")[0]).not.toHaveProperty("partialPath");
        expect(ctx.of("saved")).toHaveLength(0);
        expect(ctx.closed).toHaveLength(1);
        expect(await fs.readdir(ctx.dir)).toEqual([]);
      } finally {
        await ctx.cleanup();
      }
    },
  );
  describe("health guards with a real FileWriter (plan 038)", () => {
    const errorOf = (code: string) => Object.assign(new Error(code), { code });

    it("fails a stalled capture as capture_failed and keeps the nonempty temporary file", async () => {
      const log = vi.fn();
      const ctx = await real({ deps: { log, health: { stallWarnMs: 30, stallFailMs: 90 } } });
      try {
        await ctx.begin("empty-1");
        ctx.host.emit(media("empty-1", 0, 1, 2, 3));
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

    it("refuses an append past the backlog bound, fails with its detail and keeps the accepted bytes", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const ctx = await real({ backlogLimitBytes: 4, beforeWrite: () => gate });
      try {
        await ctx.begin("empty-1");
        ctx.host.emit(media("empty-1", 0, 1, 2, 3));
        ctx.host.emit(media("empty-1", 1, 4, 5));
        await vi.waitFor(() => expect(ctx.of("failureStatus")).toHaveLength(1));
        expect(ctx.of("failureStatus")[0]!.result).toMatchObject({ code: "output_write_failed", outcome: "pending",
          detail: expect.stringContaining("writer backlog limit 4 bytes exceeded: 3 bytes pending, 2 arriving") });
        expect(ctx.recorder.state).toEqual({ type: "idle" });
        release();
        await vi.waitFor(() => expect(ctx.of("failed")).toHaveLength(1));
        const failed = ctx.of("failed")[0]!;
        expect(failed.code).toBe("output_write_failed");
        expect(await fs.readFile(failed.partialPath!)).toEqual(Buffer.from([1, 2, 3]));
        expect(ctx.of("saved")).toHaveLength(0);
      } finally {
        release();
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
        return FileWriter.open(recordingPath, finalPath);
      } } });
      try {
        await ctx.begin("empty-1");
        expect(seen).toEqual([{ tempExists: false, sentinel: { version: 1, sessionId: "empty-1", startedAt: expect.any(String),
          recordingPath: path.join(ctx.dir, "2026-09-25 12-00-00.recording.mp4") } }]);
        ctx.host.emit(media("empty-1", 0, 7));
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

    describe("retained disk error during start", () => {
      const expectRetained = (ctx: Awaited<ReturnType<typeof real>>, code: string) => {
        const statuses = ctx.of("failureStatus");
        // The first (notified) status already carries the disk code, not a generic start failure.
        expect(statuses[0]!.result).toMatchObject({ code, outcome: "pending", detail: expect.stringContaining("start ended:") });
        expect(statuses.at(-1)!.result).toMatchObject({ code, outcome: "empty" });
        expect(ctx.of("failed")).toEqual([{ type: "failed", code, detail: expect.stringContaining("ENOSPC"), outcome: "empty", session: expect.any(Object) }]);
      };

      // An unanswered capture request settles only later, as a real OS prompt does; quit keeps owning it until then.
      let answer = (): void => undefined;
      it.each([
        ["the first-media deadline", async (ctx: Awaited<ReturnType<typeof real>>) => {
          await ctx.begin("empty-1");
        }],
        ["the capture-request timeout", async (ctx: Awaited<ReturnType<typeof real>>) => {
          ctx.host.start = () => new Promise<void>((resolve) => { answer = resolve; });
          ctx.recorder.toggle();
        }],
        ["a host start rejection", async (ctx: Awaited<ReturnType<typeof real>>) => {
          ctx.host.start = async () => {
            await vi.waitFor(() => expect(ctx.syncs.length).toBeGreaterThan(0));
            throw new Error("host refused start");
          };
          ctx.recorder.toggle();
        }],
        ["a host-reported capture_start_failed", async (ctx: Awaited<ReturnType<typeof real>>) => {
          await ctx.begin("empty-1");
          await vi.waitFor(() => expect(ctx.syncs.length).toBeGreaterThan(0));
          ctx.host.emit({ type: "error", sessionId: "empty-1", code: "capture_start_failed", detail: "encoder refused" });
        }],
      ])("reports the retained disk code after %s, with an empty result", async (_label, trigger) => {
        const ctx = await real({ syncError: "ENOSPC", deps: { startTimeoutMs: 300, captureRequestTimeoutMs: 300 } });
        try {
          await trigger(ctx);
          await vi.waitFor(() => expect(ctx.of("failed")).toHaveLength(1));
          expectRetained(ctx, "disk_full");
          expect(ctx.of("saved")).toHaveLength(0);
          expect(await fs.readdir(ctx.dir)).toEqual([]);
        } finally {
          answer();
          await ctx.cleanup();
        }
      });

      it("keeps specific host causes and a clean writer's capture_start_failed", async () => {
        const sick = await real({ syncError: "EIO" });
        try {
          await sick.begin("empty-1");
          await vi.waitFor(() => expect(sick.syncs.length).toBeGreaterThan(0));
          sick.host.emit({ type: "error", sessionId: "empty-1", code: "no_audio_track", detail: "no audio" });
          await vi.waitFor(() => expect(sick.of("failed")).toHaveLength(1));
          expect(sick.of("failed")[0]).toMatchObject({ code: "no_audio_track", detail: "no audio" });
        } finally {
          await sick.cleanup();
        }
        const clean = await real({ deps: { startTimeoutMs: 100 } });
        try {
          await clean.begin("empty-1");
          await vi.waitFor(() => expect(clean.of("failed")).toHaveLength(1));
          expect(clean.of("failed")[0]).toMatchObject({ code: "capture_start_failed", detail: "capture host did not send media before the deadline" });
          expect(clean.of("failureStatus")[0]!.result.code).toBe("capture_start_failed");
        } finally {
          await clean.cleanup();
        }
      });

      it("waits for an in-flight sync before classifying, but only within its bound", async () => {
        let settle!: (error?: Error) => void;
        let calls = 0;
        const sync = () => ++calls === 1
          ? new Promise<void>((resolve, reject) => { settle = (error) => (error ? reject(error) : resolve()); })
          : Promise.resolve();
        const failing = await real({ sync, deps: { startTimeoutMs: 100 } });
        try {
          await failing.begin("empty-1");
          await vi.waitFor(() => expect(failing.recorder.state).toEqual({ type: "idle" }));
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(failing.of("failureStatus")).toHaveLength(0);
          settle(errorOf("ENOSPC"));
          await vi.waitFor(() => expect(failing.of("failed")).toHaveLength(1));
          expectRetained(failing, "disk_full");
        } finally {
          settle();
          await failing.cleanup();
        }
        calls = 0;
        const hung = await real({ sync, deps: { startTimeoutMs: 100, health: { startDrainMs: 50 } } });
        try {
          await hung.begin("empty-1");
          await vi.waitFor(() => expect(hung.of("failureStatus")).toHaveLength(1));
          expect(hung.of("failureStatus")[0]!.result).toMatchObject({ code: "capture_start_failed", outcome: "pending" });
          settle();
          await vi.waitFor(() => expect(hung.of("failed")).toHaveLength(1));
          expect(hung.of("failed")[0]).toMatchObject({ code: "capture_start_failed" });
        } finally {
          settle();
          await hung.cleanup();
        }
      });
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

  it.each(["crash", "error", "duplicate-stop"])("ignores %s after stopped while a real final copy is pending", async (late) => {
    vi.useRealTimers();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordstuff-terminal-"));
    let copy!: () => void;
    const gate = new Promise<void>(resolve => { copy = resolve; });
    const host = new FakeHost();
    const events: RecorderEvent[] = [];
    const recorder = new Recorder({ host, outputDir: () => dir, quality: () => DEFAULT_QUALITY,
      ensureWritableDir: async () => undefined, newSessionId: () => "real",
      openWriter: (partial, final) => FileWriter.open(partial, final, { io: { ...nodeFs,
        copyExclusive: async (from, to) => { await gate; await nodeFs.copyExclusive(from, to); },
      } }),
    });
    recorder.subscribe(e => events.push(e));
    try {
      recorder.toggle();
      while (host.started.length === 0) await new Promise(resolve => setTimeout(resolve, 1));
      host.emit(prepared("real")); host.emit({ type: "chunk", sessionId: "real", seq: 0, bytes: new Uint8Array([1, 2, 3]).buffer });
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
  const late = new FakeWriter("/out/late.recording.mp4", "/out/late.mp4");
  late.abandon = async () => { throw new Error("close failed"); };
  open(late); await flush();
  expect(await ctx.recorder.shutdown()).toBe(true);
  const statuses = ctx.events.filter(event => event.type === "failureStatus");
  expect(statuses.at(-1)).toMatchObject({ result: { outcome: "unknown", recordingPath: late.recordingPath } });
  expect(statuses.at(-1)).not.toHaveProperty("result.partialPath");
  expect(ctx.events.filter(event => event.type === "failed")).toHaveLength(1);
});

it("defers quit without cancelling an interactive capture request at the quit deadline", async () => {
  const ctx = setup({ captureRequestTimeoutMs: "default" });
  ctx.recorder.toggle(); await flush();
  const quitting = ctx.recorder.shutdown();
  await vi.advanceTimersByTimeAsync(13_000);
  expect(await quitting).toBe(false);
  expect(ctx.recorder.state.type).toBe("starting");
  expect(ctx.host.stopped).toEqual([]);
  expect(ctx.events.some(event => event.type === "failed")).toBe(false);
  // The attempt stays marked: its late answer cancels it instead of recording.
  ctx.host.emit(prepared("s1")); await flush();
  expect(ctx.recorder.state.type).toBe("idle");
  expect(ctx.host.recorded).toEqual([]);
  expect(ctx.host.stopped).toEqual(["s1"]);
  expect(ctx.events.filter(event => event.type === "cancelled")).toHaveLength(1);
  expect(ctx.events.some(event => event.type === "failed" || event.type === "saved")).toBe(false);
});

describe("disk headroom guard", () => {
  const MIB = 1024 * 1024;
  const logged = (log: ReturnType<typeof vi.fn>, text: string) => log.mock.calls.filter(([message]) => String(message).includes(text));

  it("warns once below 1 GiB, requests one normal stop below 200 MiB and saves with the reason", async () => {
    const free = [2048, 900, 800, 150, 100].map((mib) => mib * MIB);
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
    expect(polled).toEqual(["/out", "/out", "/out", "/out"]);
    ctx.host.emit(chunk("s1", 4));
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(ctx.events.filter((event) => event.type === "saved")).toEqual([
      { type: "saved", path: "/out/2026-09-11 14-30-00.mp4", stoppedEarly: "lowDisk", session: traced() },
    ]);
    expect(ctx.writers[0]!.chunks).toHaveLength(5);
    expect(ctx.events.some((event) => event.type === "failed" || event.type === "failureStatus")).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("file finalized /out/2026-09-11 14-30-00.mp4 (stopped early: disk almost full)"));
  });

  it("logs a failed poll once and never stops the recording because of it", async () => {
    const log = vi.fn();
    const freeSpace = vi.fn(async () => { throw new Error("statfs unavailable"); });
    const ctx = setup({ log, deps: { freeSpace } });
    await startRecording(ctx);
    for (let seq = 1; seq <= 3; seq++) {
      await vi.advanceTimersByTimeAsync(5000);
      ctx.host.emit(chunk("s1", seq));
    }
    expect(freeSpace).toHaveBeenCalledTimes(3);
    expect(ctx.recorder.state.type).toBe("recording");
    expect(logged(log, "free-space check failed: statfs unavailable")).toHaveLength(1);
    ctx.recorder.stop();
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    expect(ctx.events.at(-1)).toEqual({ type: "saved", path: "/out/2026-09-11 14-30-00.mp4", session: traced() });
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
    expect(ctx.events.at(-1)).toEqual({ type: "saved", path: "/out/2026-09-11 14-30-00.mp4", session: traced() });
  });
});

describe("interruption sentinel lifecycle", () => {
  function sentinels(options: { fail?: boolean } = {}) {
    const files = new Map<string, SessionSentinel>();
    const calls: string[] = [];
    return { files, calls,
      write: async (sentinel: SessionSentinel) => {
        calls.push(`write ${path.basename(sentinel.recordingPath)}`);
        if (options.fail) throw new Error("userData is read-only");
        files.set(sentinel.sessionId, sentinel);
      },
      remove: async (sessionId: string) => { calls.push(`remove ${sessionId}`); files.delete(sessionId); } };
  }
  type Ctx = ReturnType<typeof setup>;

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
    expect(store.files.get("s1")).toEqual({ sessionId: "s1", startedAt: expect.any(String), recordingPath: "/out/2026-09-11 14-30-00-2.recording.mp4" });
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
      ctx.writers[0]!.appendError = Object.assign(new Error("ENOSPC"), { code: "disk_full" });
      ctx.host.emit(chunk("s1", 1)); await flush();
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

  it("removes a sentinel whose late writer opened after the opening deadline", async () => {
    const store = sentinels();
    let open!: (writer: FakeWriter) => void;
    const ctx = setup({ deps: { sentinels: store }, openWriter: () => new Promise((resolve) => { open = resolve; }) });
    ctx.recorder.toggle(); await flush();
    await vi.advanceTimersByTimeAsync(8000);
    expect(store.files.has("s1")).toBe(true);
    open(new FakeWriter("/out/2026-09-11 14-30-00.recording.mp4", "/out/2026-09-11 14-30-00.mp4"));
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
  prepare(): void { this.note("prepare"); }
  show(remaining: number): void { this.note(`show ${remaining}`); }
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
    const cases: Array<[string, "toggle" | "menu" | "quit", (recorder: Recorder) => unknown]> = [
      ["a second click or the shortcut", "toggle", (recorder) => recorder.toggle()],
      ["Cancel countdown", "menu", (recorder) => recorder.cancelCountdown("menu")],
      ["Quit", "quit", (recorder) => recorder.shutdown()],
    ];
    for (const [name, reason, act] of cases) {
      it(`${name} returns to idle with lastSavedPath and no failure, file or later record`, async () => {
        const ctx = counting(3);
        // One saved recording first, so idle has something to keep.
        ctx.recorder.toggle();
        await flush();
        ctx.host.emit(prepared("s1"));
        await vi.advanceTimersByTimeAsync(3 * tickMs);
        ctx.host.emit(chunk("s1", 0));
        ctx.recorder.stop();
        ctx.host.emit({ type: "stopped", sessionId: "s1" });
        await flush();
        const lastSavedPath = "/out/2026-09-11 14-30-00.mp4";
        expect(ctx.recorder.state).toEqual({ type: "idle", lastSavedPath });
        const before = ctx.events.length;
        ctx.presenter.calls = [];

        ctx.recorder.toggle();
        await flush();
        ctx.host.emit(prepared("s1"));
        await vi.advanceTimersByTimeAsync(1500);
        expect(ctx.recorder.state).toEqual({ type: "countdown", remaining: 2 });
        const quit = act(ctx.recorder);
        await flush();
        expect(ctx.recorder.state).toEqual({ type: "idle", lastSavedPath });
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
        expect(ctx.recorder.state).toEqual({ type: "idle", lastSavedPath });
      });
    }

    it("ignores clicks while preparing, as while starting", async () => {
      const ctx = counting(3);
      ctx.recorder.toggle();
      await flush();
      ctx.recorder.toggle();
      ctx.recorder.cancelCountdown("menu");
      expect(ctx.recorder.state.type).toBe("starting");
      expect(ctx.host.stopped).toEqual([]);
    });
  });

  it("a Cancel countdown from a menu opened during the countdown stops a capture that already began", async () => {
    const ctx = counting(3);
    await ctx.prepare();
    await vi.advanceTimersByTimeAsync(3 * tickMs);
    expect(ctx.recorder.state.type).toBe("recording");
    ctx.recorder.cancelCountdown("menu");
    expect(ctx.recorder.state.type).toBe("stopping");
    expect(ctx.host.stopped).toEqual(["s1"]);
    expect(ctx.logs).toContainEqual(expect.stringContaining("Cancel countdown arrived after capture started"));
    ctx.host.emit(chunk("s1", 0));
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    // Nothing is discarded: the short recording is saved, not cancelled.
    expect(ctx.events.filter((event) => event.type === "saved")).toHaveLength(1);
    expect(ctx.events.some((event) => event.type === "cancelled" || event.type === "failed")).toBe(false);
    // Outside a recording a late Cancel countdown does nothing.
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

    it("a disk error the writer already retained keeps its own code", async () => {
      const ctx = counting(3);
      await ctx.prepare();
      const writer = ctx.writers[0]! as FakeWriter & { drain?: () => Promise<unknown> };
      writer.drain = async () => Object.assign(new Error("ENOSPC: no space"), { code: "disk_full" });
      ctx.host.crash();
      await flush();
      expect(ctx.events.find((event) => event.type === "failed")).toMatchObject({ code: "disk_full", outcome: "empty" });
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
