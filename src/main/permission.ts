/**
 * macOS screen-recording permission (docs/system-design/recording.md), designed after Cap's
 * lesson: what the OS *says* is only a hint; what capture can actually *see*
 * is the truth, and that check is expensive so it is bounded and cached.
 *
 * Two stages on every poll:
 *   1. `getMediaAccessStatus('screen')` — cheap, never prompts.
 *   2. Only when stage 1 says granted and we have not yet proven capture
 *      works: `desktopCapturer.getSources` must list at least one screen
 *      within a timeout. Right after a grant, before the app relaunches,
 *      stage 1 says granted while stage 2 sees nothing — that is the
 *      `needsRelaunch` case. Success is cached for the process lifetime.
 *
 * While not granted, one `getSources` call is made so macOS registers the
 * app in the Screen Recording list and shows its own prompt; the user then
 * only has to flip the switch instead of adding the app by hand.
 *
 * Only stage 1 is polled, and polling it is cheap on purpose: it never
 * prompts and materialises nothing, so it costs a syscall every 5 seconds.
 * Stage 2 is the expensive one and is never polled — Cap's screen-recording
 * poller re-ran the equivalent macOS call (`SCShareableContent`, which
 * materialises every window/app/display) for the whole process lifetime and
 * leaked ~15 MB/min until macOS exhausted swap (CapSoftware/Cap issue #2023).
 * Caching one success for the process is what makes that safe, and a runtime
 * revocation is still caught by stage 1 and by the capture attempt itself.
 *
 * At most one watcher-owned `getSources` call — prompt or validation — is
 * ever unresolved (plan 027). The validation deadline only shows relaunch
 * guidance: a call that never returns keeps its slot, so the watcher then
 * polls stage 1 alone rather than stacking native requests. A failed
 * validation retries with a bounded backoff counted from its completion.
 *
 * There is no window, so `activate` is unreliable; poll every 5 seconds.
 * Windows needs nothing and this module is never used there.
 */
import { app, desktopCapturer, shell, systemPreferences } from "electron";

export const SCREEN_CAPTURE_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

export function screenCaptureGranted(): boolean {
  return systemPreferences.getMediaAccessStatus("screen") === "granted";
}

export function openScreenCaptureSettings(): Promise<void> {
  return shell.openExternal(SCREEN_CAPTURE_SETTINGS_URL);
}

/**
 * Notification permission has no status API to poll — `getMediaAccessStatus`
 * covers microphone, camera and screen only — so the app never mirrors it.
 * This is the recovery path the settings panel offers instead.
 */
export const NOTIFICATION_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.Notifications-Settings.extension";

export function openNotificationSettings(): Promise<void> {
  return shell.openExternal(NOTIFICATION_SETTINGS_URL);
}

/** Number of screens capture can currently see; throws when macOS refuses. */
export async function countCapturableScreens(): Promise<number> {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 0, height: 0 },
  });
  return sources.length;
}

export interface PermissionStatus {
  granted: boolean;
  needsRelaunch: boolean;
}

export interface PermissionWatcherOptions {
  /** Poll period; also the first retry delay after a failed validation. */
  intervalMs?: number;
  /** A validation still unanswered after this shows relaunch guidance; its request stays owned. */
  validateTimeoutMs?: number;
  /** Upper bound of the retry backoff, which doubles from `intervalMs` after each failure. */
  retryMaxMs?: number;
  /** Injectable for tests; defaults to the Electron APIs above. */
  isGranted?: () => boolean;
  countScreens?: () => Promise<number>;
  /** Registers the activation listener and returns its removal. */
  onActivate?: (listener: () => void) => () => void;
  log?: (message: string) => void;
}

interface Enumeration {
  purpose: "prompt" | "validate";
  /** The permission generation it started in; a newer generation makes its result stale. */
  generation: number;
}

