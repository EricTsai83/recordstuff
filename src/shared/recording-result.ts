import type { ErrorCode } from "./state";

/** Reviewed records the history keeps, newest review first; unreviewed ones are all kept. */
export const REVIEWED_FAILURES_KEPT = 20;

/** What the user can do with one failure-history record. */
export type RecordingResultAction = "acknowledge" | "retry" | "remove" | "reveal" | "folder" | "permission" | "relaunch";

/** The actions that change the saved history, so each waits for a durable save; the others only open something. */
export type PersistingResultAction = Extract<RecordingResultAction, "acknowledge" | "remove" | "retry">;
export function persistsHistory(action: string): action is PersistingResultAction {
  return action === "acknowledge" || action === "remove" || action === "retry";
}

/** `io` may recover by retrying; the others need a different user action. */
export type PersistenceIssue = "io" | "blocked" | "tooLarge";

/** A failure's UI lifecycle is separate from the recorder's capture state. */
export interface RecordingFailure {
  id: string;
  occurredAt: string;
  code: ErrorCode;
  detail: string;
  outcome: "pending" | "partial" | "empty" | "unknown";
  partialPath?: string;
  /** Unconfirmed lookup path; its existence does not prove completed preservation. */
  recordingPath?: string;
  /** Allows a previously confirmed partial to be rechecked after a temporary outage. */
  previouslyPartial?: boolean;
}
export interface RecordingResult extends RecordingFailure {
  acknowledged: boolean;
  /** Review time controls retention independently of failure occurrence order. */
  acknowledgedAt?: string;
  /** Runtime only: the latest save failed and this row differs from the saved file. */
  persistenceFailed?: PersistenceIssue;
  /** Runtime only: an acknowledgement or removal waits for a durable save. */
  saving?: "acknowledge" | "remove";
  /** Runtime only: this failure came from a previous app process. */
  restored?: boolean;
}
