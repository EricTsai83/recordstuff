/**
 * The contract between main and the settings panel (docs/system-design/desktop.md).
 *
 * The panel is a projection, never a second source of truth: main sends
 * language-neutral text plus stable group/choice ids, and the panel echoes an
 * id back. Ids identify a setting, not an action, so nothing the renderer
 * sends can describe work main did not already offer.
 */
import type { EditorChoice, EditorView } from "./editing";
import type { FullScreenChoice, PlaybackState } from "./video-player";
import type { Language } from "./i18n";
import type { ErrorCode, RecordingState } from "./state";
import type { RecordingFailure } from "./recording-result";
import type { LibraryLayout } from "./appearance";

export interface SettingsChoice {
  id: string;
  label: string;
  enabled: boolean;
  checked: boolean;
  /** Offered, but its own work is running: the button keeps focus and ignores activation until it ends (plan 053). */
  busy?: boolean;
  /** A screen choice's place in the desktop's arrangement, in logical pixels; presentation only. */
  display?: DisplayFrame;
  /** One line saying what the choice does, shown with it (the Studio's preview rates, plan 092). */
  description?: string;
}
export interface DisplayFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
  /** The display's own name, without the label's Primary suffix or size. */
  name: string;
  /** Its size in pixels, `3024×1964`. */
  pixels: string;
}
/**
 * The Settings window's tabs, in the sidebar's order. `failures` is the stable entry id for Troubleshooting, which also
 * contains diagnostic and cleanup actions.
 */
