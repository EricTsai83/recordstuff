/**
 * The contract between main and the settings panel (docs/system-design/desktop.md).
 *
 * The panel is a projection, never a second source of truth: main sends
 * language-neutral text plus stable group/choice ids, and the panel echoes an
 * id back. Ids identify a setting, not an action, so nothing the renderer
 * sends can describe work main did not already offer.
 */
import type { Language } from "./i18n";

export interface SettingsChoice {
  id: string;
  label: string;
  enabled: boolean;
  checked: boolean;
  /** Offered, but its own work is running: the button keeps focus and ignores activation until it ends (plan 053). */
  busy?: boolean;
}
export type SettingsTab = "library" | "recording" | "general" | "failures";
export interface SettingsGroup {
  id: string;
  label: string;
  tab: "recording" | "general";
  kind?: "actions" | "shortcut";
  /** Presentation only; omitted controls default to a native menu. */
  control?: "switch" | "segmented" | "menu";
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
  /** Extra line under the control, e.g. a shortcut the OS refused to register. */
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
 * The status card, at the foot of the sidebar or above the tabs in a narrow window: what the app is doing,
 * shown only when there is something to say (2026-10-04), never while ready. It is not a live region;
 * `#feedback` stays the page's one announcer.
 */
export interface SettingsStatus {
  tone: "ready" | "busy" | "recording" | "attention";
  title: string;
  /** What to do about an attention state; empty while ready, and while the lock `hint` explains a busy one. */
  detail: string;
  /** What fixes a problem that blocks recording; chosen as group `status`. Starting stays with the tray and the shortcut. */
  action?: { id: StatusActionId; label: string };
}
export type StatusActionId = "permission" | "relaunch" | "folder" | "primary";
/** One video in the Recordings tab; the page reaches its bytes only through these URLs, which name an id. */
export interface LibraryItemView {
  id: string;
  /** The recorded time for the app's own files, the file name for any other. */
  title: string;
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
  /** The tab that entry opens: the failures tab when absent, General for the shortcut card. */
  entryTab?: SettingsTab;
  /** With a Recordings entry: the recording to bring into view, from its saved notification. */
  libraryFocus?: string;
  language: Language;
  title: string;
  hint: string;
  /** Shown when a choice did not take effect; already localized. */
  failure: string;
  /** The failures tab is always offered; its label carries the unread count (plan 047). */
  tabs: Array<{ id: SettingsTab; label: string; accessibleLabel?: string }>;
  groups: SettingsGroup[];
}
/** IPC between main and the settings preload, which keeps its own copies: a sandboxed preload imports nothing at runtime (src/preload/channels.test.ts). */
export const SETTINGS_CHANNELS = {
  capture: "settings:capture",
  read: "settings:read",
  choose: "settings:choose",
  changed: "settings:changed",
  ready: "settings:ready",
} as const;
export interface SettingsChoiceResult {
  view: SettingsView;
  /** Whether the requested choice is the committed one now. */
  applied: boolean;
  failure?: string;
  /** Main refused the value itself (a reserved or invalid shortcut): nothing was saved and choosing it again fails the same way. */
  refused?: true;
}
/** What the preload exposes to the panel. */
export interface SettingsBridge {
  read(): Promise<SettingsView>;
  capture(armed: boolean): Promise<SettingsView>;
  choose(group: string, choice: string): Promise<SettingsChoiceResult>;
  onChanged(callback: (view: SettingsView) => void): () => void;
  /** The page has painted its first content (or its failed read): a new window may be shown now. */
  ready(): Promise<void>;
}
