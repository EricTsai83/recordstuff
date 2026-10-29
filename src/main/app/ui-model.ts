/**
 * The vocabulary both user interfaces share (docs/system-design/desktop.md):
 * one action union and one read-only context snapshot.
 *
 * The tray ([tray-model.ts](../menus/tray-model.ts)) and the settings panel
 * ([settings-model.ts](../settings/settings-model.ts)) are two independent pure
 * projections of the same state and context; neither is derived from the
 * other's menu. Every action either interface can raise ends at the single
 * handler in index.ts, which re-checks the recording state before acting.
 */
import type { EditorView } from "../../shared/editing";
import type { CameraLayout } from "../../shared/camera-layout";
import type { AudioVolume } from "../../shared/audio-volume";
import type { RecordingResult, RecordingResultAction } from "../../shared/recording-result";
import type { Appearance, LibraryLayout, TrayClick } from "../../shared/appearance";
import type { DisplayInfo, DisplayPreference, DisplayFailure } from "../../shared/display";
import type { SystemUiChoice } from "../../shared/system-ui";
import type { Language, PlainMessageKey } from "../../shared/i18n";
import type { QualitySettings } from "../../shared/quality";
import type { ErrorCode } from "../../shared/state";
import type { CountdownSeconds } from "../../shared/countdown";
import type { StudioPreviewRate, StudioPreviewSettings, StudioView } from "../../shared/studio-port";
import type { HotkeySettings } from "../../shared/hotkey";
import type { SettingsHotkeyStatus } from "../shortcuts/settings-hotkey";
import type { UpdateState } from "./updates";
import type { QuitDeferral } from "./quit-feedback";
import type { LibraryState, RecordingFileAction } from "../library/recordings-library";
import type { VideoState } from "../sharing/sharing";
import type { KeptEdit } from "../sharing/housekeeping";
import type { MicrophoneDevice } from "../../shared/protocol";

export type AppAction =
  | "openSettings"
  /** Return to the menu bar while keeping the Settings window's state. */
  | "hideSettings"
  | "openRecordingResult"
  /** Settings on the General tab, where the shortcut card, its retry and the editor are. */
  | "openShortcutSettings"
  /** Settings on the Keyboard Shortcuts tab (plan 073): the macOS Help menu's Keyboard Shortcuts. */
  | "openShortcutList"
  /** Settings on the Recording tab, where the microphone a lost-microphone notice names is set. */
  | "openRecordingSettings"
  /** The window on Recordings with the newest recording in view and focused: the tray's way to the last take. */
  | "showLastRecording"
  | { recordingResult: { id: string; action: RecordingResultAction } }
  /** A video the Recordings tab lists, by the id the page was given. */
  | { recordingFile: { id: string; action: RecordingFileAction } }
  /** Brings back the recording Move to Trash took last, while it still waits to be moved. */
  | "undoTrash"
  | "openPermissionSettings"
  | "openNotificationSettings"
  /** System Settings → Privacy & Security → Microphone (plan 074), macOS only. */
  | "openMicrophoneSettings"
  /** Settings' Search for devices (plan 079, D2): the audio inputs listed again at once. */
  | "searchMicrophones"
  /** System Settings → Privacy & Security → Camera on macOS, Settings → Privacy & security → Camera on Windows (plan 075). */
  | "openCameraSettings"
  /** Windows Settings → Optional features (plan 078), where the Media Feature Pack is installed; Windows only. */
  | "openOptionalFeatures"
  | "relaunch"
  | "start"
  /** Start recording with this one recording editable (2026-10-25), while the setting stays off; macOS only. */
  | "startEditable"
  | "stop"
  /** A Live preview in the Recording Studio (plan 075, D20), and letting it go. */
  | "startPreview"
  | "stopPreview"
  /** The recording's picture in the Recording Studio, shown or hidden while it records (2026-10-21). */
  | "showStudioPicture"
  | "hideStudioPicture"
  /** The main window at its Recording Studio tab (plan 075, D19). */
  | "openStudio"
  /** The first-launch guide (2026-10-26): macOS asked for the microphone or the camera, at the guide's own button. */
  | "askMicrophone"
  | "askCamera"
  /** The guide opened again, from General. */
  | "showOnboarding"
  /** The guide finished or set aside; `studio` then opens the Recording Studio. */
  | { finishOnboarding: { then?: "studio" } }
  /** The guide's own switches: the microphone's or the camera's saved on or off, never asking macOS (Allow asks). */
  | { setOnboardingInput: { input: "microphone" | "camera"; enabled: boolean } }
  | "cancelCountdown"
  | "openOutputDir"
  | "changeOutputDir"
  | "revealLog"
  /** Settings → General: clears the versions prepared for sharing, keeping those still held (plan 100). */
  | "clearVersionCache"
  /** Settings → General: removes the edits kept for recordings not in the Recordings tab (plan 100). */
  | "removeKeptEdits"
  | "quit"
  /** A quit held only by saves in the background: exit now, leaving them to be reported at the next launch. */
  | "quitWithoutWaiting"
  | "clearAppData"
  /** Troubleshooting's way out of an unreadable failure history (plan 078), after a confirmation. */
  | "resetFailureHistory"
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
  /** Plan 099: leave the menu bar, the Dock, or desktop icons and widgets out of recordings; macOS only. */
  | { setHideMenuBar: boolean }
  | { setHideDock: boolean }
  | { setHideDesktop: boolean }
  /** Plan 087: editable recordings, macOS only. */
  | { setEditableRecording: boolean }
  /** Open the Recording Studio as a recording starts (2026-10-28). */
  | { setStudioOnStart: boolean }
  | { setMicrophone: boolean }
  /** The Camera switch (plan 075, D10). */
  | { setCamera: boolean }
  /** Hides or shows the camera in the recording in progress (plan 075, D13); the camera stays open. */
  | { setCameraHidden: boolean }
  /** The camera to record (D9); `null` is the system default. */
  | { setCameraDevice: { id: string; label: string } | null }
  /** The bubble's shape or mirror (D1, D3, D8), also while recording (D7). */
  | { setCameraShape: { width?: number; height?: number; rounding?: number; mirror?: boolean } }
  /** A ratio button (D1): the width kept, the height made to match. */
  /** Mutes or unmutes an input of the recording in progress (plan 075, D19), for that recording only. */
  | { setAudioMuted: { source: "system" | "microphone"; muted: boolean } }
  /** An input's volume in whole dB (D21): saved, and taken by a preview or recording from its next sound on. */
  | { setAudioVolume: { source: "system" | "microphone"; volume: number } }
  /** Where the bubble sits on a display (plan 075 step 7): dragged or moved with the keys in Settings' preview. */
  | { setCameraPosition: { display: string; x: number; y: number } }
  /** `null` is the system default input. */
  | { setMicrophoneDevice: { id: string; label: string } | null }
  | { setAppearance: Appearance }
  | { setTrayClick: TrayClick }
  | { setFileNameTemplate: string }
  | { setLibraryLayout: LibraryLayout }
  | { setLibraryPreviewSound: boolean }
  /** The Recording Studio's preview rate or view (plan 092, D1, D3), at any time. */
  | { setStudioPreview: { rate?: StudioPreviewRate; view?: StudioView } }
  | { setLanguage: Language }
  | { setHotkey: HotkeySettings };

