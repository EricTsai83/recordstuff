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
import type { RecordingResult, RecordingResultAction } from "../shared/recording-result";
import type { Appearance, TrayClick } from "../shared/appearance";
import type { DisplayInfo, DisplayPreference, DisplayFailure } from "../shared/display";
import type { Language } from "../shared/i18n";
import type { QualitySettings } from "../shared/quality";
import type { CountdownSeconds } from "../shared/countdown";
import type { HotkeySettings } from "../shared/hotkey";
import type { RecordingState } from "../shared/state";
import type { SettingsHotkeyStatus } from "./settings-hotkey";
import type { UpdateState } from "./updates";
import type { QuitDeferral } from "./quit-feedback";
import type { LibraryState, RecordingFileAction } from "./recordings-library";

export const APP_NAME = "RecordStuff";


export type AppAction =
  | "openSettings"
  | "openRecordingResult"
  /** Settings on the General tab, where the shortcut card, its retry and the editor are. */
  | "openShortcutSettings"
  /** Settings on the Recording tab, where the resolution warning a capture notice names is shown. */
  | "openRecordingSettings"
  /** The window on Recordings with the newest recording in view and focused: the tray's way to the last take. */
  | "showLastRecording"
  | { recordingResult: { id: string; action: RecordingResultAction } }
  /** A video the Recordings tab lists, by the id the page was given. */
  | { recordingFile: { id: string; action: RecordingFileAction } }
  | "openPermissionSettings"
  | "openNotificationSettings"
  | "relaunch"
  | "start"
  | "stop"
  | "cancelCountdown"
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
  | { setTrayClick: TrayClick }
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
  /** The output folder's videos for the Recordings tab; absent before the first listing. */
  library?: LibraryState;
  /** The running app's version, shown beside the credit in Settings. */
  version?: string;
  quality: QualitySettings;
  countdown: CountdownSeconds;
  /** The stored switch (plan 046); it only sounds while the countdown is on. */
  countdownSound: boolean;
  language: Language;
  appearance?: Appearance;
  /** The icon's left click; absent is the click that records, as before the choice. */
  trayClick?: TrayClick;
  hotkey: AppHotkey;
  settingsShortcut?: SettingsHotkeyStatus;
  updates: { state: UpdateState; enabled: boolean };
  /** The app's own switch. Electron cannot read the OS notification permission. */
  notifications: boolean;
  /** Quit waits for recording work to finish; the tray says so until the app exits or quit is deferred. */
  quitting?: boolean;
  /**
   * The last quit was deferred and what held it (plan 056). Its notification may be refused,
   * hidden by Focus or muted while the display is shared, so the tray says so too, until the
   * next state change or quit, or until what held it has finished.
   */
  quitDeferred?: QuitDeferral;
  /** An uncaught exception's error box waits for recording work to settle (plan 056). */
  errorBoxHeld?: boolean;
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

export function abbreviateHome(filePath: string, homeDir: string): string {
  const home = homeDir.replace(/[\\/]+$/, "");
  if (home.length === 0) return filePath;
  if (filePath === home) return "~";
  const sep = filePath.startsWith(home + "/") ? "/" : filePath.startsWith(home + "\\") ? "\\" : "";
  return sep ? `~${sep}${filePath.slice(home.length + 1)}` : filePath;
}
