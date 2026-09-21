/**
 * Global start/stop shortcut (docs/system-design/desktop.md). The user picks
 * one of a small set of presets or turns the shortcut off; a free-form
 * recorder is out of scope. Values are Electron accelerator strings.
 *
 * Default: `CommandOrControl+Shift+1` (⌘⇧1 on macOS), by maintainer decision
 * on 2026-09-21, replacing `CommandOrControl+Alt+Shift+R`. A global shortcut
 * wins over the frontmost app, so the default has to be a combination no
 * common app expects. ⌘⇧R — the obvious mnemonic — is hard reload in
 * Chrome/Firefox, Reader in Safari and local recording in Zoom, so it starts a
 * screen recording where the user meant to reload; it stays a preset for
 * anyone who wants it. Digits are the quieter range: macOS owns ⌘⇧3/4/5 for
 * screenshots and screen recording, and apps bind plain ⌘1…9 for tabs and
 * view modes rather than the shifted form. This combination has not been
 * re-checked against the app list below; that belongs to native acceptance.
 *
 * Every accelerator ever offered stays in this list. `isHotkeyAccelerator`
 * rejects anything outside it, so dropping one would silently reset the
 * settings of everyone who had chosen it.
 *
 * The default is always `HOTKEY_PRESETS[0]`; reorder the list to change it.
 * `CommandOrControl+Alt+Shift+R` was verified unbound in Chrome, Safari,
 * Firefox, Finder, Xcode, VS Code, Slack and Zoom as of 2026-09.
 */
export const HOTKEY_PRESETS = [
  "CommandOrControl+Shift+1",
  "CommandOrControl+Alt+Shift+R",
  "CommandOrControl+Shift+R",
  "CommandOrControl+Alt+R",
] as const;
export type HotkeyAccelerator = (typeof HOTKEY_PRESETS)[number];

export interface HotkeySettings {
  enabled: boolean;
  /** Remembered while disabled so re-enabling restores the user's choice. */
  accelerator: HotkeyAccelerator;
}

export const DEFAULT_HOTKEY: HotkeySettings = { enabled: true, accelerator: HOTKEY_PRESETS[0] };

export function isHotkeyAccelerator(value: unknown): value is HotkeyAccelerator {
  return typeof value === "string" && (HOTKEY_PRESETS as readonly string[]).includes(value);
}

export function isHotkeySettings(value: unknown): value is HotkeySettings {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["enabled"] === "boolean" && isHotkeyAccelerator(record["accelerator"]);
}

const MAC_SYMBOLS: Record<string, string> = {
  CommandOrControl: "⌘",
  Command: "⌘",
  Alt: "⌥",
  Option: "⌥",
  Shift: "⇧",
  Control: "⌃",
};
const OTHER_NAMES: Record<string, string> = {
  CommandOrControl: "Ctrl",
  Command: "Win",
  Alt: "Alt",
  Option: "Alt",
  Shift: "Shift",
  Control: "Ctrl",
};

/** Human-readable form for menus and logs: `⌘⌥⇧R` on macOS, `Ctrl+Alt+Shift+R` elsewhere. */
export function describeAccelerator(accelerator: string, platform: string): string {
  const parts = accelerator.split("+");
  if (platform === "darwin") return parts.map((part) => MAC_SYMBOLS[part] ?? part).join("");
  return parts.map((part) => OTHER_NAMES[part] ?? part).join("+");
}
