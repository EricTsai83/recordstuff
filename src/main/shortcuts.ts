/**
 * The two global shortcuts and the recording shortcut's saved setting
 * (docs/system-design/desktop.md#recording-shortcut). The recording key calls
 * the tray's toggle; the Settings key opens the panel.
 *
 * Custom capture suspends both and releasing it restores whatever is
 * committed at that moment, whether or not a save is still pending. A save
 * persists first and only then asks for its registration, which waits for a
 * running session to settle so the key that started it can still stop it.
 */
import { isSettingsShortcut, type HotkeySettings } from "../shared/hotkey";
import { RecordingHotkey, shouldNotifyHotkeyFailure, type GlobalShortcutApi, type HotkeyRequestResult, type HotkeyStatus } from "./hotkey";
import { SettingsHotkey, type SettingsHotkeyStatus } from "./settings-hotkey";

export interface AppShortcutsOptions {
  globalShortcut: GlobalShortcutApi;
  platform: string;
  /** The tray's left-click action. */
  toggle: () => void;
  openSettings: () => void;
  store: { readonly hotkey: HotkeySettings; setHotkey(setting: HotkeySettings): Promise<void> };
  /** idle or needsPermission: the only states that may change a registration. */
  settled: () => boolean;
  notifyRegistrationFailed: (accelerator: string) => void;
  notifyWriteFailed: () => void;
  refresh: () => void;
  log: (message: string) => void;
}

export class AppShortcuts {
  private readonly recording: RecordingHotkey;
  private readonly settingsKey: SettingsHotkey;
  private lastReport: HotkeyRequestResult | undefined;

  constructor(private readonly options: AppShortcutsOptions) {
    this.recording = new RecordingHotkey({ globalShortcut: options.globalShortcut, onToggle: options.toggle, log: options.log });
    this.settingsKey = new SettingsHotkey({ globalShortcut: options.globalShortcut, platform: options.platform,
      open: options.openSettings, log: options.log });
  }

  get status(): HotkeyStatus { return this.recording.status; }
  get settingsStatus(): SettingsHotkeyStatus { return this.settingsKey.status; }

  /** The saved combination is the live one; a deferred change reads as unavailable until it applies. */
  get registered(): boolean {
    const status = this.recording.status;
    return status.kind === "registered" && status.accelerator === this.options.store.hotkey.accelerator;
  }

  /** Register the saved setting at launch. */
  start(): void {
    this.request(this.options.store.hotkey);
  }

  capture(armed: boolean): void {
    if (armed) { this.settingsKey.suspend(); this.recording.suspend(); }
    else { this.report(this.recording.resume()); this.settingsKey.resume(); }
    this.options.refresh();
  }

  /**
   * Persist first, register second: a failed write keeps the old setting and
   * registration. A recording that starts while the write is pending keeps
   * its shortcut; the registration change waits for the recorder to settle.
   */
  async set(setting: HotkeySettings): Promise<void> {
    if (!this.options.settled() || (setting.enabled && isSettingsShortcut(setting.accelerator, this.options.platform))) return;
    try {
      await this.options.store.setHotkey(setting);
    } catch (cause) {
      this.options.log(`settings: failed to save hotkey ${JSON.stringify(setting)}: ${String(cause)}`);
      this.options.notifyWriteFailed();
      return;
    }
    // An explicit successful save deserves a fresh refusal notification; a cancel does not.
    this.lastReport = undefined;
    this.options.log(`settings: hotkey ${JSON.stringify(this.options.store.hotkey)}`);
    this.request(this.options.store.hotkey);
  }

  /** On every recorder state change: a change saved during a session applies once it settles. */
  flush(): void {
    this.report(this.recording.flush(this.options.settled()));
  }

  /** Quit path: leave nothing registered. */
  dispose(): void {
    this.settingsKey.dispose();
    this.recording.dispose();
  }

  /** Register with the OS and surface a refusal in the menu and a notification. */
  private request(setting: HotkeySettings): void {
    this.report(this.recording.request(setting, this.options.settled()));
  }

  private report(result: HotkeyRequestResult | undefined): void {
    if (!result) return;
    // Use live ownership during deferred changes; never steal a session stop key.
    const status = this.recording.status;
    this.settingsKey.reconcile(status.kind === "registered" ? { enabled: true, accelerator: status.accelerator } : this.options.store.hotkey);
    if (result.kind === "failed" && shouldNotifyHotkeyFailure(this.lastReport, result)) this.options.notifyRegistrationFailed(result.accelerator);
    if (result.kind !== "deferred" && result.kind !== "suspended") this.lastReport = result;
    this.options.refresh();
  }
}
