/**
 * The contract between main and the settings panel (docs/system-design/desktop.md).
 *
 * The panel is a projection, never a second source of truth: main sends
 * language-neutral text plus stable group/choice ids, and the panel echoes an
 * id back. Ids identify a setting, not an action, so nothing the renderer
 * sends can describe work main did not already offer.
 */
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
/** `failures` is the stable entry id for Troubleshooting, which also contains diagnostic and cleanup actions. */
export type SettingsTab = "library" | "recording" | "general" | "failures";
export interface SettingsGroup {
  id: string;
  label: string;
  tab: Exclude<SettingsTab, "library">;
  kind?: "actions" | "shortcut";
  /**
   * Presentation only; omitted controls default to a native menu. `text` is a field whose committed value is the one
   * checked choice's id; the page sends what was typed as the choice, which main validates (the file name pattern).
   * `arrangement` draws the screens where they stand on the desktop, from their choices' `display` frames.
   */
  control?: "switch" | "segmented" | "menu" | "text" | "arrangement";
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
export type StatusActionId = "permission" | "relaunch" | "folder" | "primary";
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
}
export interface LibraryView {
  /** The output folder as shown, home abbreviated. */
  folder: string;
  /** Large thumbnails in a grid, or one row each (2026-10-05); chosen as group `library`, choice `grid` or `list`. Absent is the grid. */
  layout?: LibraryLayout;
  /** Localized: the recording Move to Trash just took, which Undo (group `library`, choice `undoTrash`) brings back while it waits. */
  trashed?: { name: string; message: string; undo: string };
  /** Localized: a delayed move to the Trash that failed; the recording is listed again. */
  notice?: string;
  /** Localized: loading or an unreadable folder; the list is empty meanwhile. */
  status?: string;
  /** "12 recordings · 2.4 GB". */
  summary?: string;
  items: LibraryItemView[];
}
export interface SettingsView {
  revision?: number;
  library?: LibraryView;
  status?: SettingsStatus;
  recordingResultsRemaining?: number;
  recordingResults?: RecordingResultView[];
  /** Localized status while saved history loads. */
  recordingHistoryStatus?: string;
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
} as const;
/** A recording's new name, as typed in its card (group `recordingFile:<id>`); main checks it before renaming. */
export interface RenameChoice { action: "rename"; name: string }
export function isRenameChoice(value: unknown): value is RenameChoice {
  return typeof value === "object" && value !== null && (value as RenameChoice).action === "rename" && typeof (value as RenameChoice).name === "string";
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
  /** A renamed recording's new id, so its card keeps the focus. */
  renamed?: string;
}
/** What the preload exposes to the panel. */
export interface SettingsBridge {
  /** Uses the same persisted zoom as the window's keyboard and menu actions. */
  zoom?(request: SettingsZoomRequest): Promise<void>;
  onZoomChanged?(callback: (zoom: SettingsZoom) => void): () => void;
  read(): Promise<SettingsView>;
  capture(armed: boolean): Promise<SettingsView>;
  /** A choice is an offered option's id, a full-screen request for a recording (video-player.ts) or its new name. */
  choose(group: string, choice: string | FullScreenChoice | RenameChoice): Promise<SettingsChoiceResult>;
  onChanged(callback: (view: SettingsView) => void): () => void;
  /** RecordStuff was hidden (⌘H); main says so before the window goes out of sight. The preload always offers it. */
  onHidden?(callback: () => void): () => void;
  /** The page has painted its first content (or its failed read): a new window may be shown now. */
  ready(): Promise<void>;
}

export type SettingsZoomRequest = "in" | "out" | "reset";
export interface SettingsZoom { factor: number; canZoomIn: boolean; canZoomOut: boolean }
