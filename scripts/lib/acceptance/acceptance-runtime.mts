/** Bounded subprocesses and recording cleanup for acceptance runners. */
import { setTimeout as delay } from "node:timers/promises";
import { EARLY_STOP_TEXT, type SessionRecord } from "../../../src/shared/session-record.ts";
import { currentState, lastStartIndex } from "./acceptance.mts";
import type { LogCursor, LogReader } from "../runner/log-reader.mts";
import { isSessionRecordLine, parseSessionRecord } from "../runner/session-records.mts";
import { escapeRegExp } from "../runner/processes.mts";

/** The human `saved <path>` line, whose path an early stop follows with ` (stopped early: <reason>)` (session-log.ts). */
export const SAVED_LINE = new RegExp(`\\] saved (.+?)(?: \\(stopped early: (?:${Object.values(EARLY_STOP_TEXT).map(escapeRegExp).join("|")})\\))?$`);
/** The saved file a `saved` line names, without an early stop's reason. */
export function savedPathOf(line: string): string | undefined {
  return SAVED_LINE.exec(line)?.[1];
}

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


export type TerminalRecord = Extract<SessionRecord, { kind: "saved" | "failed" }>;

/**
 * The terminal record of `session` in `run` among lines read from its capture
 * record on, if it already ended. A runner checks before sending stop: after
 * an early failure the same key would start a new session (plan 054).
 */
export function sessionEnded(lines: readonly string[], run: string, session: string): TerminalRecord | undefined {
  return lines.map(parseSessionRecord).find((record): record is TerminalRecord =>
    (record?.kind === "saved" || record?.kind === "failed") && record.run === run && record.session === session);
}

/**
 * This recording's outcome in lines written after its cursor. Records are
 * authoritative wherever the app writes them (plan 029): the human `saved` /
 * `failed:` lines are read only from a build that writes no records, so one
 * outcome is never read twice. With `session`, only that session's record counts.
 */
export function recordingOutcome(lines: readonly string[], session?: string): { settled: false } | { settled: true; saved?: string; failure?: string; cancelled?: true } {
  // A countdown cancelled before capture (plan 040) ends with a plain line and no record.
  const cancelled = lines.some((line) => {
    const id = /\] cancelled: session (\S+) /.exec(line)?.[1];
    return id !== undefined && (session === undefined || id === session);
  });
  if (cancelled) return { settled: true, cancelled: true };
  if (lines.some(isSessionRecordLine)) {
    const terminal = lines.map(parseSessionRecord).find((record): record is TerminalRecord =>
      (record?.kind === "saved" || record?.kind === "failed") && (session === undefined || record.session === session));
    if (!terminal) return { settled: false };
    return terminal.kind === "saved" ? { settled: true, saved: terminal.path } : { settled: true, failure: `${terminal.code} ${terminal.detail}` };
  }
  const saved = lines.map(savedPathOf).find(Boolean);
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
    // During a countdown the same key cancels; afterwards it stops.
    if ((state === "recording" || state === "countdown") && !stopSent) {
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
