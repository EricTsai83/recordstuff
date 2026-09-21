/**
 * The vocabulary both user interfaces share (docs/system-design/desktop.md):
 * one action union and one read-only context snapshot.
 *
 * The tray ([tray-model.ts](tray-model.ts)) and the settings panel
 * ([settings-model.ts](settings-model.ts)) are two independent pure
 * projections of the same state and context; neither is derived from the
 * other's menu. Every action either interface can raise ends at the single
 * handler in index.ts, which re-checks the recording state before acting.
 */
import type { Language } from "../shared/i18n";
import type { QualitySettings } from "../shared/quality";
import type { HotkeySettings } from "../shared/hotkey";
import type { RecordingState } from "../shared/state";

import type { UpdateState } from "./updates";

export const APP_NAME = "RecordStuff";

export type AppAction =
  | "openSettings"
  | "openPermissionSettings"
  | "openNotificationSettings"
  | "relaunch"
  | "stop"
  | "revealLastSaved"
  | "openOutputDir"
  | "changeOutputDir"
  | "revealLog"
  | "quit"
  | "checkUpdates"
  | "openUpdate"
  | { setUpdateChecks: boolean }
  | { setNotifications: boolean }
  | { setQuality: Partial<QualitySettings> }
  | { setLanguage: Language }
  | { setHotkey: HotkeySettings };

/** The persisted choice plus whether the OS actually accepted the registration. */
export interface AppHotkey extends HotkeySettings {
  registered: boolean;
}

export interface AppContext {
  platform: NodeJS.Platform;
  outputDir: string;
  homeDir: string;
  quality: QualitySettings;
  language: Language;
  hotkey: AppHotkey;
  updates: { state: UpdateState; enabled: boolean };
  /** The app's own switch. Electron cannot read the OS notification permission. */
  notifications: boolean;
}

/**
 * Settings that touch a live capture may change only while the recorder is
 * settled. Both interfaces and the action handler use this same rule.
 */
export function preferencesUnlocked(state: RecordingState): boolean {
  return state.type === "idle" || state.type === "needsPermission";
}

export function abbreviateHome(filePath: string, homeDir: string): string {
  const home = homeDir.replace(/[\\/]+$/, "");
  if (home.length === 0) return filePath;
  if (filePath === home) return "~";
  const sep = filePath.startsWith(home + "/") ? "/" : filePath.startsWith(home + "\\") ? "\\" : "";
  return sep ? `~${sep}${filePath.slice(home.length + 1)}` : filePath;
}
