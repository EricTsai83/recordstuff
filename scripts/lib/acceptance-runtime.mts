/** Bounded subprocesses and recording cleanup for acceptance runners. */
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { SessionRecord } from "../../src/shared/session-record.ts";
import { currentState, lastStartIndex } from "./acceptance.mts";
import type { LogCursor, LogReader } from "./log-reader.mts";
import { isSessionRecordLine, parseSessionRecord } from "./session-records.mts";

/** A newly launched app logs ready/permission but no initial state transition. */
export function confirmedIdle(lines: readonly string[]): boolean {
  const state = currentState(lines);
  if (state !== undefined) return state === "idle";
  const start = lastStartIndex(lines);
  if (start < 0) return false;
  const session = lines.slice(start + 1);
  return session.some(line => /\] ready;/.test(line))
    && session.some(line => /\] permission: granted and capture sees/.test(line));
}

/** Quit only the accepted idle process; a replaced app or unknown state is not ours to close. */
export async function quitIdleApp(options: {
  pid: string;
  running: () => string | undefined;
  read: () => string[];
  quit: () => Promise<unknown>;
  signal: AbortSignal;
}): Promise<void> {
  options.signal.throwIfAborted();
  const pid = options.running();
  if (!pid) return;
  if (pid !== options.pid) throw new Error("RecordStuff process changed; leaving it untouched");
  if (!confirmedIdle(options.read())) throw new Error("RecordStuff is not confirmed idle; refusing to quit");
  await options.quit();
  while (options.running()) {
    options.signal.throwIfAborted();
    await delay(100, undefined, { signal: options.signal });
  }
}

export function command(
  file: string,
  args: string[],
  signal: AbortSignal,
  timeout = 10_000,
  allowedCodes = [0],
): Promise<string> {
  signal.throwIfAborted();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    let outcome: (() => void) | undefined;
    const child = execFile(file, args, { encoding: "utf8", env, timeout, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
      outcome = () => {
        if (error && !(typeof error.code === "number" && allowedCodes.includes(error.code))) {
          reject(new Error(`${file}: ${stderr.trim() || error.message}`, { cause: error }));
        } else resolve(stdout.trimEnd());
      };
    });
    const abort = (): void => { child.kill("SIGKILL"); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    // Wait for exit before restoring files, even when cancellation kills a copy command.
    child.once("close", () => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else if (outcome) outcome();
      else reject(new Error(`${file}: no exit result`));
    });
  });
}

type TerminalRecord = Extract<SessionRecord, { kind: "saved" | "failed" }>;

/**
 * This recording's outcome in lines written after its cursor. Records are
 * authoritative wherever the app writes them (plan 029): the human `saved` /
 * `failed:` lines are read only from a build that writes no records, so one
 * outcome is never read twice. With `session`, only that session's record counts.
 */
export function recordingOutcome(lines: readonly string[], session?: string): { settled: false } | { settled: true; saved?: string; failure?: string } {
  if (lines.some(isSessionRecordLine)) {
    const terminal = lines.map(parseSessionRecord).find((record): record is TerminalRecord =>
      (record?.kind === "saved" || record?.kind === "failed") && (session === undefined || record.session === session));
    if (!terminal) return { settled: false };
    return terminal.kind === "saved" ? { settled: true, saved: terminal.path } : { settled: true, failure: `${terminal.code} ${terminal.detail}` };
  }
  const saved = lines.map((line) => /\] saved (.+)$/.exec(line)?.[1]).find(Boolean);
  if (saved) return { settled: true, saved };
  const failed = lines.map((line) => /\] failed: (.*)$/.exec(line)?.[1]).find((text) => text !== undefined);
  return failed === undefined ? { settled: false } : { settled: true, failure: failed };
}

/**
 * Settle only this recording, read from its cursor across any rotation;
 * never toggle a session that already stopped. Resolves with the saved path,
 * or undefined after a failure. A lost log history rejects at once
 * (`LogGapError`): waiting cannot recover it.
 */
export async function finishRecording(options: {
  log: LogReader;
  from: LogCursor;
  stop: () => Promise<unknown>;
  stopSent: boolean;
  signal: AbortSignal;
  /** The session this run started, once its capture record was seen. */
  session?: string;
}): Promise<string | undefined> {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]);
  let stopSent = options.stopSent;
  while (true) {
    signal.throwIfAborted();
    const lines = options.log.since(options.from).lines.map((line) => line.text);
    const state = currentState(lines);
    const outcome = recordingOutcome(lines, options.session);
    if (state === "idle" && outcome.settled) return outcome.saved;
    if (state === "recording" && !stopSent) {
      stopSent = true;
      await options.stop();
    }
    await delay(100, undefined, { signal });
  }
}

/**
 * A runner's cleanup: settle its recording, or, once that deadline passed,
 * accept an app that logged no session event and is confirmed idle (it never
 * started recording; safe to quit, though the run still failed).
 */
export async function settleRecording(options: Parameters<typeof finishRecording>[0]): Promise<{ saved?: string; neverStarted?: true }> {
  try {
    const saved = await finishRecording(options);
    return saved === undefined ? {} : { saved };
  } catch (error) {
    const since = options.log.since(options.from).lines.map((line) => line.text);
    if (currentState(since) !== undefined || !confirmedIdle(options.log.all())) throw error;
    return { neverStarted: true };
  }
}

export interface LogHit {
  line: string;
  /** Where the line starts, and just past it. */
  at: LogCursor;
  next: LogCursor;
}

/**
 * Wait only for events after `from`, following rotation; each line is read
 * once. Bounded by `timeout` with a diagnostic tail; a lost history rejects
 * at once with `LogGapError` instead of waiting without a useful reason.
 */
export async function waitForLog(
  log: LogReader, from: LogCursor, pattern: RegExp | ((line: string) => boolean), what: string,
  signal: AbortSignal, timeout = 30_000,
): Promise<LogHit> {
  const matches = typeof pattern === "function" ? pattern : (line: string) => pattern.test(line);
  const deadline = Date.now() + timeout;
  const tail: string[] = [];
  let cursor = from;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const batch = log.since(cursor);
    for (const line of batch.lines) {
      if (matches(line.text)) return { line: line.text, at: line.at, next: line.next };
      if (line.text) tail.push(line.text);
    }
    tail.splice(0, Math.max(0, tail.length - 6));
    cursor = batch.next;
    await delay(Math.min(200, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
  signal.throwIfAborted();
  throw new Error(`timed out after ${timeout / 1000} s waiting for ${what}. Log:\n  ${tail.join("\n  ") || "(nothing)"}`);
}

/** The first session record after `from` that satisfies `accept`. */
export async function waitForRecord<T extends SessionRecord>(
  log: LogReader, from: LogCursor, accept: (record: SessionRecord) => record is T, what: string,
  signal: AbortSignal, timeout = 30_000,
): Promise<{ record: T } & LogHit> {
  const hit = await waitForLog(log, from, (line) => {
    const record = parseSessionRecord(line);
    return record !== undefined && accept(record);
  }, what, signal, timeout);
  return { record: parseSessionRecord(hit.line) as T, ...hit };
}
