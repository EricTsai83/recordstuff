import type { RecordingState } from "../shared/state";
import type { EarlyStop } from "./recorder";

/** A heuristic, not an OS readiness signal. See verification's Plan 017 timeline. */
export const SAVED_NOTIFICATION_DELAY_MS = 500;

/** One pending save, owned by the app lifecycle; never holds up recording or exit. */
export class SavedNotification {
  private pending: { timer: ReturnType<typeof setTimeout>; path: string } | undefined;
  private idle = true;
  private disposed = false;
  private quitting = false;

  constructor(private readonly options: {
    platform: string;
    show: (path: string, stoppedEarly?: EarlyStop) => void;
    log: (message: string) => void;
  }) {}

  stateChanged(state: RecordingState): void {
    this.idle = state.type === "idle";
    if (!this.idle) this.cancel("recording state changed");
  }

  /** `stoppedEarly` adds the reason the recording ended before the user asked. */
  schedule(path: string, stoppedEarly?: EarlyStop): void {
    this.cancel("replaced");
    if (this.disposed || this.quitting || !this.idle) return;
    if (this.options.platform !== "darwin") {
      this.deliver(path, stoppedEarly);
      return;
    }
    this.options.log(`notification: saved scheduled delayMs=${SAVED_NOTIFICATION_DELAY_MS} ${path}${stoppedEarly ? ` stoppedEarly=${stoppedEarly}` : ""}`);
    const timer = setTimeout(() => {
      this.pending = undefined;
      if (!this.disposed && !this.quitting && this.idle) this.deliver(path, stoppedEarly);
    }, SAVED_NOTIFICATION_DELAY_MS);
    timer.unref();
    this.pending = { timer, path };
  }

  setQuitting(quitting: boolean): void {
    this.quitting = quitting;
    if (quitting) this.cancel("shutdown");
  }

  dispose(): void {
    this.disposed = true;
    this.cancel("shutdown");
  }

  private cancel(reason: string): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.options.log(`notification: saved cancelled (${reason}) ${this.pending.path}`);
    this.pending = undefined;
  }

  private deliver(path: string, stoppedEarly?: EarlyStop): void {
    try {
      if (stoppedEarly) this.options.show(path, stoppedEarly);
      else this.options.show(path);
    } catch (error) {
      this.options.log(`notification: saved request failed (${String(error)}) ${path}`);
    }
  }
}
