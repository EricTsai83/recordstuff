import { SETTINGS_SHORTCUT, isSettingsShortcut, type HotkeySettings } from "../shared/hotkey";
import { RecordingHotkey, type GlobalShortcutApi, type HotkeyStatus } from "./hotkey";

export type SettingsHotkeyStatus = HotkeyStatus | { kind: "conflict" };

/** Independent ownership; stored recording shortcuts always have priority. */
export class SettingsHotkey {
  private readonly registration: RecordingHotkey;
  private conflict = false;
  private suspended = false;
  private disposed = false;
  private initialized = false;
  constructor(private readonly options: {
    globalShortcut: GlobalShortcutApi; platform: string; open: () => void; log: (message: string) => void;
  }) {
    this.registration = new RecordingHotkey({ globalShortcut: options.globalShortcut, onToggle: options.open,
      log: message => options.log(message.replace("hotkey:", "settings shortcut:")) });
  }
  get status(): SettingsHotkeyStatus {
    return this.conflict ? { kind: "conflict" } : this.registration.status;
  }
  reconcile(recording: HotkeySettings): void {
    if (this.disposed) return;
    const conflict = recording.enabled && isSettingsShortcut(recording.accelerator, this.options.platform);
    if (this.initialized && conflict === this.conflict) return;
    this.initialized = true;
    this.conflict = conflict;
    if (conflict) this.options.log("settings shortcut: unavailable; recording shortcut owns the combination");
    this.registration.apply({ enabled: !conflict, accelerator: SETTINGS_SHORTCUT });
  }
  suspend(): void {
    if (this.disposed) return;
    this.suspended = true;
    this.registration.suspend();
  }
  resume(): void {
    if (this.disposed || !this.suspended) return;
    this.suspended = false;
    this.registration.resume();
  }
  dispose(): void { this.disposed = true; this.registration.dispose(); }
}
