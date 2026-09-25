/**
 * Registers the global start/stop shortcut with Electron `globalShortcut`
 * (docs/system-design/desktop.md). A press calls the same `onToggle` as a
 * left click on the tray icon, so `Recorder.toggle()` remains the only
 * decision point: presses while starting or stopping are ignored there.
 *
 * Registration can fail when another app owns the combination. That is
 * reported to the caller (logged, shown in the tray menu and notified by
 * index.ts), never swallowed.
 *
 * A change requested while a session is starting, recording or stopping is
 * held back (`request` → `deferred`) and applied by `flush` once the recorder
 * is settled again: the combination that started a recording must still be
 * able to stop it, and the menu is locked in those states anyway (review F2).
 */
import type { HotkeyAccelerator, HotkeySettings } from "../shared/hotkey";

/**
 * Chromium's macOS listener binds an accelerator to whichever key types its
 * character in the current layout. Under Zhuyin only the keypad types 1, so
 * ⌘⇧1 moved there while the editor records physical keys and refuses the
 * keypad. Disabling the feature registers the fixed US physical key
 * (docs/system-design/desktop.md#recording-shortcut).
 */
export const LAYOUT_AWARE_HOTKEYS_FEATURE = "LayoutAwareGlobalHotkeys";

/**
 * The `disable-features` value main must set before app ready, or undefined
 * when nothing changes. Chromium keeps only the last value of a repeated
 * switch, so an existing list is extended rather than replaced.
 */
export function physicalHotkeyFeatures(current: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "darwin") return undefined;
  const features = current.split(",").map(feature => feature.trim()).filter(Boolean);
  // An entry may carry a field-trial suffix: `Feature<Trial`.
  if (features.some(feature => feature.split("<")[0] === LAYOUT_AWARE_HOTKEYS_FEATURE)) return undefined;
  return [...features, LAYOUT_AWARE_HOTKEYS_FEATURE].join(",");
}

/** The subset of `Electron.GlobalShortcut` this module uses; tests inject a fake. */
export interface GlobalShortcutApi {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export type HotkeyStatus =
  | { kind: "disabled" }
  | { kind: "suspended" }
  | { kind: "registered"; accelerator: HotkeyAccelerator }
  | { kind: "failed"; accelerator: HotkeyAccelerator; reason: string };
/** `deferred`: the settings are saved, the OS registration follows when the recorder settles. */
export type HotkeyRequestResult = HotkeyStatus | { kind: "deferred" };

export interface RecordingHotkeyOptions {
  globalShortcut: GlobalShortcutApi;
  /** The tray's left-click action. */
  onToggle: () => void;
  log?: (message: string) => void;
}

export class RecordingHotkey {
  private _status: HotkeyStatus = { kind: "disabled" };
  private suspended = false;
  private disposed = false;
  private current: HotkeySettings | undefined;
  private pending: HotkeySettings | undefined;
  private readonly log: (message: string) => void;

  constructor(private readonly options: RecordingHotkeyOptions) {
    this.log = options.log ?? (() => undefined);
  }

  get status(): HotkeyStatus {
    return this._status;
  }

  /**
   * Make the OS registration match `settings`: the previous accelerator is
   * released first, so a change never leaves two combinations active. Returns
   * the new status; `failed` means the settings were saved but the key does
   * nothing until the conflict is resolved or another preset is chosen.
   */
  apply(settings: HotkeySettings): HotkeyStatus {
    if (this.disposed) return this._status;
    this.current = { ...settings };
    this.pending = undefined;
    this.release();
    if (this.suspended) return this._status = { kind: "suspended" };
    if (!settings.enabled) {
      this._status = { kind: "disabled" };
      this.log("hotkey: disabled");
      return this._status;
    }
    const accelerator = settings.accelerator;
    let registered = false;
    let reason = "another application may already use this shortcut";
    try {
      registered = this.options.globalShortcut.register(accelerator, () => this.pressed(accelerator));
    } catch (cause) {
      reason = cause instanceof Error ? cause.message : String(cause);
    }
    if (registered) {
      this._status = { kind: "registered", accelerator };
      this.log(`hotkey: registered ${accelerator}`);
    } else {
      this._status = { kind: "failed", accelerator, reason };
      this.log(`hotkey: registration failed for ${accelerator}: ${reason}`);
    }
    return this._status;
  }

  /**
   * `apply` when the recorder is settled (idle / needsPermission); otherwise
   * remember the request and keep the current registration untouched.
   */
  request(settings: HotkeySettings, settled: boolean): HotkeyRequestResult {
    if (settled) return this.apply(settings);
    this.pending = settings;
    this.log(`hotkey: change to ${JSON.stringify(settings)} deferred until the recorder is settled`);
    return { kind: "deferred" };
  }

  /** Called on every state change; applies a deferred request once settled. Undefined when nothing was pending. */
  flush(settled: boolean): HotkeyStatus | undefined {
    if (!settled || !this.pending) return undefined;
    return this.apply(this.pending);
  }

  /** Release OS ownership while the settings panel records a replacement. */
  suspend(): void {
    if (this.disposed || this.suspended) return;
    this.suspended = true;
    this.release();
    this._status = { kind: "suspended" };
    this.log("hotkey: suspended");
  }

  resume(): HotkeyStatus {
    if (this.disposed || !this.suspended) return this._status;
    this.suspended = false;
    // A deferred request belongs to flush(), not to capture cancellation.
    const pending = this.pending;
    if (this.current) this.apply(this.current);
    else this._status = { kind: "disabled" };
    this.pending = pending;
    return this._status;
  }

  /** Quit path: leave nothing registered. */
  dispose(): void {
    this.disposed = true;
    this.suspended = false;
    this.current = undefined;
    this.pending = undefined;
    this.release();
    this._status = { kind: "disabled" };
  }

  private pressed(accelerator: HotkeyAccelerator): void {
    if (this.disposed || this.suspended || this._status.kind !== "registered" || this._status.accelerator !== accelerator) return;
    this.log(`hotkey: ${accelerator} pressed`);
    this.options.onToggle();
  }

  private release(): void {
    if (this._status.kind !== "registered") return;
    try {
      this.options.globalShortcut.unregister(this._status.accelerator);
    } catch (cause) {
      this.log(`hotkey: unregister ${this._status.accelerator} failed: ${String(cause)}`);
    }
  }
}

/** Suspending/cancelling capture must not repeat an already reported refusal. */
export function shouldNotifyHotkeyFailure(previous: HotkeyRequestResult | undefined, result: HotkeyRequestResult): boolean {
  return result.kind === "failed" && (previous?.kind !== "failed"
    || previous.accelerator !== result.accelerator || previous.reason !== result.reason);
}
