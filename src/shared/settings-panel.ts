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
  /** Extra line under the control, e.g. a shortcut the OS refused to register. */
  note?: string;
  enabled: boolean;
  choices: SettingsChoice[];
}
export interface SettingsView {
  language: Language;
  title: string;
  hint: string;
  /** Shown when a choice did not take effect; already localized. */
  failure: string;
  groups: SettingsGroup[];
}
export interface SettingsChoiceResult {
  view: SettingsView;
  /** Whether the requested choice is the committed one now. */
  applied: boolean;
}
/** What the preload exposes to the panel. */
export interface SettingsBridge {
  read(): Promise<SettingsView>;
  choose(group: string, choice: string): Promise<SettingsChoiceResult>;
  onChanged(callback: (view: SettingsView) => void): () => void;
}
