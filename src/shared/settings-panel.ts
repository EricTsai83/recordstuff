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
export type SettingsTab = "recording" | "general" | "failures";
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
  platform?: string;
  /** Extra line under the control, e.g. a shortcut the OS refused to register. */
  note?: string;
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
export interface SettingsView {
  revision?: number;
  recordingResultsRemaining?: number;
  recordingResults?: RecordingResultView[];
  /** Localized status while saved history loads. */
  recordingHistoryStatus?: string;
  /** Changes only on explicit entry through notification/tray; the page then selects `entryTab`. */
  resultFocus?: number;
  /** The tab that entry opens: the failures tab when absent, General for the shortcut card. */
  entryTab?: SettingsTab;
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
}
