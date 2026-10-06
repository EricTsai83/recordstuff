import type { RecordingState } from "../../shared/state";
import { SAVED_NOTIFICATION_DELAY_MS } from "./saved-notification";
import { preferencesUnlocked } from "./recording-lock";

/**
 * What a session learns when capture starts — a resolution cap it could not
 * confirm, a frame rate below the request — is told once the session settles
 * (plan 053). While the display is shared macOS may decide `display shared`
 * and mute a banner (the saved-notification timing record), which is also why
 * the saved notification waits for capture to end. Held notices go out
 * together, the same delay after the session settles; a new session or a
 * quit before then drops them, as it drops a pending saved notification.
 */
export class CaptureNotices {
  private held: Array<{ label: string; show: () => void }> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private idle = true;
  private disposed = false;
  private quitting = false;

  constructor(private readonly options: { platform: string; log: (message: string) => void }) {}

  /** `label` names the notice in the log; `show` runs once, when it is delivered. */
  hold(label: string, show: () => void): void {
    if (this.disposed || this.quitting) {
      this.options.log(`notification: ${label} dropped (shutdown)`);
      return;
    }
    this.held.push({ label, show });
    this.options.log(`notification: held until capture ends: ${label}`);
    if (this.idle) this.schedule();
  }

  stateChanged(state: RecordingState): void {
    this.idle = preferencesUnlocked(state);
    if (this.idle) this.schedule();
    // A pending delivery belongs to the session that just ended; the next one starts clean.
    else if (this.timer) this.drop("recording state changed");
  }

  setQuitting(quitting: boolean): void {
    this.quitting = quitting;
    if (quitting) this.drop("shutdown");
  }

  dispose(): void {
    this.disposed = true;
    this.drop("shutdown");
  }

  private schedule(): void {
    if (this.timer || this.held.length === 0) return;
    if (this.options.platform !== "darwin") { this.deliver(); return; }
    this.timer = setTimeout(() => { this.timer = undefined; this.deliver(); }, SAVED_NOTIFICATION_DELAY_MS);
    this.timer.unref();
  }

  private deliver(): void {
    const held = this.held;
    this.held = [];
    for (const notice of held) {
      try { notice.show(); }
      catch (error) { this.options.log(`notification: ${notice.label} request failed (${String(error)})`); }
    }
  }

  private drop(reason: string): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const notice of this.held) this.options.log(`notification: ${notice.label} dropped (${reason})`);
    this.held = [];
  }
}
