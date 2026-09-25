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
 * physical W key counts only when the layout types no Latin letter there.
 */
export function isCloseChord(event: ShortcutKey, platform: string): boolean {
  const mac = platform === "darwin";
  if (event.metaKey !== mac || event.ctrlKey === mac || event.altKey || event.shiftKey) return false;
  const key = event.key.toLowerCase();
  return key === "w" || (event.code === "KeyW" && !/^[a-z]$/.test(key));
}

export function shortcutModifiers(event: ShortcutKey, platform = "darwin"): string[] {
  return MODIFIER_ORDER.filter((_, index) => [event.metaKey && platform === "darwin", event.ctrlKey, event.altKey, event.shiftKey][index]);
}

/** Physical letter/digit/function keys stay stable when Shift/Option changes event.key. */
export function shortcutCandidate(event: ShortcutKey, platform = "darwin"): string | undefined {
  if (event.metaKey && platform !== "darwin") return "Unsupported";
  if (/^(Meta|Control|Alt|Shift)(Left|Right)$/.test(event.code)) return undefined;
  const named: Record<string, string> = {
    Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
    Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`",
    Space: "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  };
  const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3)
    : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5)
      : /^F([1-9]|1[0-9]|2[0-4])$/.test(event.code) ? event.code
        : named[event.code] ?? "Unsupported";
  return [...shortcutModifiers(event, platform), key].join("+");
}
