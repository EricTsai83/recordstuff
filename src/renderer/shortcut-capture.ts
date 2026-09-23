import { MODIFIER_ORDER } from "../shared/hotkey";

export interface ShortcutKey {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
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
