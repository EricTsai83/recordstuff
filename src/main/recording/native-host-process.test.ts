import { describe, expect, it, vi } from "vitest";
import type { HostMessage, NativeStart } from "../../shared/protocol";
import { DEFAULT_QUALITY } from "../../shared/quality";
import { NativeHost, developmentCapture, engineFailure, type ParentPort } from "./native-host-process";

class Port implements ParentPort {
  sent: HostMessage[] = [];
  private listener: ((message: { data: unknown }) => void) | undefined;
  on(_event: "message", listener: (message: { data: unknown }) => void): void { this.listener = listener; }
  postMessage(message: unknown): void { this.sent.push(message as HostMessage); }
  deliver(data: unknown): void { this.listener?.({ data }); }
}

type Event = { kind: "progress" | "writeError" | "captureError"; bytes?: number; code?: string; detail?: string };

function fakeEngine() {
  let emit: (event: Event) => void = () => undefined;
  const engine = {
    probe: vi.fn(async () => ({ width: 3456, height: 2234 })),
    prepare: vi.fn(async (options: { width: number; height: number }) => ({
      width: options.width, height: options.height, sampleRate: 48_000, channelCount: 2, primingFrames: 2112,
      excludedApps: 2, hiddenWindows: 0, warnings: [], timings: "content 0 ms, first frame 12 ms; total 40 ms",
    })),
    record: vi.fn(),
    stop: vi.fn(async () => ({ drainMs: 31, drainPaddedFrames: 0, frameLeadAvgMs: 4.2, frameLeadMaxMs: 9 })),
    finish: vi.fn(async (): Promise<{ bytes: number; finalizeMs: number; fragmented?: string | null }> => ({ bytes: 1234, finalizeMs: 4, fragmented: null })),
    cancel: vi.fn(async () => undefined),
  };
  return { engine, factory: (onEvent: (event: Event) => void) => { emit = onEvent; return engine; }, emit: (event: Event) => emit(event) };
}

const native: NativeStart = { displayId: 1, recordingPath: "/out/a.recording.mp4", ownPids: [10, 11], hideSystemUi: false };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function prepared() {
  const port = new Port();
  const fake = fakeEngine();
  const logs: string[] = [];
  new NativeHost(port, fake.factory, (line) => logs.push(line));
  port.deliver({ type: "start", sessionId: "s1", quality: { ...DEFAULT_QUALITY, resolutionCap: "1080p" }, native });
  await flush();
  return { port, logs, ...fake };
}

describe("engineFailure", () => {
  it("splits the engine's code from its detail, and treats anything else as a start failure", () => {
    expect(engineFailure(new Error("permission_denied|declined (-3801)"))).toEqual({ code: "permission_denied", detail: "declined (-3801)" });
    expect(engineFailure("boom")).toEqual({ code: "capture_start_failed", detail: "boom" });
  });
});

describe("developmentCapture", () => {
  it("reads a window, an area or apps, and whose sound, and ignores anything else", () => {
    expect(developmentCapture({})).toEqual({});
    expect(developmentCapture({ RECORDSTUFF_CAPTURE_SOURCE: "window:1234" })).toEqual({ source: { kind: "window", windowId: 1234 } });
    expect(developmentCapture({ RECORDSTUFF_CAPTURE_SOURCE: "area:10,20,640,360" })).toEqual({ source: { kind: "area", area: { x: 10, y: 20, width: 640, height: 360 } } });
    expect(developmentCapture({ RECORDSTUFF_CAPTURE_SOURCE: "apps:5,6", RECORDSTUFF_CAPTURE_AUDIO: "apps:5" })).toEqual({
      source: { kind: "apps", pids: [5, 6] }, audio: { system: "apps", pids: [5], microphone: false },
    });
    expect(developmentCapture({ RECORDSTUFF_CAPTURE_AUDIO: "off" })).toEqual({ audio: { system: "off", microphone: false } });
    for (const value of ["window:", "area:1,2,3", "apps:x", "display", "window:-1"]) {
      expect(developmentCapture({ RECORDSTUFF_CAPTURE_SOURCE: value })).toEqual({});
    }
  });
});

