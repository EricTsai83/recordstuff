/**
 * Global start/stop shortcut (docs/system-design/desktop.md). The user picks
 * one of a small set of presets or turns the shortcut off; a free-form
 * recorder is out of scope. Values are Electron accelerator strings.
 *
 * Default: `CommandOrControl+Alt+Shift+R` (⌘⌥⇧R on macOS). The plan proposed
 * ⌘⇧R, but a global shortcut wins over the frontmost app and ⌘⇧R is hard
 * reload in Chrome/Firefox, Reader in Safari and local recording in Zoom;
 * pressing it in a browser would start a screen recording by accident. The
 * three-modifier default is unbound in Chrome, Safari, Firefox, Finder,
 * Xcode, VS Code, Slack and Zoom as of 2026-09. ⌘⇧R stays available as a preset.
 */
export const HOTKEY_PRESETS = [
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
