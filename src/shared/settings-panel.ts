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
}
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
  sectionFootnote?: string;
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
  heading: string;
  reason: string;
  time: string;
  outcome: string;
  guidance: string;
  persistenceWarning?: string;
  /** Localized: an acknowledgement or removal waits for a durable save. */
  saving?: string;
  detail: string;
  file?: string;
  acknowledged: boolean;
  pending: boolean;
  actions: SettingsChoice[];
}
export interface SettingsView {
  recordingResults?: RecordingResultView[];
  /** Localized status while saved history loads. */
  recordingHistoryStatus?: string;
  /** Changes only on explicit entry through notification/tray. */
  resultFocus?: number;
  language: Language;
  title: string;
  hint: string;
  /** Shown when a choice did not take effect; already localized. */
  failure: string;
  tabs: Array<{ id: "recording" | "general"; label: string }>;
  groups: SettingsGroup[];
}
export interface SettingsChoiceResult {
  view: SettingsView;
  /** Whether the requested choice is the committed one now. */
  applied: boolean;
  failure?: string;
}
/** What the preload exposes to the panel. */
export interface SettingsBridge {
  read(): Promise<SettingsView>;
  capture(armed: boolean): Promise<SettingsView>;
  choose(group: string, choice: string): Promise<SettingsChoiceResult>;
  onChanged(callback: (view: SettingsView) => void): () => void;
}
