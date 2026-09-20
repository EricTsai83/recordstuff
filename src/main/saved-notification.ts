import type { RecordingState } from "../shared/state";

/** A heuristic, not an OS readiness signal. See verification's Plan 017 timeline. */
export const SAVED_NOTIFICATION_DELAY_MS = 500;

/** One pending save, owned by the app lifecycle; never holds up recording or exit. */
export class SavedNotification {
  private pending: { timer: ReturnType<typeof setTimeout>; path: string } | undefined;
  private idle = true;
  private disposed = false;

  constructor(private readonly options: {
    platform: string;
    show: (path: string) => void;
    log: (message: string) => void;
  }) {}

  stateChanged(state: RecordingState): void {
    this.idle = state.type === "idle";
    if (!this.idle) this.cancel("recording state changed");
  }

  schedule(path: string): void {
    this.cancel("replaced");
    if (this.disposed || !this.idle) return;
    if (this.options.platform !== "darwin") {
      this.deliver(path);
      return;
    }
    this.options.log(`notification: saved scheduled delayMs=${SAVED_NOTIFICATION_DELAY_MS} ${path}`);
    const timer = setTimeout(() => {
      this.pending = undefined;
      if (!this.disposed && this.idle) this.deliver(path);
    }, SAVED_NOTIFICATION_DELAY_MS);
    timer.unref();
    this.pending = { timer, path };
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

  private deliver(path: string): void {
    try {
      this.options.show(path);
    } catch (error) {
      this.options.log(`notification: saved request failed (${String(error)}) ${path}`);
    }
  }
}