describe("NativeHost", () => {
  it("probes and prepares the development source and sound when they are set, and logs them", async () => {
    const port = new Port();
    const fake = fakeEngine();
    const logs: string[] = [];
    const source = { kind: "area" as const, area: { x: 0, y: 0, width: 800, height: 450 } };
    new NativeHost(port, fake.factory, (line) => logs.push(line), undefined, { source, audio: { system: "off", microphone: false } });
    port.deliver({ type: "start", sessionId: "s1", quality: DEFAULT_QUALITY, native });
    await flush();
    expect(fake.engine.probe).toHaveBeenCalledWith(1, undefined, source);
    expect(fake.engine.prepare).toHaveBeenCalledWith(expect.objectContaining({ source, audio: { system: "off", microphone: false } }));
    expect(logs[0]).toContain("development capture: source");
  });

  it("logs audio that arrived too late to mix", async () => {
    const { port, engine, logs } = await prepared();
    engine.stop.mockResolvedValueOnce({ drainMs: 1, drainPaddedFrames: 0, frameLeadAvgMs: 0, frameLeadMaxMs: 0, lateAudioFrames: [0, 480] } as never);
    port.deliver({ type: "record", sessionId: "s1" });
    port.deliver({ type: "stop", sessionId: "s1" });
    await flush();
    expect(logs.find((line) => line.startsWith("timing: stop"))).toContain("audio frames too late to mix, by input: 0, 480");
  });

  it("prepares within the cap the setting names, at the setting's bit rate, and reports the capture", async () => {
    const { port, engine } = await prepared();
    expect(port.sent[0]).toEqual({ type: "ready" });
    // A 3456x2234 display capped at 1080p keeps its aspect ratio.
    expect(engine.prepare).toHaveBeenCalledWith(expect.objectContaining({
      displayId: 1, width: 1670, height: 1080, frameRate: 30, audioBitrate: 256_000,
      ownPids: [10, 11], hideSystemUi: false, path: "/out/a.recording.mp4",
    }));
    expect(port.sent[1]).toMatchObject({ type: "prepared", sessionId: "s1", mimeType: expect.stringContaining("video/mp4"),
      capture: { width: 1670, height: 1080, frameRate: 30, sampleRate: 48_000, channelCount: 2, audioBitsPerSecond: 256_000 } });
  });

  it("leaves the display point out when main gave none: the engine refuses null for it", async () => {
    const { engine } = await prepared();
    expect(engine.probe).toHaveBeenCalledWith(1, undefined);
    expect(Object.keys(engine.prepare.mock.calls[0]![0])).not.toContain("displayPoint");
  });

  it("logs where preparing, record and stop spent their time", async () => {
    const { port, logs } = await prepared();
    port.deliver({ type: "record", sessionId: "s1" });
    port.deliver({ type: "stop", sessionId: "s1" });
    await flush();
    expect(logs[0]).toMatch(/^timing: probe \d+ ms, prepare \d+ ms \(content 0 ms, first frame 12 ms; total 40 ms\)$/);
    expect(logs[1]).toMatch(/^timing: record \d+\.\d ms$/);
    expect(logs[2]).toMatch(/^timing: stop \d+ ms \(sound up to the stop 31 ms, 0 frame\(s\) filled with silence; frames stamped 4\.2 ms ahead on average, 9\.0 ms at most\)$/);
    expect(logs[3]).toBe("timing: file finished 4 ms after the stop");
  });

  it("records only the prepared session, then reports the stop before the finished file", async () => {
    const { port, engine } = await prepared();
    port.deliver({ type: "record", sessionId: "other" });
    expect(port.sent.at(-1)).toMatchObject({ type: "error", sessionId: "other", code: "capture_start_failed" });
    port.deliver({ type: "record", sessionId: "s1" });
    expect(engine.record).toHaveBeenCalledTimes(1);
    expect(port.sent.at(-1)).toEqual({ type: "started", sessionId: "s1" });
    let finished: (file: { bytes: number; finalizeMs: number; fragmented?: string | null }) => void = () => undefined;
    engine.finish.mockImplementationOnce(() => new Promise((resolve) => { finished = resolve; }));
    port.deliver({ type: "stop", sessionId: "s1" });
    await flush();
    // Capture has ended; the file is still being finished.
    expect(port.sent.at(-1)).toMatchObject({ type: "stopped", sessionId: "s1" });
    expect(port.sent.at(-1)).not.toHaveProperty("file");
    finished({ bytes: 1234, finalizeMs: 4, fragmented: null });
    await flush();
    expect(port.sent.at(-1)).toEqual({ type: "finished", sessionId: "s1", file: { bytes: 1234, finalizeMs: 4 } });
  });

  it("reports why the file stayed fragmented", async () => {
    const { port, engine } = await prepared();
    engine.finish.mockResolvedValueOnce({ bytes: 9, finalizeMs: 2, fragmented: "index not written: EIO" });
    port.deliver({ type: "record", sessionId: "s1" });
    port.deliver({ type: "stop", sessionId: "s1" });
    await flush();
    expect(port.sent.at(-1)).toEqual({ type: "finished", sessionId: "s1", file: { bytes: 9, finalizeMs: 2, fragmented: "index not written: EIO" } });
  });

  it("ignores engine events once stopped: the file's outcome is what finish answers", async () => {
    const { port, engine, emit } = await prepared();
    engine.finish.mockImplementationOnce(() => new Promise(() => undefined));
    port.deliver({ type: "record", sessionId: "s1" });
    port.deliver({ type: "stop", sessionId: "s1" });
    await flush();
    const sent = port.sent.length;
    emit({ kind: "writeError", code: "disk_full", detail: "No space left" });
    expect(port.sent).toHaveLength(sent);
  });

  it("turns engine events into progress, write errors and capture errors of the current session", async () => {
    const { port, emit } = await prepared();
    port.deliver({ type: "record", sessionId: "s1" });
    emit({ kind: "progress", bytes: 2048 });
    emit({ kind: "writeError", code: "disk_full", detail: "No space left" });
    emit({ kind: "captureError", code: "capture_failed", detail: "display gone" });
    expect(port.sent.slice(-3)).toEqual([
      { type: "progress", sessionId: "s1", bytes: 2048 },
      { type: "writeError", sessionId: "s1", code: "disk_full", detail: "No space left" },
      { type: "error", sessionId: "s1", code: "capture_failed", detail: "display gone" },
    ]);
  });

  it("reports a failed finish after the stop as a write error, with the engine's code", async () => {
    const { port, engine } = await prepared();
    engine.finish.mockRejectedValueOnce(new Error("disk_full|finish failed: No space left"));
    port.deliver({ type: "record", sessionId: "s1" });
    port.deliver({ type: "stop", sessionId: "s1" });
    await flush();
    expect(port.sent.slice(-2)).toEqual([
      expect.objectContaining({ type: "stopped", sessionId: "s1" }),
      { type: "writeError", sessionId: "s1", code: "disk_full", detail: "finish failed: No space left" },
    ]);
  });

  it("reports a stop the engine refused as a capture failure", async () => {
    const { port, engine } = await prepared();
    engine.stop.mockRejectedValueOnce(new Error("capture_failed|gone"));
    port.deliver({ type: "record", sessionId: "s1" });
    port.deliver({ type: "stop", sessionId: "s1" });
    await flush();
    expect(port.sent.at(-1)).toEqual({ type: "error", sessionId: "s1", code: "capture_failed", detail: "gone" });
    expect(engine.finish).not.toHaveBeenCalled();
  });

  it("cancels a prepared session at stop without recording", async () => {
    const { port, engine } = await prepared();
    port.deliver({ type: "stop", sessionId: "s1" });
    await flush();
    expect(engine.cancel).toHaveBeenCalledTimes(1);
    expect(engine.stop).not.toHaveBeenCalled();
    expect(port.sent.at(-1)).toMatchObject({ type: "stopped", sessionId: "s1" });
  });

  it("releases capture that finished preparing after main gave up, and never reports it prepared", async () => {
    const port = new Port();
    const fake = fakeEngine();
    let finish: () => void = () => undefined;
    fake.engine.prepare.mockImplementationOnce(async (options) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { width: options.width, height: options.height, sampleRate: 48_000, channelCount: 2, primingFrames: 0, excludedApps: 1, hiddenWindows: 0, warnings: [], timings: "" };
    });
    new NativeHost(port, fake.factory, () => undefined);
    port.deliver({ type: "start", sessionId: "s1", quality: DEFAULT_QUALITY, native });
    await flush();
    port.deliver({ type: "stop", sessionId: "s1" });
    finish();
    await flush();
    expect(fake.engine.cancel).toHaveBeenCalledTimes(1);
    expect(port.sent.map((m) => m.type)).toEqual(["ready", "stopped"]);
  });

  it("maps a refused prepare to its host error code", async () => {
    const port = new Port();
    const fake = fakeEngine();
    fake.engine.probe.mockRejectedValueOnce(new Error("permission_denied|The user declined TCCs (-3801)"));
    new NativeHost(port, fake.factory, () => undefined);
    port.deliver({ type: "start", sessionId: "s1", quality: DEFAULT_QUALITY, native });
    await flush();
    expect(port.sent.at(-1)).toEqual({ type: "error", sessionId: "s1", code: "permission_denied", detail: "The user declined TCCs (-3801)" });
  });

  it("answers pings, and refuses a start without the native options or while busy", async () => {
    const { port } = await prepared();
    port.deliver({ type: "ping" });
    expect(port.sent.at(-1)).toEqual({ type: "pong" });
    port.deliver({ type: "start", sessionId: "s2", quality: DEFAULT_QUALITY, native });
    await flush();
    expect(port.sent.at(-1)).toMatchObject({ type: "error", sessionId: "s2", detail: "a recording is already in progress" });
    port.deliver({ type: "start", sessionId: "s3", quality: DEFAULT_QUALITY });
    expect(port.sent.at(-1)).toMatchObject({ type: "error", sessionId: "s3", code: "capture_start_failed" });
  });
});
