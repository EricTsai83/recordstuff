export const HOTKEY_PRESETS = [
  "CommandOrControl+Shift+1",
  "CommandOrControl+Alt+Shift+R",
  "CommandOrControl+Shift+R",
  "CommandOrControl+Alt+R",
] as const;
export type HotkeyAccelerator = string;

export interface HotkeySettings {
  enabled: boolean;
  /** Remembered while disabled so re-enabling restores the user's choice. */
  accelerator: HotkeyAccelerator;
}

export const DEFAULT_HOTKEY: HotkeySettings = { enabled: true, accelerator: HOTKEY_PRESETS[0] };

/** Deliberately narrower than Electron: no bare typing keys or arbitrary aliases. */
export const MODIFIER_ORDER = ["CommandOrControl", "Control", "Alt", "Shift"] as const;
/** Base keys only: a shifted glyph reaches this set as its base key (`SHIFTED_KEYS`). */
const KEYS = new Set([
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  "Space", "Up", "Down", "Left", "Right",
  ..."-=[]\\;',./`",
]);
// Electron also accepts shifted glyphs. Collapse them before the reserved check.
const SHIFTED_KEYS: Record<string, string> = {
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  "_": "-", "Plus": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "~": "`",
};
const RESERVED = new Set([
  ...[3, 4, 5, 6].map((key) => `CommandOrControl+Shift+${key}`),
  "CommandOrControl+Space", "CommandOrControl+Tab", "CommandOrControl+Q",
  // Every window's close key; the shortcut editor closes on it instead of capturing it.
  "CommandOrControl+W",
]);
export type AcceleratorError = "A shortcut needs Command or Control." | "This key cannot be used." | "macOS reserves this combination.";
export type AcceleratorValidation = { accelerator: string; error?: never } | { error: AcceleratorError; accelerator?: never };

export function validateAccelerator(value: unknown): AcceleratorValidation {
  if (typeof value !== "string" || value.length > 64) return { error: "This key cannot be used." };
  const parts = value.split("+");
  let key = parts.pop() ?? "";
  if (new Set(parts).size !== parts.length || parts.some(part => !(MODIFIER_ORDER as readonly string[]).includes(part))) {
    return { error: "This key cannot be used." };
  }
  if (!parts.includes("CommandOrControl") && !parts.includes("Control")) return { error: "A shortcut needs Command or Control." };
  if (SHIFTED_KEYS[key]) {
    key = SHIFTED_KEYS[key]!;
    if (!parts.includes("Shift")) parts.push("Shift");
  }
  const accelerator = [...MODIFIER_ORDER.filter(part => parts.includes(part)), key].join("+");
  if (RESERVED.has(accelerator)) return { error: "macOS reserves this combination." };
  if (!KEYS.has(key)) return { error: "This key cannot be used." };
  return { accelerator };
}

export function isAccelerator(value: unknown): value is string {
  return validateAccelerator(value).accelerator !== undefined;
}

export function canonicalizeAccelerator(value: unknown): string | undefined {
  return validateAccelerator(value).accelerator;
}

export function isHotkeySettings(value: unknown): value is HotkeySettings {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["enabled"] === "boolean" && isAccelerator(record["accelerator"]);
}

/** Names for `MODIFIER_ORDER` and the named `KEYS`: validation leaves no other spelling (`Plus` becomes `Shift+=`). */
const MAC_SYMBOLS: Record<string, string> = {
  CommandOrControl: "⌘",
  Alt: "⌥",
  Shift: "⇧",
  Control: "⌃",
  Space: "␣", Up: "↑", Down: "↓", Left: "←", Right: "→",
};
const OTHER_NAMES: Record<string, string> = {
  CommandOrControl: "Ctrl",
  Alt: "Alt",
  Shift: "Shift",
  Control: "Ctrl",
};

/**
 * Human-readable form of a canonical accelerator or an editor candidate, for
 * menus and logs: `⌘⌥⇧R` on macOS, `Ctrl+Alt+Shift+R` elsewhere.
 */
export function describeAccelerator(accelerator: string, platform: string): string {
  const parts = accelerator.split("+");
  if (platform === "darwin") return parts.map((part) => MAC_SYMBOLS[part] ?? part).join("");
  return parts.map((part) => OTHER_NAMES[part] ?? part).join("+");
}

/** Kept separate from persisted recording validation so legacy choices survive. */
export const SETTINGS_SHORTCUT = "CommandOrControl+Alt+,";
export const SETTINGS_SHORTCUT_RESERVED = "This combination is reserved for Settings.";

export function isSettingsShortcut(value: unknown, platform: string): boolean {
  const canonical = canonicalizeAccelerator(value);
  if (!canonical) return false;
  const resolve = (input: string): string => [...new Set(input.split("+").map(part =>
    part === "CommandOrControl" ? (platform === "darwin" ? "Command" : "Control") : part))].sort().join("+");
  return resolve(canonical) === resolve(SETTINGS_SHORTCUT);
}
