/**
 * Versioned session records in the app log (plan 029, docs/system-design/desktop.md#logs).
 * The app writes one when capture starts and one per terminal outcome, next to
 * the human-readable line. Development analyzers pair recordings through a
 * record's run and session ids, never through line order, and read only these
 * records where they exist, so one outcome is never counted twice. The payload
 * is JSON, which keeps paths and details with spaces, quotes or line breaks on
 * one escaped line.
 *
 * Type-only imports: `scripts/` loads this file directly under Node, which also reads `EARLY_STOP_TEXT`.
 */
import type { CaptureReport, QualitySettings } from "./quality";
import type { RecordingFailure } from "./recording-result";
import type { ErrorCode } from "./state";

/** Follows the timestamp: `[<ISO>] session-record: {"v":1,…}`. */
export const SESSION_RECORD_PREFIX = "session-record: ";
export const SESSION_RECORD_VERSION = 1;

/**
 * Why a saved recording ended before the user asked, and the words the app log
 * uses for it. The saved record carries the key and the log line the text; the
 * analysis scripts read both from here, so a new reason cannot go unrecognized.
 */
export const EARLY_STOP_TEXT = { lowDisk: "disk almost full", sleep: "the Mac went to sleep" } as const;
export type EarlyStop = keyof typeof EARLY_STOP_TEXT;

export function isEarlyStop(value: unknown): value is EarlyStop {
  return typeof value === "string" && Object.hasOwn(EARLY_STOP_TEXT, value);
}

/** A failure's settled file outcome; `pending` never reaches a terminal record. */
export type FailureOutcome = Exclude<RecordingFailure["outcome"], "pending">;

/** When the session reached recording and when stop was requested (ISO, main-process clock). */
export interface SessionTiming {
  recordingAt?: string;
  stoppingAt?: string;
}

interface RecordBase {
  v: typeof SESSION_RECORD_VERSION;
  /** The launch that wrote the record (see `createRunId`). */
  run: string;
}

export type SessionRecord =
  | (RecordBase & { kind: "capture"; session: string; requested: QualitySettings; capture: CaptureReport })
  | (RecordBase & SessionTiming & { kind: "saved"; session: string; path: string; stoppedEarly?: EarlyStop })
  | (RecordBase & SessionTiming & {
      kind: "failed";
      session: string;
      code: ErrorCode;
      detail: string;
      outcome: FailureOutcome;
      /** The kept partial file. */
      partialPath?: string;
      /** The temporary file this session opened; with `unknown` it may or may not remain. */
      recordingPath?: string;
    })
  /** Preflight refused before any attempt: there is no session to name. */
  | (RecordBase & { kind: "refused"; code: ErrorCode; detail: string });

/** Distributes over the union so each kind keeps its own fields. */
type WithoutBase<T> = T extends unknown ? Omit<T, keyof RecordBase> : never;

export function formatSessionRecord(run: string, record: WithoutBase<SessionRecord>): string {
  return `${SESSION_RECORD_PREFIX}${JSON.stringify({ v: SESSION_RECORD_VERSION, run, ...record })}`;
}
