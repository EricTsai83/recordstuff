/**
 * Recorder outcomes as log lines (plan 029, docs/system-design/desktop.md#logs): the
 * human-readable line people read, then one versioned session record carrying
 * the run and session ids that development analyzers pair by.
 */
import { formatSessionRecord } from "../shared/session-record";
import type { Log } from "./log";
import type { RecorderEvent } from "./recorder";

/**
 * One id per launch, printed in the `start:` line and carried in every
 * record: launch time plus pid, so a restarted app is distinguishable from a
 * rotated file and sessions pair across launches without reading line order.
 */
export function createRunId(launchedAt: Date, pid: number): string {
  return `${launchedAt.toISOString().replace(/[-:.]/g, "")}-${pid}`;
}

/** Logs the events that identify a session's capture and outcome; ignores the rest. */
export function logSessionEvent(log: Log, run: string, event: RecorderEvent): void {
  switch (event.type) {
    case "captureStarted":
      log(formatSessionRecord(run, { kind: "capture", session: event.sessionId, requested: event.requested, capture: event.capture }));
      return;
    case "saved": {
      log(`saved ${event.path}${event.stoppedEarly === "lowDisk" ? " (stopped early: disk almost full)" : ""}`);
      const { id, recordingPath: _temporary, ...timing } = event.session;
      log(formatSessionRecord(run, { kind: "saved", session: id, path: event.path,
        ...(event.stoppedEarly ? { stoppedEarly: event.stoppedEarly } : {}), ...timing }));
      return;
    }
    case "failed": {
      log(`failed: ${event.code} ${event.detail}${event.partialPath ? ` (kept ${event.partialPath})` : ""}`);
      if (event.preflight) {
        log(formatSessionRecord(run, { kind: "refused", code: event.code, detail: event.detail }));
        return;
      }
      const { id, ...trace } = event.session;
      log(formatSessionRecord(run, { kind: "failed", session: id, code: event.code, detail: event.detail,
        outcome: event.outcome, ...(event.partialPath ? { partialPath: event.partialPath } : {}), ...trace }));
      return;
    }
    // Not a failure and no media: a plain line, no session record for analyzers to pair.
    case "cancelled":
      log(`cancelled: session ${event.session.id} (${event.reason}); no media was recorded${event.session.recordingPath ? `; temporary file ${event.session.recordingPath}` : ""}`);
      return;
    default:
      return;
  }
}
