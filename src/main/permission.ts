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
  /** Poll period; also the retry period for a failed validation. */
  intervalMs?: number;
  /** A validation that takes longer than this counts as failed. */
  validateTimeoutMs?: number;
  /** Injectable for tests; defaults to the Electron APIs above. */
  isGranted?: () => boolean;
  countScreens?: () => Promise<number>;
  onActivate?: (listener: () => void) => void;
  log?: (message: string) => void;
}

export class PermissionWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Stage 2 passed once; capture works for the rest of this process. */
  private validated = false;
  /** OS says granted but capture sees nothing (or a capture was refused). */
  private relaunchRequired = false;
  /** The registration/prompt call is made at most once per process. */
  private prompted = false;
  private validating = false;
  private last: PermissionStatus | undefined;

  private readonly intervalMs: number;
  private readonly validateTimeoutMs: number;
  private readonly isGranted: () => boolean;
  private readonly countScreens: () => Promise<number>;
  private readonly onActivate: (listener: () => void) => void;
  private readonly log: (message: string) => void;

  constructor(
    private readonly onChange: (status: PermissionStatus) => void,
    options: PermissionWatcherOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 5000;
    this.validateTimeoutMs = options.validateTimeoutMs ?? 4000;
    this.isGranted = options.isGranted ?? screenCaptureGranted;
    this.countScreens = options.countScreens ?? countCapturableScreens;
    this.onActivate = options.onActivate ?? ((listener) => app.on("activate", listener));
    this.log = options.log ?? (() => undefined);
  }

  start(): void {
    this.check();
    this.timer = setInterval(() => this.check(), this.intervalMs);
    this.onActivate(() => this.check());
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * A capture attempt was refused for permission reasons even though we had
   * validated earlier (macOS can revoke at runtime). Drop the cache and treat
   * it as the stale-TCC case until a fresh validation proves otherwise.
   */
  markRelaunchRequired(): void {
    if (!this.isGranted()) return;
    this.validated = false;
    this.relaunchRequired = true;
    this.check();
  }

  check(): void {
    if (!this.isGranted()) {
      // Losing the grant resets everything; a later grant is validated afresh.
      this.validated = false;
      this.relaunchRequired = false;
      this.emit({ granted: false, needsRelaunch: false });
      this.promptOnce();
      return;
    }
    if (this.validated) {
      this.emit({ granted: true, needsRelaunch: false });
      return;
    }
    if (this.relaunchRequired) this.emit({ granted: false, needsRelaunch: true });
    void this.validate();
  }

  /** Make macOS list the app and show its own prompt (docs/system-design/recording.md). */
  private promptOnce(): void {
    if (this.prompted) return;
    this.prompted = true;
    this.countScreens().then(
      (count) => this.log(`permission: prompt call returned ${count} screen(s) without a grant`),
      (cause) => this.log(`permission: prompt call refused as expected: ${String(cause)}`),
    );
  }

  /**
   * Stage 2, bounded and de-duplicated. Success is cached; failure marks
   * `needsRelaunch` and is retried on the next poll, so a transient failure
   * (e.g. a wedged capture service after sleep) heals without user action.
   */
  private async validate(): Promise<void> {
    if (this.validating) return;
    this.validating = true;
    let ok: boolean;
    try {
      const count = await withTimeout(this.countScreens(), this.validateTimeoutMs);
      ok = count > 0;
      this.log(
        ok
          ? `permission: granted and capture sees ${count} screen(s)`
          : "permission: OS reports granted but capture sees no screens",
      );
    } catch (cause) {
      ok = false;
      this.log(`permission: validation failed: ${String(cause)}`);
    } finally {
      this.validating = false;
    }
    // The grant may have been withdrawn while we were waiting.
    if (!this.isGranted()) {
      this.check();
      return;
    }
    this.validated = ok;
    this.relaunchRequired = !ok;
    this.emit(ok ? { granted: true, needsRelaunch: false } : { granted: false, needsRelaunch: true });
  }

  private emit(status: PermissionStatus): void {
    if (this.last && this.last.granted === status.granted && this.last.needsRelaunch === status.needsRelaunch) {
      return;
    }
    this.last = status;
    this.onChange(status);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}