export class PermissionWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private removeActivate: (() => void) | undefined;
  private running = false;
  /** Stage 2 passed once; capture works for the rest of this process. */
  private validated = false;
  /** OS says granted but capture sees nothing, a capture was refused, or validation is overdue. */
  private relaunchRequired = false;
  /** The registration/prompt call is made at most once per process. */
  private prompted = false;
  /** Bumped by revocation, a refused capture and stop(): older validations are stale. */
  private generation = 0;
  /**
   * The one watcher-owned getSources call, prompt or validation. It is held
   * until that promise itself settles: a deadline cannot cancel the native
   * request, so a replacement would only pile up another one.
   */
  private inFlight: Enumeration | undefined;
  /** UI deadline for an unanswered validation; firing shows guidance, never frees `inFlight`. */
  private deadline: ReturnType<typeof setTimeout> | undefined;
  /** Next validation after a failure, measured from that failure's completion. */
  private retry: ReturnType<typeof setTimeout> | undefined;
  private retryDelayMs: number;
  private last: PermissionStatus | undefined;

  private readonly intervalMs: number;
  private readonly validateTimeoutMs: number;
  private readonly retryMaxMs: number;
  private readonly isGranted: () => boolean;
  private readonly countScreens: () => Promise<number>;
  private readonly onActivate: (listener: () => void) => () => void;
  private readonly log: (message: string) => void;

  constructor(
    private readonly onChange: (status: PermissionStatus) => void,
    options: PermissionWatcherOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 5000;
    this.validateTimeoutMs = options.validateTimeoutMs ?? 4000;
    this.retryMaxMs = options.retryMaxMs ?? 60_000;
    this.retryDelayMs = this.intervalMs;
    this.isGranted = options.isGranted ?? screenCaptureGranted;
    this.countScreens = options.countScreens ?? countCapturableScreens;
    this.onActivate = options.onActivate ?? ((listener) => {
      app.on("activate", listener);
      return () => app.removeListener("activate", listener);
    });
    this.log = options.log ?? (() => undefined);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.check();
    this.timer = setInterval(() => this.check(), this.intervalMs);
    this.removeActivate = this.onActivate(() => this.check());
  }

  /** Ends polling and timers; a request still in flight stays owned until it settles, then is ignored. */
  stop(): void {
    this.running = false;
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.removeActivate?.();
    this.removeActivate = undefined;
    this.clearDeadline();
    this.clearRetry();
  }

  /**
   * A capture attempt was refused for permission reasons even though we had
   * validated earlier (macOS can revoke at runtime). Drop the cache and treat
   * it as the stale-TCC case until a fresh validation proves otherwise; this
   * evidence is newer than any validation still in flight.
   */
  markRelaunchRequired(): void {
    if (!this.running || !this.isGranted()) return;
    this.generation += 1;
    this.validated = false;
    this.relaunchRequired = true;
    this.clearDeadline();
    this.check();
  }

  check(): void {
    if (!this.running) return;
    if (!this.isGranted()) {
      // Losing the grant resets everything; a later grant is validated afresh.
      this.generation += 1;
      this.validated = false;
      this.relaunchRequired = false;
      this.clearDeadline();
      this.clearRetry();
      this.retryDelayMs = this.intervalMs;
      this.emit({ granted: false, needsRelaunch: false });
      this.promptOnce();
      return;
    }
    if (this.validated) {
      this.emit({ granted: true, needsRelaunch: false });
      return;
    }
    if (this.relaunchRequired) this.emit({ granted: false, needsRelaunch: true });
    this.validate();
  }

  /**
   * Make macOS list the app and show its own prompt (docs/system-design/recording.md).
   * It shares the single enumeration slot, so it waits for a pending validation.
   */
  private promptOnce(): void {
    if (this.prompted || this.inFlight) return;
    this.prompted = true;
    this.enumerate("prompt");
  }

  /**
   * Stage 2: one request at a time, a UI deadline, and a backoff after
   * failure, so a transient failure (e.g. a wedged capture service after sleep)
   * still heals without user action. Success is cached.
   */
  private validate(): void {
    if (this.retry) return;
    if (!this.relaunchRequired && !this.deadline) {
      this.deadline = setTimeout(() => this.overdue(), this.validateTimeoutMs);
    }
    if (this.inFlight) return;
    this.enumerate("validate");
  }

  /** The validation is unanswered: guide the user to relaunch, but keep owning the request. */
  private overdue(): void {
    this.deadline = undefined;
    if (!this.running || this.validated) return;
    if (!this.isGranted()) {
      this.check();
      return;
    }
    this.log(`permission: validation unanswered after ${this.validateTimeoutMs} ms; no new request until it settles`);
    this.relaunchRequired = true;
    this.emit({ granted: false, needsRelaunch: true });
  }

  private enumerate(purpose: Enumeration["purpose"]): void {
    const request: Enumeration = { purpose, generation: this.generation };
    this.inFlight = request;
    let pending: Promise<number>;
    try {
      pending = this.countScreens();
    } catch (cause) {
      pending = Promise.reject(cause);
    }
    pending.then(
      (count) => this.settle(request, { count }),
      (cause: unknown) => this.settle(request, { cause }),
    );
  }

  private settle(request: Enumeration, outcome: { count: number } | { cause: unknown }): void {
    // Only a request's own settlement frees the slot.
    if (this.inFlight === request) this.inFlight = undefined;
    if (request.purpose === "prompt") {
      this.log("count" in outcome
        ? `permission: prompt call returned ${outcome.count} screen(s) without a grant`
        : `permission: prompt call refused as expected: ${String(outcome.cause)}`);
      // A grant that arrived meanwhile is validated now that the slot is free.
      this.check();
      return;
    }
    if (!this.running || request.generation !== this.generation) {
      this.log(`permission: ignored a superseded validation (${"count" in outcome ? `${outcome.count} screen(s)` : String(outcome.cause)})`);
      this.check();
      return;
    }
    // The grant may have been withdrawn while we were waiting.
    if (!this.isGranted()) {
      this.check();
      return;
    }
    this.clearDeadline();
    const ok = "count" in outcome && outcome.count > 0;
    this.log(
      "cause" in outcome ? `permission: validation failed: ${String(outcome.cause)}`
        : ok ? `permission: granted and capture sees ${outcome.count} screen(s)`
        : "permission: OS reports granted but capture sees no screens",
    );
    this.validated = ok;
    this.relaunchRequired = !ok;
    if (ok) {
      this.retryDelayMs = this.intervalMs;
      this.emit({ granted: true, needsRelaunch: false });
      return;
    }
    this.emit({ granted: false, needsRelaunch: true });
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(delay * 2, this.retryMaxMs);
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.check();
    }, delay);
  }

  private clearDeadline(): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = undefined;
  }

  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
  }

  private emit(status: PermissionStatus): void {
    if (this.last && this.last.granted === status.granted && this.last.needsRelaunch === status.needsRelaunch) {
      return;
    }
    this.last = status;
    this.onChange(status);
  }
}
