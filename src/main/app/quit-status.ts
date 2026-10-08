/**
 * What a quit in progress holds back and shows (docs/system-design/desktop.md#deferred-quit): while it runs every
 * action but quit is ignored and notifications wait; once it has taken longer than a quick exit, the tray and the
 * window say what it waits on; a quit that stays open releases exactly what it held and keeps a line about why until
 * that work is done (plan 056). The side effects are the app's (`index.ts`); the timing and the order are here.
 */
import type { QuitDeferral } from "./quit-feedback";
import type { AppContext } from "./ui-model";

/** A quit that ends sooner shows nothing: no tray or window line flashes for an ordinary exit. */
export const QUIT_FEEDBACK_DELAY_MS = 300;

export interface QuitStatusDeps {
  /** Notifications wait while a quit runs (saved and capture notices), and are released when it is declined. */
  holdNotices(held: boolean): void;
  /** A declined quit admits recordings again. */
  resumeAdmission(): void;
  /** Work held back while the app was unsettled (update results, a shortcut change) applies now. */
  flushHeld(): void;
  /** The tray, the window and the menu redraw from `context()`. */
  refresh(): void;
}

export class QuitStatus {
  /** A quit is running: every action but quit is ignored until it exits or is declined. */
  requested = false;
  /** What the running or last quit waits on: recording work first, then the settings, window size, Trash and log writes. */
  step: QuitDeferral = "media";
  /** Shown once the quit outlasted `QUIT_FEEDBACK_DELAY_MS`. */
  private shown = false;
  private feedback: ReturnType<typeof setTimeout> | undefined;
  /** What held the last declined quit, while the tray still says so. */
  private deferred: QuitDeferral | undefined;
  /** Each deferral clears only its own line: a later quit may have replaced it. */
  private token = 0;

  constructor(private readonly deps: QuitStatusDeps) {}

  /** A quit starts with recording work, holding everything `end` releases. */
  begin(): void {
    this.step = "media";
    this.clearDeferred();
    this.requested = true;
    this.deps.holdNotices(true);
    // Pending cleanup can hold quit for the stop deadline, and a history save for its wait; the tray says so meanwhile.
    clearTimeout(this.feedback);
    this.feedback = setTimeout(() => { this.shown = true; this.deps.refresh(); }, QUIT_FEEDBACK_DELAY_MS);
  }

  /** Media is settled: a quit still waiting now waits on the metadata writes. */
  metadata(): void {
    this.step = "metadata";
    if (this.shown) this.deps.refresh();
  }

  /** The app stays open: release exactly what `begin` held. */
  end(): void {
    this.requested = false;
    this.deps.resumeAdmission();
    this.deps.holdNotices(false);
    clearTimeout(this.feedback);
    this.feedback = undefined;
    if (this.shown) { this.shown = false; this.deps.refresh(); }
    this.deps.flushHeld();
  }

  /** The declined quit's line stays until `settled`, the work it waited on, is done, unless a later state replaced it. */
  defer(settled: Promise<unknown>): void {
    this.deferred = this.step;
    const token = this.token;
    this.deps.refresh();
    void settled.then(() => { if (token === this.token) this.clearDeferred(); }, () => undefined);
  }

  /** Drops the declined quit's line; `refresh: false` when the caller draws anyway. */
  clearDeferred(refresh = true): void {
    this.token += 1;
    if (this.deferred === undefined) return;
    this.deferred = undefined;
    if (refresh) this.deps.refresh();
  }

  /** The quit fields of `AppContext`. */
  context(): Pick<AppContext, "quitting" | "quitStep" | "quitDeferred"> {
    return {
      ...(this.shown ? { quitting: true, quitStep: this.step } : {}),
      ...(this.deferred ? { quitDeferred: this.deferred } : {}),
    };
  }

  /** Exiting: a modal quit prompt can hold the feedback timer past its delay, and it must not draw a destroyed tray. */
  dispose(): void {
    clearTimeout(this.feedback);
  }
}
