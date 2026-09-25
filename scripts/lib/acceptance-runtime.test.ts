import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileLogger, rotateLog } from "../../src/main/log.ts";
import { formatSessionRecord } from "../../src/shared/session-record.ts";
import { command, confirmedIdle, finishRecording, quitIdleApp, recordingOutcome, settleRecording, waitForLog, waitForRecord } from "./acceptance-runtime.mts";
import { LogGapError, LogReader } from "./log-reader.mts";


describe("acceptance subprocess bounds", () => {
  it("cancels a running child even if it ignores SIGTERM", async () => {
    const controller = new AbortController();
    const pending = command(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], controller.signal);
    const assertion = expect(pending).rejects.toThrow();
    await delay(50);
    controller.abort();
    await assertion;
  });

  it("times out a stuck child and rejects command errors", async () => {
    await expect(command(process.execPath, ["-e", "setInterval(() => {}, 1000)"], new AbortController().signal, 100)).rejects.toThrow();
    await expect(command(process.execPath, ["-e", "process.exit(2)"], new AbortController().signal)).rejects.toThrow();
    await expect(command(process.execPath, ["-e", "process.exit(1)"], new AbortController().signal, 1000, [0, 1])).resolves.toBe("");
  });
});

/**
 * Real temporary logs written by the production logger and rotated by the
 * production `rotateLog`, read through the runners' own reader, waits and
 * cleanup (plan 029, R2-07).
 */
let dir: string;
let file: string;
let write: (...messages: string[]) => void;
let reader: LogReader;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-runtime-"));
  file = path.join(dir, "recordstuff.log");
  const log = createFileLogger({ filePath: file, maxBytes: Number.MAX_SAFE_INTEGER, keep: 3, stdout: () => undefined,
    now: () => new Date("2026-09-25T10:00:00.000Z") });
  write = (...messages) => { for (const message of messages) log(message); };
  reader = new LogReader(file);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const rotate = (): void => rotateLog(file, 3);
const RUN = "20260925T100000000Z-4242";
const saved = (session: string, filePath: string): string => formatSessionRecord(RUN, { kind: "saved", session, path: filePath });
const failed = (session: string): string =>
  formatSessionRecord(RUN, { kind: "failed", session, code: "capture_host_crashed", detail: "killed", outcome: "partial", partialPath: `/m/${session}.recording.mp4` });