/** What the Microphone rows and the tray's checkbox show (plan 074). */
export interface MicrophoneContext {
  enabled: boolean;
  /** The stored input; absent is the system default. */
  device?: { id: string; label: string };
  /** The inputs the engine listed last; absent until they are listed, or when listing failed. */
  devices?: readonly MicrophoneDevice[];
  /** The inputs are being listed again (plan 079, D2): Search for devices is busy. */
  searching?: true;
  /** macOS's answer for the microphone (`getMediaAccessStatus`); absent on Windows, which has no status to read. */
  access?: "granted" | "denied" | "restricted" | "not-determined" | "unknown";
}

/** What the Camera row shows (plan 075). */
export interface CameraContext {
  enabled: boolean;
  /**
   * Whether the row is shown: until the Camera group can arrange the bubble (plan 075 step 7), only while the
   * development switch RECORDSTUFF_CAMERA_PROTOTYPE is on, so no one records a bubble they cannot place.
   */
  available: boolean;
  /** macOS's answer for the camera; absent on Windows, which has no status to read. */
  access?: "granted" | "denied" | "restricted" | "not-determined" | "unknown";
  /** The recording in progress composes the camera: whether it is hidden from the tray (D13). */
  session?: { hidden: boolean; state?: "waiting" | "notReady" | "lost" };
  /** The stored camera; absent is the system default (D9). */
  device?: { id: string; label: string };
  /** The cameras the engine listed last; absent until they are listed, or when listing failed. */
  devices?: readonly { id: string; name: string; default: boolean }[];
  /** The bubble's shape and mirror (D1–D3, D8); absent is the default's. */
  layout?: CameraLayout;
}

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
  displays: DisplayInfo[];
  display: DisplayPreference;
  displayFailure?: DisplayFailure;
  /** The stored switches of plan 099: what of the system's chrome macOS recordings leave out; absent is all shown. */
  systemUi?: SystemUiChoice;
  /**
   * The part of its display the session whose picture the Studio may show records, in pixels, as main cut it when that
   * session started (plan 099); absent without one. The preview keeps its proportions though a strip changes meanwhile.
   */
  captureArea?: { display: string; width: number; height: number };
  /** The stored switch for editable recordings (plan 087); absent is off. */
  editableRecording?: boolean;
  /** The stored switch that opens the Recording Studio as a recording starts (2026-10-28); absent is off. */
  studioOnStart?: boolean;
  /** The microphone (plan 074); absent is off with nothing known about the inputs. */
  microphone?: MicrophoneContext;
  /** The camera (plan 075); absent is off and not shown. */
  camera?: CameraContext;
  /**
   * The recording in progress's audio while it can be changed (plan 075, D19): what is muted, whether it has a microphone,
   * and whether the session is editable, which records every input as it comes (plan 097, D6).
   */
  audioSession?: { systemMuted: boolean; microphone?: { muted: boolean }; editable?: true };
  /**
   * Whether the session in progress, a Live preview's or a recording's, records an editable file (plan 087), which the
   * Studio's live controls follow (plan 097, D6); absent without a session.
   */
  editableSession?: boolean;
  /** Whether the next recording is editable: the setting, or the tray's Start editable recording once (plan 087). */
  editableNext?: boolean;
  /** The inputs' saved volumes in dB (plan 075, D21); absent is 0 dB. */
  audioVolume?: AudioVolume;
  /**
   * The Recording Studio's picture (plan 075, D20): a Live preview, whether it is live yet, the session the Studio
   * may show (a live preview or a recording), whether its picture is hidden during the recording, and why the last
   * preview could not start.
   */
  studio?: { preview?: { live: boolean }; showing: boolean; pictureHidden?: boolean; previewFailure?: ErrorCode };
  platform: NodeJS.Platform;
  /** Windows lacks Media Foundation (plan 078): recording cannot start until the Media Feature Pack is installed. */
  mediaComponentsMissing?: boolean;
  outputDir: string;
  homeDir: string;
  /** The output folder's videos for the Recordings tab; absent before the first listing. */
  library?: LibraryState;
  /** The edit view, while a recording is being edited (plan 085). */
  editor?: EditorView;
  /** The recordings that hold an edit, by path, with the size their edit was made for (EditStore `edited`). */
  editedRecordings?: ReadonlyMap<string, number>;
  /** Recordings whose Video is being prepared for sharing, or could not be, by path (plan 100). */
  preparingVideos?: ReadonlyMap<string, VideoState>;
  /** Each version being prepared or failed, by recording path, for Share… (plan 100 step 3). */
  shareStates?: ReadonlyMap<string, Partial<Record<import("../../shared/versions").VersionKind, VideoState>>>;
  /** Edits kept for recordings not in the Recordings tab (plan 100): Settings lists them and offers to remove them. */
  keptEdits?: readonly KeptEdit[];
  /** The bytes the versions prepared for sharing take in the cache (plan 100). */
  versionCacheBytes?: number;
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
  /** How new recordings are named (file-name.ts); absent is the default pattern. */
  fileNameTemplate?: string;
  /** The Recordings tab's grid or list; absent is the grid. */
  libraryLayout?: LibraryLayout;
  /** Whether a grid card's hover preview plays its sound; absent is muted. */
  libraryPreviewSound?: boolean;
  /** The Recording Studio's preview rate and view (plan 092); absent is the default, Off. */
  studioPreview?: StudioPreviewSettings;
  /** Favorite categories by name (settings.ts `libraryFavorites`). */
  libraryFavorites?: string[];
  /** The category the tab last showed: absent for every recording, `null` for Uncategorized. */
  libraryShown?: string | null;
  hotkey: AppHotkey;
  /** The first-launch guide is open (2026-10-26, macOS only); absent is closed. */
  onboarding?: { open: true };
  settingsShortcut?: SettingsHotkeyStatus;
  updates: { state: UpdateState; enabled: boolean };
  /** The app's own switch. Electron cannot read the OS notification permission. */
  notifications: boolean;
  /** Quit waits for recording work to finish; the tray says so until the app exits or quit is deferred. */
  quitting?: boolean;
  /**
   * What the quit waits on: recording work, then the settings, log and failure-history saves (and the prompt about
   * unsaved failures). Absent is recording work, the first step.
   */
  quitStep?: QuitDeferral;
  /**
   * The last quit was deferred and what held it (plan 056). Its notification may be refused,
   * hidden by Focus or muted while the display is shared, so the tray says so too, until the
   * next state change or quit, or until what held it has finished.
   */
  quitDeferred?: QuitDeferral;
  /** Recordings saved in the background after their capture stopped (2026-10-09); `slow` past the save watchdog. */
  saving?: readonly { file: string; slow: boolean }[];
  /** A quit, running or deferred, waits only for those saves, so quitting without waiting for them is offered. */
  quitWithoutWaiting?: boolean;
  /** An uncaught exception's error box waits for recording work to settle (plan 056). */
  errorBoxHeld?: boolean;
  /** When the view is built; failure rows are grouped by day relative to it. Tests pin it. */
  now?: Date;
}

/** What the tray and the window say while a quit waits, by the step it waits on (`AppContext.quitStep`). */
export const QUITTING_TEXT: Record<QuitDeferral, PlainMessageKey> = {
  media: "Quitting once the recording is saved or cleaned up…",
  metadata: "Quitting once settings and failure history are saved…",
};

export function abbreviateHome(filePath: string, homeDir: string): string {
  const home = homeDir.replace(/[\\/]+$/, "");
  if (home.length === 0) return filePath;
  if (filePath === home) return "~";
  const sep = filePath.startsWith(home + "/") ? "/" : filePath.startsWith(home + "\\") ? "\\" : "";
  return sep ? `~${sep}${filePath.slice(home.length + 1)}` : filePath;
}
