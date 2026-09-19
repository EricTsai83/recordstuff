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

/** The subset of `Electron.GlobalShortcut` this module uses; tests inject a fake. */
export interface GlobalShortcutApi {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export type HotkeyStatus =
  | { kind: "disabled" }
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
    this.pending = undefined;
    this.release();
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

  /** Quit path: leave nothing registered. */
  dispose(): void {
    this.pending = undefined;
    this.release();
    this._status = { kind: "disabled" };
  }

  private pressed(accelerator: HotkeyAccelerator): void {
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
