/**
 * A real Recorder writes through the production logger (with rotation) and
 * the production session-event logging; the verifier's reader and pairing
 * read the result. The log is produced, not hand-authored (plan 029).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileLogger } from "../../src/main/log.ts";
import { Recorder, type RecorderHost, type RecorderWriter } from "../../src/main/recorder.ts";
import { createRunId, logSessionEvent } from "../../src/main/session-log.ts";
import type { HostMessage } from "../../src/shared/protocol.ts";
import type { CaptureReport, QualitySettings } from "../../src/shared/quality.ts";
import { readRetainedLog } from "./log-reader.mts";
import { pairRecordingsWithLog } from "./verify.mts";

class Host implements RecorderHost {
  private message: ((m: HostMessage) => void) | undefined;
  private failure: ((code: "capture_host_crashed" | "capture_host_unresponsive", detail: string) => void) | undefined;
  async start(): Promise<void> {}
  stop(): void {}
  onMessage(listener: (m: HostMessage) => void): void { this.message = listener; }
  onFailure(listener: (code: "capture_host_crashed" | "capture_host_unresponsive", detail: string) => void): void { this.failure = listener; }
  emit(message: HostMessage): void { this.message?.(message); }
  crash(): void { this.failure?.("capture_host_crashed", "killed"); }
}

class Writer implements RecorderWriter {
  bytes = 0;
  /** Resolves the abandon; left pending to model a slow failure cleanup. */
  release: () => void = () => undefined;
  constructor(readonly recordingPath: string, readonly finalPath: string, private readonly slow: boolean) {}
  async append(bytes: Uint8Array): Promise<void> { this.bytes += bytes.byteLength; }
  async finish(): Promise<string> { return this.finalPath; }
  async abandon(): Promise<string | undefined> {
    if (this.slow) await new Promise<void>((resolve) => { this.release = resolve; });
    return this.bytes > 0 ? this.recordingPath : undefined;
  }
}

const REPORT = (height: number): CaptureReport => ({ width: Math.round((height * 16) / 9), height, frameRate: 30, sampleRate: 48_000,
  channelCount: 2, videoBitsPerSecond: 8_100_000, audioBitsPerSecond: 256_000, warnings: [] });

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-pairing-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** `slow`: indices of opened writers whose failure cleanup waits for `release`. */
function app(options: { maxBytes: number; keep: number; slow: number[] }) {
  const logFile = path.join(dir, "logs", "recordstuff.log");
  const log = createFileLogger({ filePath: logFile, maxBytes: options.maxBytes, keep: options.keep, stdout: () => undefined });
  const run = createRunId(new Date("2026-09-25T10:00:00.000Z"), 4242);
  log(`start: RecordStuff test; run ${run}; electron test; executable /x`);
  const host = new Host();
  const writers = new Map<string, Writer>();
  const qualities: QualitySettings[] = [];
  const ids: string[] = [];
  let clock = Date.parse("2026-09-25T10:00:00.000Z");
  const recorder = new Recorder({
    host,
    outputDir: () => path.join(dir, "Movies"),
    quality: () => qualities.shift()!,
    ensureWritableDir: async () => undefined,
    newSessionId: () => ids.shift()!,
    // Each session opens a distinct timestamped file, as distinct seconds would.
    now: () => new Date((clock += 1000)),
    openWriter: async (recordingPath, finalPath) => {
      const writer = new Writer(recordingPath, finalPath, options.slow.includes(writers.size));
      writers.set(recordingPath, writer);
      return writer;
    },
    log,
  });
  // The main process's subscriber: the production session logging plus its state line.
  recorder.subscribe((event) => {
    logSessionEvent(log, run, event);
    if (event.type === "state") log(`state → ${event.state.type}`);
  });
  const begin = async (id: string, cap: QualitySettings["resolutionCap"], height: number): Promise<void> => {
    ids.push(id);
    qualities.push({ videoQuality: "standard", resolutionCap: cap, frameRate: 30 });
    recorder.toggle();
    await vi.waitFor(() => expect(recorder.state.type).toBe("starting"));
    await vi.waitFor(() => expect(recorder.sessionId).toBe(id));
    await new Promise((resolve) => setTimeout(resolve, 5));
    host.emit({ type: "started", sessionId: id, mimeType: "video/mp4", capture: REPORT(height) });
    host.emit({ type: "chunk", sessionId: id, seq: 0, bytes: new Uint8Array([1, 2, 3]).buffer });
    await vi.waitFor(() => expect(recorder.state.type).toBe("recording"));
  };
  const idle = () => vi.waitFor(() => expect(recorder.state.type).toBe("idle"));
  return { logFile, run, host, recorder, writers, begin, idle };
}