describe("interrupted recording cleanup", () => {
  it("waits for the second recording to start, ignoring the first recording's idle and saved lines", async () => {
    write("state → recording", "saved old.mp4", "state → idle");
    const from = reader.end();
    write("state → starting");
    const stop = vi.fn(async () => { write("state → stopping"); });
    const pending = finishRecording({ log: reader, from, stop, stopSent: false, signal: new AbortController().signal });
    await delay(200);
    expect(stop).not.toHaveBeenCalled();
    write("state → recording");
    await delay(200);
    expect(stop).toHaveBeenCalledTimes(1);
    write("saved new.mp4", "state → idle");
    await expect(pending).resolves.toBe("new.mp4");
  });

  it("follows stop, save and idle into the new file after a rotation without toggling again", async () => {
    const from = reader.end();
    write("state → recording");
    const stop = vi.fn(async () => { write("state → stopping"); rotate(); });
    const pending = finishRecording({ log: reader, from, stop, stopSent: false, signal: new AbortController().signal });
    await delay(250);
    expect(stop).toHaveBeenCalledTimes(1);
    write("state → idle", "saved /m/new.mp4", saved("s1", "/m/new.mp4"));
    await expect(pending).resolves.toBe("/m/new.mp4");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not toggle again when stop was sent but its state transition has not arrived", async () => {
    const from = reader.end();
    write("state → recording");
    const stop = vi.fn();
    const pending = finishRecording({ log: reader, from, stop, stopSent: true, signal: new AbortController().signal });
    await delay(200);
    rotate();
    rotate();
    write("state → stopping", "saved done.mp4", "state → idle");
    await expect(pending).resolves.toBe("done.mp4");
    expect(stop).not.toHaveBeenCalled();
  });

  it("waits for the saved line even when idle was logged first", async () => {
    const from = reader.end();
    write("state → idle");
    const stop = vi.fn();
    const pending = finishRecording({ log: reader, from, stop, stopSent: true, signal: new AbortController().signal });
    await delay(150);
    write("saved final.mp4");
    await expect(pending).resolves.toBe("final.mp4");
    expect(stop).not.toHaveBeenCalled();
  });

  it("settles a failure whose cleanup finishes in the new file, reading its record once", async () => {
    const from = reader.end();
    write("state → recording", "recorder: session s1 failed: capture_host_crashed killed", "state → idle");
    rotate();
    write("failed: capture_host_crashed killed (kept /m/s1.recording.mp4)", failed("s1"), failed("s1"));
    const stop = vi.fn();
    await expect(finishRecording({ log: reader, from, stop, stopSent: false, signal: new AbortController().signal })).resolves.toBeUndefined();
    expect(stop).not.toHaveBeenCalled();
  });

  it("reads records instead of human lines and ignores another session's outcome", async () => {
    const from = reader.end();
    write("state → recording", "state → stopping", "state → idle", "saved /m/other.mp4", saved("other", "/m/other.mp4"));
    const pending = finishRecording({ log: reader, from, stop: vi.fn(), stopSent: true, signal: new AbortController().signal, session: "mine" });
    await delay(200);
    rotate();
    write("saved /m/mine.mp4", saved("mine", "/m/mine.mp4"));
    await expect(pending).resolves.toBe("/m/mine.mp4");
    expect(recordingOutcome(["[t] saved /m/a.mp4"])).toEqual({ settled: true, saved: "/m/a.mp4" });
    expect(recordingOutcome(["[t] failed: capture_failed x"])).toEqual({ settled: true, failure: "capture_failed x" });
    expect(recordingOutcome([`[t] ${failed("s1")}`, "[t] saved /m/stray.mp4"])).toEqual({ settled: true, failure: "capture_host_crashed killed" });
  });

  it("rejects at once when rotation removed the history it must read", async () => {
    write("checkpointed");
    const from = reader.end();
    for (let i = 0; i < 4; i += 1) { rotate(); write(`generation ${i}`); }
    const started = Date.now();
    await expect(finishRecording({ log: reader, from, stop: vi.fn(), stopSent: true, signal: new AbortController().signal })).rejects.toThrow(LogGapError);
    await expect(settleRecording({ log: reader, from, stop: vi.fn(), stopSent: true, signal: new AbortController().signal })).rejects.toThrow(LogGapError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("uses an independent cleanup signal and stops waiting when that budget expires", async () => {
    const controller = new AbortController();
    const from = reader.end();
    write("state → starting");
    const pending = finishRecording({ log: reader, from, stop: vi.fn(), stopSent: false, signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow();
    await delay(50);
    controller.abort();
    await assertion;
  });

  it("lets a runner quit an app that never left idle once the settlement budget ends", async () => {
    write("start: RecordStuff 1.0.0; run r; electron 44", "ready; output dir /tmp", "permission: granted and capture sees 1 screen(s)");
    const from = reader.end();
    const signal = AbortSignal.timeout(150);
    await expect(settleRecording({ log: reader, from, stop: vi.fn(), stopSent: false, signal })).resolves.toEqual({ neverStarted: true });
    write("state → starting");
    await expect(settleRecording({ log: reader, from, stop: vi.fn(), stopSent: false, signal: AbortSignal.timeout(150) })).rejects.toThrow();
  });
});

describe("session log waits", () => {
  it("ignores a previous save and observes a newly appended event", async () => {
    write("saved old.mp4");
    const from = reader.end();
    write("state → recording");
    const pending = waitForLog(reader, from, /saved /, "save", new AbortController().signal, 1000);
    write("saved new.mp4");
    await expect(pending).resolves.toMatchObject({ line: "[2026-09-25T10:00:00.000Z] saved new.mp4" });
  });

  it("detects saved in the new three-line file after a 31-line file rotated (R2-07)", async () => {
    for (let i = 0; i < 31; i += 1) write(`old ${i}`);
    const from = reader.end();
    const pending = waitForLog(reader, from, /\] saved (.+)$/, "save", new AbortController().signal, 2000);
    await delay(50);
    rotate();
    write("state → stopping", "state → idle", "saved /m/new.mp4");
    await expect(pending).resolves.toMatchObject({ line: expect.stringContaining("saved /m/new.mp4") });
  });

  it("resumes after a hit without replaying it, and finds session records by predicate", async () => {
    const from = reader.end();
    write("hotkey: X pressed", "state → recording", formatSessionRecord(RUN, { kind: "capture", session: "s1",
      requested: { videoQuality: "standard", resolutionCap: "1080p", frameRate: 30 },
      capture: { videoBitsPerSecond: 1, audioBitsPerSecond: 1, warnings: [] } }));
    const first = await waitForLog(reader, from, /pressed/, "press", new AbortController().signal, 500);
    const capture = await waitForRecord(reader, first.at, (r): r is Extract<typeof r, { kind: "capture" }> => r.kind === "capture", "capture", new AbortController().signal, 500);
    expect(capture.record).toMatchObject({ run: RUN, session: "s1" });
    await expect(waitForLog(reader, first.next, /pressed/, "second press", new AbortController().signal, 50)).rejects.toThrow("timed out");
  });

  it("bounds waiting with this session's diagnostic tail", async () => {
    write("old error");
    const from = reader.end();
    write("new event");
    await expect(waitForLog(reader, from, /saved /, "save", new AbortController().signal, 10)).rejects.toThrow("Log:\n  [2026-09-25T10:00:00.000Z] new event");
  });

  it("rejects with the evidence gap instead of waiting out the timeout", async () => {
    write("checkpointed");
    const from = reader.end();
    for (let i = 0; i < 4; i += 1) { rotate(); write(`generation ${i}`); }
    const started = Date.now();
    await expect(waitForLog(reader, from, /saved /, "save", new AbortController().signal, 30_000)).rejects.toThrow(/no longer retained/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("rejects when the log was truncated and regrew past the checkpoint instead of skipping the new save", async () => {
    for (let i = 0; i < 3; i += 1) write(`old ${i}`);
    const from = reader.end();
    fs.truncateSync(file, 0);
    write("state → recording", "state → stopping", "state → idle", "saved /m/new.mp4", saved("s1", "/m/new.mp4"));
    await expect(waitForLog(reader, from, /\] saved (.+)$/, "save", new AbortController().signal, 30_000)).rejects.toThrow(LogGapError);
    await expect(finishRecording({ log: reader, from, stop: vi.fn(), stopSent: true, signal: new AbortController().signal })).rejects.toThrow(/rewritten/);
  });

  it("honours cancellation even when a matching event already exists", async () => {
    const controller = new AbortController();
    const from = reader.end();
    write("saved file.mp4");
    controller.abort(new Error("cancelled"));
    await expect(waitForLog(reader, from, /saved /, "save", controller.signal)).rejects.toThrow("cancelled");
  });
});


describe("acceptance app shutdown", () => {
  it.each(["recording", "starting", "stopping", undefined])("preserves an app in state %s", async state => {
    const quit = vi.fn();
    await expect(quitIdleApp({ pid: "42", running: () => "42", read: () => state ? [`[t] state → ${state}`] : [], quit, signal: AbortSignal.timeout(1000) })).rejects.toThrow("not confirmed idle");
    expect(quit).not.toHaveBeenCalled();
  });
  it("does not quit a replacement process or launch an exited app", async () => {
    const quit = vi.fn();
    const options = { pid: "42", read: () => ["[t] state → idle"], quit, signal: AbortSignal.timeout(1000) };
    await expect(quitIdleApp({ ...options, running: () => "43" })).rejects.toThrow("process changed");
    await quitIdleApp({ ...options, running: () => undefined });
    expect(quit).not.toHaveBeenCalled();
  });
  it("waits for exit after requesting graceful quit", async () => {
    let running: string | undefined = "42";
    const quit = vi.fn(async () => { setTimeout(() => { running = undefined; }, 30); });
    await quitIdleApp({ pid: "42", running: () => running, read: () => ["[t] state → idle"], quit, signal: AbortSignal.timeout(1000) });
    expect(running).toBeUndefined();
    expect(quit).toHaveBeenCalledOnce();
  });
  it("fails when the app remains alive instead of force killing it", async () => {
    await expect(quitIdleApp({ pid: "42", running: () => "42", read: () => ["[t] state → idle"], quit: async () => {}, signal: AbortSignal.timeout(30) })).rejects.toThrow();
  });
});


describe("startup idle evidence", () => {
  const ready = ["[t] start: RecordStuff", "[t] ready; output dir /tmp", "[t] permission: granted and capture sees 2 screen(s)"];
  it("accepts a fresh ready app without an initial idle transition", () => {
    expect(confirmedIdle(ready)).toBe(true);
  });
  it("rejects incomplete startup, stale readiness and a subsequent recording", () => {
    expect(confirmedIdle(ready.slice(0, 2))).toBe(false);
    expect(confirmedIdle([...ready, "[t] start: RecordStuff"])).toBe(false);
    expect(confirmedIdle([...ready, "[t] state → starting"])).toBe(false);
  });
});
