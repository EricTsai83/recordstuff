import { describe, expect, it, vi } from "vitest";
import type { HostMessage, NativeStart } from "../../shared/protocol";
import { DEFAULT_QUALITY } from "../../shared/quality";
import { NativeHost, engineFailure, type ParentPort } from "./native-host-process";

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
    stop: vi.fn(async () => ({ bytes: 1234, finalizeMs: 4, fragmented: null, drainMs: 31, drainPaddedFrames: 0, frameLeadAvgMs: 4.2, frameLeadMaxMs: 9 })),
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

describe("NativeHost", () => {
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
    expect(logs[2]).toMatch(/^timing: stop \d+ ms \(sound up to the stop 31 ms, 0 frame\(s\) filled with silence; file 4 ms; frames stamped 4\.2 ms ahead on average, 9\.0 ms at most\)$/);
  });

  it("records only the prepared session, then reports the finished file at stop", async () => {
    const { port, engine } = await prepared();
    port.deliver({ type: "record", sessionId: "other" });
    expect(port.sent.at(-1)).toMatchObject({ type: "error", sessionId: "other", code: "capture_start_failed" });
    port.deliver({ type: "record", sessionId: "s1" });
    expect(engine.record).toHaveBeenCalledTimes(1);
    expect(port.sent.at(-1)).toEqual({ type: "started", sessionId: "s1" });
    port.deliver({ type: "stop", sessionId: "s1" });
    await flush();
    expect(port.sent.at(-1)).toMatchObject({ type: "stopped", sessionId: "s1", file: { bytes: 1234, finalizeMs: 4 } });
    expect((port.sent.at(-1) as { file: object }).file).not.toHaveProperty("fragmented");
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

  it("reports a failed finish as a write error when the engine names one", async () => {
    const { port, engine } = await prepared();
    engine.stop.mockRejectedValueOnce(new Error("output_write_failed|finish failed: EIO"));
    port.deliver({ type: "record", sessionId: "s1" });
    port.deliver({ type: "stop", sessionId: "s1" });
    await flush();
    expect(port.sent.at(-1)).toEqual({ type: "writeError", sessionId: "s1", code: "output_write_failed", detail: "finish failed: EIO" });
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
