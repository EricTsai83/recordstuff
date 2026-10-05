export type HotkeyAccelerator = string;

export interface HotkeySettings {
  enabled: boolean;
  /** Remembered while disabled so re-enabling restores the user's choice. */
  accelerator: HotkeyAccelerator;
}

/** Every accelerator the app ever shipped stays valid for the users who saved it (`hotkey.test.ts`). */
export const DEFAULT_HOTKEY: HotkeySettings = { enabled: true, accelerator: "CommandOrControl+Shift+1" };

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
/** Every app's switch, quit and close keys; the shortcut editor closes on the close key instead of capturing it. */
const APP_KEYS = ["Tab", "Q", "W"];
/**
 * macOS also owns its screenshot and Spotlight chords; Control is a separate key there, so only Command is reserved.
 * Adding Control to ⇧⌘3, 4 and 6 sends the same screenshot to the clipboard, so those forms are the system's too.
 */
const MAC_RESERVED = new Set([
  ...[3, 4, 5, 6].map((key) => `CommandOrControl+Shift+${key}`),
  ...[3, 4, 6].map((key) => `CommandOrControl+Control+Shift+${key}`),
  "CommandOrControl+Space",
  ...APP_KEYS.map((key) => `CommandOrControl+${key}`),
]);
/** Off macOS, Command is Control, and the editor reports Ctrl as `Control`: both spellings are reserved. */
const OTHER_RESERVED = new Set(APP_KEYS.map((key) => `Control+${key}`));
export type AcceleratorError =
  | "A shortcut needs Command or Control." | "A shortcut needs Ctrl." | "This key cannot be used."
  | "macOS reserves this combination." | "Other apps use this combination.";
export type AcceleratorValidation = { accelerator: string; error?: never } | { error: AcceleratorError; accelerator?: never };

/** Reserved combinations differ by `platform` (plan 064), so a file is valid on the platform that wrote it. */
export function validateAccelerator(value: unknown, platform: string): AcceleratorValidation {
  if (typeof value !== "string" || value.length > 64) return { error: "This key cannot be used." };
  const mac = platform === "darwin";
  const parts = value.split("+");
  let key = parts.pop() ?? "";
  if (new Set(parts).size !== parts.length || parts.some(part => !(MODIFIER_ORDER as readonly string[]).includes(part))) {
    return { error: "This key cannot be used." };
  }
  if (!parts.includes("CommandOrControl") && !parts.includes("Control")) {
    return { error: mac ? "A shortcut needs Command or Control." : "A shortcut needs Ctrl." };
  }
  if (SHIFTED_KEYS[key]) {
    key = SHIFTED_KEYS[key]!;
    if (!parts.includes("Shift")) parts.push("Shift");
  }
  const accelerator = [...MODIFIER_ORDER.filter(part => parts.includes(part)), key].join("+");
  if (mac && MAC_RESERVED.has(accelerator)) return { error: "macOS reserves this combination." };
  if (!mac) {
    const pressed = parts.map(part => part === "CommandOrControl" ? "Control" : part);
    if (OTHER_RESERVED.has([...MODIFIER_ORDER.filter(part => pressed.includes(part)), key].join("+"))) {
      return { error: "Other apps use this combination." };
    }
  }
  if (!KEYS.has(key)) return { error: "This key cannot be used." };
  return { accelerator };
}

export function canonicalizeAccelerator(value: unknown, platform: string): string | undefined {
  return validateAccelerator(value, platform).accelerator;
}

/** Valid settings with their accelerator in canonical order, from one validation; undefined for anything else. */
export function canonicalHotkeySettings(value: unknown, platform: string): HotkeySettings | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const accelerator = canonicalizeAccelerator(record["accelerator"], platform);
  return typeof record["enabled"] === "boolean" && accelerator !== undefined ? { enabled: record["enabled"], accelerator } : undefined;
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

/** The order macOS draws modifiers in, as its own menus show a shortcut: ⌃⌥⇧⌘. */
const MAC_MODIFIER_ORDER = ["Control", "Alt", "Shift", "CommandOrControl"] as const;

/**
 * The keys of a canonical accelerator or an editor candidate as they are shown, one per key: on macOS its symbols
 * in the order the system's own menus draw the same shortcut beside an item (⌥, ⇧, ⌘, R), elsewhere its names.
 */
export function acceleratorKeys(accelerator: string, platform: string): string[] {
  const parts = accelerator.split("+").filter(Boolean);
  if (platform !== "darwin") return parts.map((part) => OTHER_NAMES[part] ?? part);
  const rank = (part: string): number => {
    const index = (MAC_MODIFIER_ORDER as readonly string[]).indexOf(part);
    return index < 0 ? MAC_MODIFIER_ORDER.length : index;
  };
  // Stable: the key keeps its place after the modifiers.
  return [...parts].sort((a, b) => rank(a) - rank(b)).map((part) => MAC_SYMBOLS[part] ?? part);
}

/** Human-readable form for menus, notifications and logs: `⌥⇧⌘R` on macOS, `Ctrl+Alt+Shift+R` elsewhere. */
export function describeAccelerator(accelerator: string, platform: string): string {
  return acceleratorKeys(accelerator, platform).join(platform === "darwin" ? "" : "+");
}

/** Kept separate from persisted recording validation so legacy choices survive. */
export const SETTINGS_SHORTCUT = "CommandOrControl+Alt+,";
export const SETTINGS_SHORTCUT_RESERVED = "This combination is reserved for opening RecordStuff.";

/**
 * Whether two accelerators press the same keys on `platform`. Off macOS
 * `CommandOrControl` is Control, so the editor's `Control+Shift+1` there is the
 * recommended `CommandOrControl+Shift+1`.
 */
export function sameShortcut(a: unknown, b: unknown, platform: string): boolean {
  const keys = (value: unknown): string | undefined => {
    const canonical = canonicalizeAccelerator(value, platform);
    return canonical && [...new Set(canonical.split("+").map(part =>
      part === "CommandOrControl" ? (platform === "darwin" ? "Command" : "Control") : part))].sort().join("+");
  };
  const first = keys(a);
  return first !== undefined && first === keys(b);
}

export function isSettingsShortcut(value: unknown, platform: string): boolean {
  return sameShortcut(value, SETTINGS_SHORTCUT, platform);
}
