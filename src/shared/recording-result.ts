import type { ErrorCode } from "./state";

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
