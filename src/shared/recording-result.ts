import type { ErrorCode } from "./state";

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
  persistenceFailed?: boolean;
  /** Runtime only: this failure came from a previous app process. */
  restored?: boolean;
}
