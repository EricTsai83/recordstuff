import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileWriter, nodeFs } from "./file-writer";
import { SavedNotification, SAVED_NOTIFICATION_DELAY_MS } from "./saved-notification";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostMessage } from "../shared/protocol";
import { DEFAULT_QUALITY, type CaptureReport, type QualitySettings } from "../shared/quality";
import type { RecordingState } from "../shared/state";
import { Recorder, formatTimestamp, type RecorderEvent, type RecorderHost, type RecorderWriter } from "./recorder";

class FakeHost implements RecorderHost {
  started: string[] = [];
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

function started(sessionId: string, capture: CaptureReport = CAPTURE): HostMessage {
  return { type: "started", sessionId, mimeType: "video/mp4", capture };
}

function setup(
  overrides: {
    ensureWritableDir?: () => Promise<void>;
    openWriter?: (recordingPath: string, finalPath: string) => Promise<FakeWriter>;
    quality?: () => QualitySettings;
    log?: (message: string) => void;
    captureRequestTimeoutMs?: number | "default";
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
  ctx.host.emit(started("s1"));
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
    expect(ctx.events.at(-1)).toEqual({ type: "saved", path: "/out/2026-09-11 14-30-00.mp4" });
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

    ctx.host.emit(started("s1"));
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
    ctx.host.emit(started("s1"));
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
    ctx.host.emit(started("s1"));
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
    });
  });

  it("a stop request does not leave the start timer armed", async () => {
    const ctx = setup();
    ctx.recorder.toggle();
    await flush();
    ctx.host.emit(started("s1"));
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
    expect(ctx.events.at(-1)).toEqual({ type: "failed", code: "output_open_failed", detail: "EACCES" });
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
    expect(ctx.events.at(-1)).toEqual({ type: "failed", code: "capture_start_failed", detail: "no renderer" });
  });

  it("host error message → failed with that code", async () => {
    const ctx = setup();
    ctx.recorder.toggle();
    await flush();
    ctx.host.emit({ type: "error", sessionId: "s1", code: "no_audio_track", detail: "none" });
    await flush();
    expect(ctx.events.at(-1)).toEqual({ type: "failed", code: "no_audio_track", detail: "none" });
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
    expect(events.filter(event => event.type === "failed")).toEqual([{ type: "failed", code: "unsupported_os_version", detail: "" }]);
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
    ctx.host.emit(started("s1"));
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
    expect(ctx.events.at(-1)).toEqual({ type: "saved", path: writer.finalPath });
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

  it("waits for a pending start, then stops", async () => {
    const ctx = setup();
    ctx.recorder.toggle();
    await flush();
    const shutdown = ctx.recorder.shutdown();
    ctx.host.emit(started("s1"));
    ctx.host.emit(chunk("s1", 0));
    await flush();
    expect(ctx.recorder.state.type).toBe("stopping");
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    await shutdown;
    expect(ctx.recorder.state.type).toBe("idle");
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
    ctx.host.emit(started("s1", report));
    expect(ctx.events.at(-1)).toEqual({ type: "captureStarted", requested: quality, capture: report });
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
      host.emit(started("real-1"));
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
      host.emit(started("real-2"));
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
      host.emit(started("real")); host.emit({ type: "chunk", sessionId: "real", seq: 0, bytes: new Uint8Array([1, 2, 3]).buffer });
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
  ctx.host.emit(started("s1")); ctx.host.emit(chunk("s1", 0)); await flush();
  expect(ctx.recorder.state.type).toBe("stopping");
  expect(ctx.host.stopped).toEqual(["s1"]);
  ctx.host.emit({ type: "stopped", sessionId: "s1" }); await flush();
  expect(ctx.events.filter(event => event.type === "saved")).toHaveLength(1);
  expect(ctx.events.some(event => event.type === "failed")).toBe(false);
});