export const SETTINGS_TABS = ["library", "studio", "recording", "general", "shortcuts", "failures"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
/** Whether `value` names a tab: what a page's control or the window's storage hands back is any string. */
export function isSettingsTab(value: unknown): value is SettingsTab {
  return (SETTINGS_TABS as readonly unknown[]).includes(value);
}
/** One row of the Keyboard Shortcuts tab (plan 073): read-only, from `shortcut-catalog.ts`. */
export interface ShortcutRowView {
  id: string;
  label: string;
  /** Alternatives, any of which works; each the keys pressed together, as shown. */
  keys: string[][];
  /** Each alternative as one phrase, for assistive technology. */
  spoken: string[];
  /** A pointer gesture that does the same, in words. */
  gesture?: string;
  /** Where the keys work, when narrower than the section. */
  where?: string;
  /** A global shortcut that does not work now: Off, or Unavailable with the Shortcut card's reason. */
  status?: { kind: "off" | "unavailable"; label: string; reason?: string };
  /** The recording shortcut's way to the Shortcut card, which changes it; the list itself edits nothing. */
  change?: string;
}
export interface SettingsGroup {
  id: string;
  label: string;
  tab: Exclude<SettingsTab, "library">;
  kind?: "actions" | "shortcut" | "shortcutList";
  /** A `shortcutList` group's rows. */
  shortcuts?: ShortcutRowView[];
  /**
   * Presentation only; omitted controls default to a native menu. `text` is a field whose committed value is the one
   * checked choice's id; the page sends what was typed as the choice, which main validates (the file name pattern).
   * `arrangement` draws the screens where they stand on the desktop, from their choices' `display` frames.
   */
  control?: "switch" | "segmented" | "menu" | "text" | "arrangement" | "slider" | "number" | "cameraPreview" | "meter" | "inputMeter";
  /**
   * A `slider`'s range and value, whole steps in `unit`; the page sends the value let go of as the choice, which main
   * validates (plan 075's camera size and rounding, and D21's volumes). `scale: "volume"` lays a volume out as the
   * faders do, 100% in the middle (audio-volume.ts `volumeToFader`); otherwise the track is linear.
   */
  slider?: { min: number; max: number; step: number; value: number; unit: "percent"; scale?: "volume" };
  /**
   * A `number` field's range and value, whole steps in `unit`, and the short name shown in it (the camera's width, height
   * and rounding, 2026-10-21); the page sends the value entered as the choice, which main validates.
   */
  number?: { min: number; max: number; step: number; value: number; unit: "px" | "percent"; short: string };
  /**
   * `inputMeter` (plan 079, D1) is the chosen input's level between recordings, which the page gets apart from the
   * view while it shows it. A `meter`'s input (plan 075, D19): its level, which the page gets apart from the view, and its mute, the choices
   * `mute` and `unmute`, one checked.
   */
  meter?: { source: "system" | "microphone" };
  /** The Recording Studio's controls (plan 075, D19): when the recording in progress began, for the elapsed time. */
  elapsedSince?: string;
  /** The Recording Studio's controls: where the recording is, which the page draws its state with (2026-10-21). */
  phase?: "idle" | "blocked" | "starting" | "countdown" | "recording" | "saving";
  /** A `cameraPreview`'s stage and bubble (plan 075 step 7); the page sends a new position as the choice `x,y`. */
  cameraPreview?: CameraPreviewView;
  /** Segments drawn as icons named by their labels (Appearance's screen, sun and moon); presentation only. */
  iconChoices?: boolean;
  /** Consecutive rows with this id share an inset list. */
  section?: string;
  sectionHeading?: string;
  /** Omitted notes are static explanations. */
  noteKind?: "explanation" | "status";
  diagnostics?: Array<{ kind: "current" | "history"; heading: string; reason: string; guidance: string }>;
  /** References a currently offered choice; never a new action payload. */
  recovery?: { choice: string; label: string };
  capturing?: boolean;
  /** The last unsubmitted editor expired; cleared by another edit or shortcut choice. */
  captureTimedOut?: boolean;
  platform?: string;
  /** Extra line under the control, e.g. the output folder's path or an update check's result; problems go in `diagnostics`. */
  note?: string;
  /** A line under the group's whole section, such as the Video section's size estimate. */
  footnote?: string;
  /** A secondary explanation behind an ⓘ beside the label, shown on hover, focus or click and still describing the control. */
  info?: string;
  enabled: boolean;
  choices: SettingsChoice[];
  /**
   * Buttons rendered under this group's control. They carry no committed
   * value, so a preference and the system pane that can override it can share
   * one card: changing the switch and checking the OS are one decision.
   */
  actions?: SettingsChoice[];
}
/**
 * Settings' camera preview (plan 075 step 7): the recorded display to scale, and the bubble
 * where the recording puts it. Before recording the page shows the camera itself in the bubble (`live`), while a
 * recording composes the camera the engine's preview of the whole picture (`recording`); `off` shows the outline only.
 */
export interface CameraPreviewView {
  mode: "live" | "recording" | "off";
  /** The display's logical size. */
  display: { width: number; height: number };
  /** The bubble's shape (fractions of the display's shorter side), as the recording composes it. */
  bubble: { width: number; height: number; rounding: number; mirror: boolean };
  /** Whether the bubble is part of the picture: not in a session that composes no camera, which has nothing to place. */
  composed: boolean;
  /** Its position, a fraction of the free space on each axis. */
  x: number;
  y: number;
  /** What the stage says without a picture. */
  status?: string;
  /** What the Studio's Camera view (plan 094) says without a camera to show: lost, not ready, hidden or not in the session. */
  cameraStatus?: string;
  /** The engine's picture is shown and composes the camera, which gives no picture yet (waiting, not ready or lost): the
   * page marks its place with the placeholder until it does (2026-10-25, the maintainer's choice). */
  cameraAwaited?: boolean;
}
export interface RecordingResultView {
  id: string;
  /** Stable identities for the cause icon and preservation badge; never inferred from localized text or a path. */
  code: ErrorCode;
  outcomeState: RecordingFailure["outcome"];
  reason: string;
  /** Localized day heading the row is grouped under: Today, Yesterday or the date (plan 047). */
  day: string;
  /** Short local time of day. */
  time: string;
  outcome: string;
  guidance: string;
  persistenceWarning?: string;
  /** Localized: an acknowledgement or removal waits for a durable save. */
  saving?: string;
  detail: string;
  /** The full path, shown with the technical details. */
  file?: string;
  /** The file's name, shown in the row. */
  fileName?: string;
  acknowledged: boolean;
  actions: SettingsChoice[];
}
/**
 * Status cards sit at the sidebar's foot or below narrow tabs: what the app is doing,
 * shown only when there is something to say (2026-10-04), never while ready. It is not a live region;
 * `#feedback` stays the page's one announcer.
 */
export interface SettingsStatus {
  tone: "ready" | "busy" | "recording" | "attention";
  /**
   * The state it says, which the page reads out once as it begins: starting and the countdown share the busy tone,
   * and each countdown second changes the title, so neither tells a new state.
   */
  phase?: RecordingState["type"] | "quitting" | "saving";
  title: string;
  /** What to do about an attention state; empty while ready, and while the lock `hint` explains a busy one. */
  detail: string;
  /** What fixes a problem that blocks recording; chosen as group `status`. Starting stays with the tray and the shortcut. */
  action?: { id: StatusActionId; label: string };
  /** A secondary recovery action after the primary one: Relaunch once access may already be granted, as the tray offers. */
  secondaryAction?: { id: StatusActionId; label: string };
}
export type StatusActionId = "permission" | "relaunch" | "folder" | "primary" | "mediaComponents";
/** One video in the Recordings tab; the page reaches its bytes only through these URLs, which name an id. */
export interface LibraryItemView {
  id: string;
  /** The file's name without its extension: what the card, the player and full screen are titled by. */
  title: string;
  /** Short local time it was recorded at, shown beside the day heading's date: the name's own timestamp, else the file's birth. */
  time: string;
  /** Localized day heading: Today, Yesterday or the date. */
  day: string;
  name: string;
  /** `1:23`, absent until its length is read. */
  duration?: string;
  size: string;
  thumbnail: string;
  video: string;
  /** The output folder's subfolder it is in (plan 071); absent for one in the output folder itself (Not in a folder). */
  folder?: string;
  /** Localized "Editable" for an editable recording (plan 087), once its boxes are read; absent otherwise. */
  editable?: string;
  /** Localized "Edited" for a recording that holds an edit (2026-10-26): its menu offers Continue editing…. */
  edited?: string;
}
/** A subfolder the Recordings tab offers (plan 071); its recordings are the items naming it. */
export interface LibraryFolderView {
  name: string;
  /** Holds no visible file, so Delete folder is offered. */
  empty: boolean;
}
export interface LibraryView {
  /** The output folder as shown, home abbreviated. */
  folder: string;
  /** Large thumbnails in a grid, or one row each (2026-10-05); chosen as group `library`, choice `grid` or `list`. Absent is the grid. */
  layout?: LibraryLayout;
  /** A grid card's hover preview plays its sound (2026-10-14); chosen as group `library`, choice `previewSound:on` or `previewSound:off`. Absent is muted. */
  previewSound?: boolean;
  /** Localized: the recording Move to Trash just took, which Undo (group `library`, choice `undoTrash`) brings back while it waits. */
  trashed?: { name: string; message: string; undo: string };
  /** Localized: a delayed move to the Trash that failed; the recording is listed again. */
  notice?: string;
  /** Localized: loading or an unreadable folder; the list is empty meanwhile. */
  status?: string;
  /** "12 recordings · 2.4 GB". */
  summary?: string;
  items: LibraryItemView[];
  /** By name; absent or empty when the output folder has none. */
  folders?: LibraryFolderView[];
  /** Listed categories marked favorite, in the order they were added (2026-10-09). */
  favorites?: string[];
  /** The category the tab last showed, when it is still listed: `{ folder: null }` for Uncategorized; absent for all. */
  shown?: { folder: string | null };
}
/**
 * The first-launch guide (2026-10-26), while it is open: what each step stands at, which the page words. Its presses
 * are the `onboarding` group's choices (settings-model.ts): `screen:open`, `screen:relaunch`, `<input>:on`, `<input>:off`,
 * `<input>:allow`, `<input>:settings`, `finish` and `studio`.
 */
export interface OnboardingView {
  /** Screen & System Audio Recording: allowed, not yet, or allowed but seen only after a relaunch. */
  screen: "granted" | "needed" | "relaunch";
  microphone: OnboardingInputView;
  /** Absent where there is no camera to record. */
  camera?: OnboardingInputView;
  /** The recording shortcut as the keys read, absent while it is off or not registered. */
  shortcut?: string;
}
export interface OnboardingInputView {
  enabled: boolean;
  /** macOS's answer: allowed, refused (only System Settings changes it), or not asked yet. */
  access: "granted" | "denied" | "ask";
  /** Recording settings are locked while a recording runs. */
  locked: boolean;
}
export interface SettingsView {
  revision?: number;
  /** The first-launch guide, while it is open. */
  onboarding?: OnboardingView;
  library?: LibraryView;
  /** The edit view, while a recording is being edited (plan 085). */
  editor?: EditorView;
  status?: SettingsStatus;
  recordingResultsRemaining?: number;
  recordingResults?: RecordingResultView[];
  /** Localized status while saved history loads. */
  recordingHistoryStatus?: string;
  /** Offered with an unreadable history's status (plan 078): replaces it with an empty one, keeping the file. */
  recordingHistoryReset?: { label: string; enabled: boolean };
  /** Changes only on explicit entry through notification/tray; the page then selects `entryTab`. */
  resultFocus?: number;
  /** The tab that entry opens: Troubleshooting when absent, General for the shortcut card. */
  entryTab?: SettingsTab;
  /** With a Recordings entry: the recording to bring into view, from its saved notification. */
  libraryFocus?: string;
  language: Language;
  title: string;
  hint: string;
  /** Shown when a choice did not take effect; already localized. */
  failure: string;
  /** Troubleshooting is always offered; its label carries the unread failure count (plan 047). */
  tabs: Array<{ id: SettingsTab; label: string; accessibleLabel?: string }>;
  groups: SettingsGroup[];
}
/** IPC between main and the settings preload, which keeps its own copies: a sandboxed preload imports nothing at runtime (src/preload/channels.test.ts). */
/** How long a custom-shortcut capture stays armed; the editor's help and its timeout notice name the same limit. */
export const SHORTCUT_CAPTURE_TIMEOUT_MS = 15_000;
export const SETTINGS_CHANNELS = {
  zoom: "settings:zoom",
  zoomChanged: "settings:zoom-changed",
  capture: "settings:capture",
  read: "settings:read",
  choose: "settings:choose",
  changed: "settings:changed",
  ready: "settings:ready",
  /** RecordStuff was hidden (⌘H): the player stops, as nothing should sound from a window out of sight. */
  hidden: "settings:hidden",
  /**
   * Whether the camera preview is in sight (plan 075 step 7), and the Recording Studio's port, which a recording's
   * preview frames and levels come on (plan 081, studio-port.ts).
   */
  cameraPreview: "settings:camera-preview",
  cameraPreviewPort: "settings:camera-preview-port",
  /** Whether the Recording Studio's meters are in sight (plan 075, D19); their levels come on the Studio's port. */
  watchLevels: "settings:watch-levels",
  /** Whether the Recording tab's Input level is in sight in a focused window, and its levels (plan 079, D1). */
  watchMicrophoneLevel: "settings:watch-microphone-level",
  microphoneLevel: "settings:microphone-level",
  /** Whether the Recording Studio is open and in sight (plan 075, D20): a Live preview lasts only while it is. */
  watchStudio: "settings:watch-studio",
} as const;
/** A recording's new name, as typed in its card (group `recordingFile:<id>`); main checks it before renaming. */
export interface RenameChoice { action: "rename"; name: string }
export function isRenameChoice(value: unknown): value is RenameChoice {
  return typeof value === "object" && value !== null && (value as RenameChoice).action === "rename" && typeof (value as RenameChoice).name === "string";
}
/** Moves a recording (group `recordingFile:<id>`) into a listed folder, or with `null` into the output folder itself. */
export interface MoveChoice { action: "move"; folder: string | null }
export function isMoveChoice(value: unknown): value is MoveChoice {
  if (typeof value !== "object" || value === null || (value as MoveChoice).action !== "move") return false;
  const folder = (value as MoveChoice).folder;
  return folder === null || typeof folder === "string";
}
/** A folder action of the Recordings tab (group `libraryFolder`); main checks the name and that the folder is listed. */
export type FolderChoice =
  | { action: "createFolder"; name: string }
  | { action: "renameFolder"; folder: string; name: string }
  | { action: "removeFolder"; folder: string }
  /** The category the tab shows now, remembered across windows and launches: `null` is Uncategorized. */
  | { action: "showFolder"; folder: string | null }
  | { action: "showAll" }
  | { action: "favorite"; folder: string; favorite: boolean };
export function isFolderChoice(value: unknown): value is FolderChoice {
  if (typeof value !== "object" || value === null) return false;
  const choice = value as Record<string, unknown>;
  switch (choice.action) {
    case "createFolder": return typeof choice.name === "string";
    case "renameFolder": return typeof choice.folder === "string" && typeof choice.name === "string";
    case "removeFolder": return typeof choice.folder === "string";
    case "showFolder": return choice.folder === null || typeof choice.folder === "string";
    case "showAll": return true;
    case "favorite": return typeof choice.folder === "string" && typeof choice.favorite === "boolean";
    default: return false;
  }
}
export interface SettingsChoiceResult {
  view: SettingsView;
  /** Whether the requested choice is the committed one now. */
  applied: boolean;
  failure?: string;
  /** Main refused the value itself (a reserved or invalid shortcut): nothing was saved and choosing it again fails the same way. */
  refused?: true;
  /** A recording played full screen: where the video was when the viewer left (video-player.ts). */
  playback?: PlaybackState;
  /** A renamed or moved recording's new id, so its card keeps the focus. */
  renamed?: string;
  /** The folder a folder action made or renamed, so the tab can show it. */
  folder?: string;
}
/** What the preload exposes to the panel. */
export interface SettingsBridge {
  /** Uses the same persisted zoom as the window's keyboard and menu actions. */
  zoom?(request: SettingsZoomRequest): Promise<void>;
  onZoomChanged?(callback: (zoom: SettingsZoom) => void): () => void;
  /** The page's zoom factor as the renderer applies it now, whoever set it. */
  zoomFactor?(): number;
  read(): Promise<SettingsView>;
  capture(armed: boolean): Promise<SettingsView>;
  /** A choice is an offered option's id, a full-screen request for a recording (video-player.ts), its new name or folder, or a folder action. */
  choose(group: string, choice: string | FullScreenChoice | RenameChoice | MoveChoice | FolderChoice | EditorChoice): Promise<SettingsChoiceResult>;
  onChanged(callback: (view: SettingsView) => void): () => void;
  /** RecordStuff was hidden (⌘H); main says so before the window goes out of sight. The preload always offers it. */
  onHidden?(callback: () => void): () => void;
  /** The page has painted its first content (or its failed read): a new window may be shown now. */
  ready(): Promise<void>;
  /**
   * The camera preview is in sight, or no longer is (plan 075 step 7): while a recording composes the camera, main
   * joins the page to its preview frames, which arrive as a port posted to the page's window on
   * `SETTINGS_CHANNELS.cameraPreviewPort`.
   */
  watchCameraPreview?(watching: boolean): Promise<void>;
  /**
   * The Recording Studio's meters are in sight, or no longer are (plan 075, D19); levels then come on the Studio's
   * port, the camera preview's (plan 081).
   */
  watchLevels?(watching: boolean): Promise<void>;
  /** The Input level is in sight, or no longer is (plan 079, D1); the chosen input's levels then come to `onMicrophoneLevel`. */
  watchMicrophoneLevel?(watching: boolean): Promise<void>;
  onMicrophoneLevel?(callback: (level: MicrophoneLevel) => void): () => void;
  /** The Recording Studio is open and in sight, or no longer is (D20): main lets a Live preview go once it is not. */
  watchStudio?(open: boolean): Promise<void>;
}
/** A recording's inputs' loudest samples since the last levels, linear (1 is full scale). */
export interface StudioLevels { system: number; microphone?: number }
/** The chosen input's peak and RMS over the last 50 ms between recordings (plan 079, D1), linear. */
export interface MicrophoneLevel { peak: number; rms: number }

/**
 * The page's zoom steps (2026-10-05): ⌘+ and ⌘- (Ctrl elsewhere) move one step, ⌘0 returns to 100%. Kept between
 * 80% and 150%, where the sidebar layout and the cards still fit the default window.
 */
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;
export type SettingsZoomRequest = "in" | "out" | "reset";
export interface SettingsZoom { factor: number; canZoomIn: boolean; canZoomOut: boolean }
