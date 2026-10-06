import type { ErrorCode, RecordingState } from "../../shared/state";

/** One notice for a permission failure, whichever arrives first: the state or the failure result. */
export class PermissionNotices {
  private previous: RecordingState = { type: "idle" };
  private failureNotified = false;

  constructor(private readonly effects: {
    permission(needsRelaunch: boolean): void;
    failure(code: ErrorCode): void;
  }) {}

  stateChanged(next: RecordingState): void {
    const previous = this.previous;
    this.previous = next;
    if (next.type === "needsPermission") {
      if (previous.type !== "needsPermission" || previous.needsRelaunch !== next.needsRelaunch) {
        // A capture refusal already has a failure notice leading to recovery in Settings.
        if (!this.failureNotified) this.effects.permission(next.needsRelaunch);
        this.failureNotified = false;
      }
    } else {
      // Recovery or a fresh attempt must not suppress a future permission notice.
      this.failureNotified = false;
    }
  }

  failed(code: ErrorCode): void {
    if (code === "permission_denied") {
      // Revocation can settle the recorder into needsPermission before the failure arrives.
      if (this.previous.type === "needsPermission") return;
      this.failureNotified = true;
    }
    this.effects.failure(code);
  }
}
