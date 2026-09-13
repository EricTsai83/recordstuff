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
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", detail: expect.stringContaining("系統權限提示") });
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
    expect(ctx.events.at(-1)).toEqual({ type: "failed", code: "output_open_failed", detail: "/out" });
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
    expect(events).toEqual([{ type: "failed", code: "unsupported_os_version", detail: "" }]);
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
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "output_open_failed" });
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
    expect(ctx.events.at(-1)).toEqual({ type: "state", state: { type: "idle" } });
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
    await vi.advanceTimersByTimeAsync(10_000); // host never answers stop → stop_timeout
    let resolved = false;
    void shutdown.then(() => (resolved = true));
    await flush();
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(resolved).toBe(false);
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
    ctx.host.emit({ type: "stopped", sessionId: "s1" });
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    await shutdown; // resolved by the cap, without failing the session
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

  it("shutdown gives a stalled partial-file close a bounded grace period", async () => {
    const ctx = setup();
    await startRecording(ctx);
    ctx.writers[0]!.abandon = () => new Promise(() => undefined);
    let resolved = false;
    void ctx.recorder.shutdown().then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctx.recorder.state).toEqual({ type: "idle" });
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(resolved).toBe(true);
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
    await expect(ctx.recorder.shutdown()).resolves.toBeUndefined();
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

  it("is bounded by the stop timeout", async () => {
    const ctx = setup();
    await startRecording(ctx);
    const shutdown = ctx.recorder.shutdown();
    await vi.advanceTimersByTimeAsync(10_000);
    await shutdown;
    expect(ctx.recorder.state.type).toBe("idle");
    expect(ctx.events.at(-1)).toMatchObject({ type: "failed", code: "stop_timeout" });
  });
});

describe("quality snapshot (plan 007 §B2)", () => {
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
