import { MODIFIER_ORDER } from "../shared/hotkey";

export interface ShortcutKey {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The platform's window-close chord, exactly: Command+W on macOS, Control+W
 * elsewhere, with no other modifier. macOS Control+W therefore stays a
 * capturable shortcut. The typed character decides, as native menus do; the
 * physical W key counts only when the layout types no ASCII character there
 * (Russian ц), so Dvorak's Command+, on that key stays Command+,.
 */
export function isCloseChord(event: ShortcutKey, platform: string): boolean {
  const mac = platform === "darwin";
  if (event.metaKey !== mac || event.ctrlKey === mac || event.altKey || event.shiftKey) return false;
  const key = event.key.toLowerCase();
  return key === "w" || (event.code === "KeyW" && !/^[\x21-\x7e]$/.test(key));
}

/**
 * The platform as the page's browser names it, in main's terms for macOS (`darwin`): what `isCloseChord` reads until
 * main has said (the settings page) or where main never says (the full-screen page).
 */
export function browserPlatform(): string {
  return navigator.platform.startsWith("Mac") ? "darwin" : navigator.platform;
}

export function shortcutModifiers(event: ShortcutKey, platform = "darwin"): string[] {
  return MODIFIER_ORDER.filter((_, index) => [event.metaKey && platform === "darwin", event.ctrlKey, event.altKey, event.shiftKey][index]);
}

/** Electron accelerator names for the physical punctuation, space and arrow keys. */
const NAMED_KEYS: Record<string, string> = {
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`",
  Space: "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
};

/** Physical letter/digit/function keys stay stable when Shift/Option changes event.key. */
export function shortcutCandidate(event: ShortcutKey, platform = "darwin"): string | undefined {
  // A modifier alone, the Windows key included, is still being held: no candidate yet.
  if (/^(Meta|Control|Alt|Shift)(Left|Right)$/.test(event.code)) return undefined;
  // The Windows key has no accelerator name: unusable like a keypad key, keeping the other modifiers.
  const key = event.metaKey && platform !== "darwin" ? "Unsupported"
    : /^Key[A-Z]$/.test(event.code) ? event.code.slice(3)
      : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5)
        : /^F([1-9]|1[0-9]|2[0-4])$/.test(event.code) ? event.code
          : NAMED_KEYS[event.code] ?? "Unsupported";
  return [...shortcutModifiers(event, platform), key].join("+");
}
