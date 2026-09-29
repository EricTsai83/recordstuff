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
import type { RecordingResult } from "../shared/recording-result";
import type { Appearance } from "../shared/appearance";
import type { DisplayInfo, DisplayPreference, DisplayFailure } from "../shared/display";
import type { Language } from "../shared/i18n";
import type { QualitySettings } from "../shared/quality";
import type { CountdownSeconds } from "../shared/countdown";
import type { HotkeySettings } from "../shared/hotkey";
import type { RecordingState } from "../shared/state";
import type { SettingsHotkeyStatus } from "./settings-hotkey";
import type { UpdateState } from "./updates";

export const APP_NAME = "RecordStuff";

/** What the user can do with one failure-history record. */
export type RecordingResultAction = "acknowledge" | "retry" | "remove" | "reveal" | "folder" | "permission" | "relaunch";

export type AppAction =
  | "openSettings"
  | "openRecordingResult"
  | { recordingResult: { id: string; action: RecordingResultAction } }
  | "openPermissionSettings"
  | "openNotificationSettings"
  | "relaunch"
  | "start"
  | "stop"
  | "cancelCountdown"
  | "revealLastSaved"
  | "openOutputDir"
  | "changeOutputDir"
  | "revealLog"
  | "quit"
  | "retryShortcuts"
  | "checkUpdates"
  | "openWebsite"
  | "openSource"
  | "openUpdate"
  | { setUpdateChecks: boolean }
  | { setNotifications: boolean }
  | { setDisplay: DisplayPreference }
  | { setQuality: Partial<QualitySettings> }
  | { setCountdown: CountdownSeconds }
  | { setCountdownSound: boolean }
  | { setAppearance: Appearance }
  | { setLanguage: Language }
  | { setHotkey: HotkeySettings };

/** The persisted choice plus whether the OS actually accepted the registration. */
export interface AppHotkey extends HotkeySettings {
  registered: boolean;
}

export interface AppContext {
  recordingResults?: readonly RecordingResult[];
  /** Saved failure history is still being read; new failures are already listed. */
  historyLoading?: boolean;
  historyFailed?: boolean;
  historyLimit?: number;
  captureWarning?: string;
  displays: DisplayInfo[];
  display: DisplayPreference;
  displayFailure?: DisplayFailure;
  platform: NodeJS.Platform;
  outputDir: string;
  homeDir: string;
  quality: QualitySettings;
  countdown: CountdownSeconds;
  /** The stored switch (plan 046); it only sounds while the countdown is on. */
  countdownSound: boolean;
  language: Language;
  appearance?: Appearance;
  hotkey: AppHotkey;
  settingsShortcut?: SettingsHotkeyStatus;
  updates: { state: UpdateState; enabled: boolean };
  /** The app's own switch. Electron cannot read the OS notification permission. */
  notifications: boolean;
  /** Quit waits for recording work to finish; the tray says so until the app exits or quit is deferred. */
  quitting?: boolean;
  /** When the view is built; failure rows are grouped by day relative to it. Tests pin it. */
  now?: Date;
}

/**
 * Settings that touch a live capture may change only while the recorder is
 * settled. Both interfaces and the action handler use this same rule.
 */
export function preferencesUnlocked(state: RecordingState): boolean {
  return state.type === "idle" || state.type === "needsPermission";
}

/**
 * A long path for a menu label: the start, an ellipsis and the last folder, so
 * the menu stays narrow; the full path belongs in the tooltip.
 */
export function compactPath(display: string, max = 40): string {
  if (display.length <= max) return display;
  const sep = display.includes("/") ? "/" : "\\";
  // A trailing separator would leave an empty last folder.
  const parts = display.replace(/[\\/]+$/, "").split(sep);
  // An absolute path's empty first part keeps its root: "/Volumes".
  const segments = parts[0] === "" ? [`${sep}${parts[1] ?? ""}`, ...parts.slice(2)] : parts;
  const last = segments.at(-1) ?? "";
  for (const keep of [2, 1]) {
    if (segments.length <= keep + 1) continue;
    const candidate = [...segments.slice(0, keep), "…", last].join(sep);
    if (candidate.length <= max) return candidate;
  }
  const tail = `…${sep}${last}`;
  return tail.length <= max ? tail : `…${last.slice(last.length - (max - 1))}`;
}

export function abbreviateHome(filePath: string, homeDir: string): string {
  const home = homeDir.replace(/[\\/]+$/, "");
  if (home.length === 0) return filePath;
  if (filePath === home) return "~";
  const sep = filePath.startsWith(home + "/") ? "/" : filePath.startsWith(home + "\\") ? "\\" : "";
  return sep ? `~${sep}${filePath.slice(home.length + 1)}` : filePath;
}