const cap = (pairs: ReturnType<typeof pairRecordingsWithLog>, file: string) => pairs.lookup(file).entry?.requested.resolutionCap;

describe("Recorder-driven log pairing", () => {
  it("pairs sessions by identity when an earlier failure's cleanup finishes last, across rotations", async () => {
    // About three lines per file: the sequence below rotates several times.
    const a = app({ maxBytes: 600, keep: 20, slow: [0] });
    await a.begin("A", "1080p", 1080);
    a.host.crash();
    await a.idle();
    const slow = [...a.writers.values()][0]!;
    await a.begin("B", "4k", 2160);
    a.host.crash();
    await vi.waitFor(() => expect(fs.readFileSync(a.logFile, "utf8")).toContain('"kind":"failed","session":"B"'));
    await a.begin("C", "1440p", 1440);
    a.recorder.toggle();
    a.host.emit({ type: "stopped", sessionId: "C" });
    await vi.waitFor(() => expect(a.recorder.state).toMatchObject({ type: "idle", lastSavedPath: expect.stringContaining(".mp4") }));
    slow.release();
    await vi.waitFor(() => expect(readRetainedLog(a.logFile, 20)).toContain('"kind":"failed","session":"A"'));
    expect(fs.existsSync(`${a.logFile.replace(/\.log$/, "")}.2.log`)).toBe(true);

    const [aFile, bFile, cFile] = [...a.writers.values()];
    const text = readRetainedLog(a.logFile, 20);
    const pairs = pairRecordingsWithLog(text);
    expect(pairs.lookup(aFile!.recordingPath)).toMatchObject({ status: "matched", entry: { sessionId: "A", runId: a.run, requested: { resolutionCap: "1080p" } } });
    expect(cap(pairs, bFile!.recordingPath)).toBe("4k");
    expect(pairs.lookup(cFile!.finalPath)).toMatchObject({ status: "matched", entry: { sessionId: "C", requested: { resolutionCap: "1440p" } } });
    expect(pairs.lookup(cFile!.finalPath).entry?.recordingStartedAtMs).toBeDefined();
    // B's failed line printed before A's: order-based legacy reading of the same launch cannot tell them apart.
    const legacy = pairRecordingsWithLog(text.split("\n").filter((line) => !line.includes("session-record:"))
      .map((line) => line.replace(/; run \S+;/, ";")).join("\n"));
    expect(legacy.lookup(aFile!.recordingPath).status).toBe("ambiguous");
    expect(legacy.lookup(bFile!.recordingPath).status).toBe("ambiguous");
    expect(legacy.lookup(cFile!.finalPath).entry?.requested.resolutionCap).toBe("1440p");
  });

  it("marks a file unknown, not someone else's, when retention dropped its capture record", async () => {
    const a = app({ maxBytes: 200, keep: 1, slow: [] });
    await a.begin("A", "1080p", 1080);
    a.recorder.toggle();
    a.host.emit({ type: "stopped", sessionId: "A" });
    await a.idle();
    await a.begin("B", "4k", 2160);
    a.recorder.toggle();
    a.host.emit({ type: "stopped", sessionId: "B" });
    await vi.waitFor(() => expect(readRetainedLog(a.logFile)).toContain('"kind":"saved","session":"B"'));
    const [aFile, bFile] = [...a.writers.values()];
    const pairs = pairRecordingsWithLog(readRetainedLog(a.logFile, 1));
    expect(pairs.lookup(aFile!.finalPath)).toMatchObject({ status: "unknown" });
    expect(pairs.lookup(aFile!.finalPath).entry).toBeUndefined();
    // B keeps its own settings or none; it never inherits A's.
    expect(["4k", undefined]).toContain(cap(pairs, bFile!.finalPath));
  });

  it("writes a failed preflight as a refusal that names no session", async () => {
    const logFile = path.join(dir, "refused.log");
    const log = createFileLogger({ filePath: logFile, stdout: () => undefined });
    const recorder = new Recorder({ host: new Host(), outputDir: () => dir, quality: () => ({ videoQuality: "standard", resolutionCap: "1080p", frameRate: 30 }),
      ensureWritableDir: async () => undefined, openWriter: async () => { throw new Error("unused"); }, preflight: () => "unsupported_os_version", log });
    recorder.subscribe((event) => logSessionEvent(log, "run-x", event));
    recorder.toggle();
    await vi.waitFor(() => expect(fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8")).toContain("session-record:"));
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").map((line) => line.replace(/^\[[^\]]*\] /, ""));
    expect(lines).toEqual(["failed: unsupported_os_version ", 'session-record: {"v":1,"run":"run-x","kind":"refused","code":"unsupported_os_version","detail":""}']);
  });
});
