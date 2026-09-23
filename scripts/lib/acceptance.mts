import { pathToFileURL } from "node:url";

/**
 * Pure helpers for `pnpm acceptance` (scripts/acceptance-hotkey.mts): read the
 * app log to learn which global shortcut the running app registered, turn an
 * Electron accelerator into the System Events keystroke that reaches the
 * system input layer, and find session events after a given log offset.
 */

export interface AppleScriptKeystroke {
  /** Lower-case key character for `keystroke`. */
  key: string;
  /** System Events modifier names, e.g. `command down`. */
  modifiers: string[];
}

/**
 * ANSI key codes for the digit row. `keystroke` types a *character*, so with
 * shift held `keystroke "1"` sends `!`, which never matches a shortcut Electron
 * registered by key code. Digits therefore go out as `key code`.
 */
const DIGIT_KEY_CODES: Record<string, number> = {
  "1": 18, "2": 19, "3": 20, "4": 21, "5": 23,
  "6": 22, "7": 26, "8": 28, "9": 25, "0": 29,
  space: 49, left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111, f13: 105, f14: 107, f15: 113,
  f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
  "=": 24, "-": 27, "'": 39, "\\": 42, "]": 30, "[": 33, ";": 41, ",": 43, "/": 44, ".": 47, "`": 50,
};

const MODIFIERS: Record<string, string> = {
  CommandOrControl: "command down",
  Command: "command down",
  Cmd: "command down",
  Control: "control down",
  Ctrl: "control down",
  Alt: "option down",
  Option: "option down",
  Shift: "shift down",
  Super: "command down",
  Meta: "command down",
};

/** `CommandOrControl+Alt+Shift+R` → keystroke "r" using {command down, option down, shift down}. Undefined for a key this script cannot type. */
export function acceleratorToKeystroke(accelerator: string): AppleScriptKeystroke | undefined {
  const parts = accelerator.split("+").filter((p) => p.length > 0);
  const key = parts.pop();
  if (!key || (!/^[a-z]$/i.test(key) && DIGIT_KEY_CODES[key.toLowerCase()] === undefined)) return undefined;
  const modifiers: string[] = [];
  for (const part of parts) {
    const name = MODIFIERS[part];
    if (!name) return undefined;
    if (!modifiers.includes(name)) modifiers.push(name);
  }
  return { key: key.toLowerCase(), modifiers };
}

export function keystrokeScript(k: AppleScriptKeystroke): string {
  const using = k.modifiers.length > 0 ? ` using {${k.modifiers.join(", ")}}` : "";
  const code = DIGIT_KEY_CODES[k.key];
  const press = code === undefined ? `keystroke "${k.key}"` : `key code ${code}`;
  return `tell application "System Events" to ${press}${using}`;
}

/** Index of the last `start:` line (the current process) or -1. */
export function lastStartIndex(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i -= 1) if (/\] start: /.test(lines[i] ?? "")) return i;
  return -1;
}

/** The accelerator the current process registered, from `hotkey: registered <acc>` after the last start. */
export function registeredAccelerator(lines: readonly string[]): string | undefined {
  const start = lastStartIndex(lines);
  if (start < 0) return undefined;
  for (let i = lines.length - 1; i > start; i -= 1) {
    const m = /hotkey: registered (\S+)/.exec(lines[i] ?? "");
    if (m) return m[1];
    if (/hotkey: (disabled|registration failed|suspended)/.test(lines[i] ?? "")) return undefined;
  }
  return undefined;
}

/** Last `state → x` after the last start, or undefined when none was logged (idle since start). */
export function currentState(lines: readonly string[]): string | undefined {
  const start = lastStartIndex(lines);
  let state: string | undefined;
  for (let i = Math.max(start, 0); i < lines.length; i += 1) {
    const m = /state → (\w+)/.exec(lines[i] ?? "");
    if (m) state = m[1];
  }
  return state;
}

/** First line at or after `from` matching `pattern`; the match and its index. */
export function findAfter(lines: readonly string[], from: number, pattern: RegExp): { index: number; match: RegExpExecArray } | undefined {
  for (let i = Math.max(from, 0); i < lines.length; i += 1) {
    const match = pattern.exec(lines[i] ?? "");
    if (match) return { index: i, match };
  }
  return undefined;
}

/** `[2026-09-19T15:35:23.663Z] …` → the timestamp, or undefined. */
export function lineTime(line: string): Date | undefined {
  const m = /^\[([^\]]+)\]/.exec(line);
  if (!m) return undefined;
  const t = new Date(m[1] ?? "");
  return Number.isNaN(t.getTime()) ? undefined : t;
}

/** The split of a newline-terminated log includes an empty final element. */
export function nextLogIndex(lines: readonly string[]): number {
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

/** Shared fullscreen/autoplay setup; callers own the profile and process lifetime. */
export function materialOpenArgs(file: string, profile: string): string[] {
  const url = pathToFileURL(file);
  url.searchParams.set("auto", "1");
  return [
    "-na", "Google Chrome", "--args", `--user-data-dir=${profile}`, `--app=${url.href}`,
    // Chrome can ignore --kiosk alone when another Chrome instance is running.
    "--start-fullscreen", "--kiosk", "--window-position=0,0",
    "--autoplay-policy=no-user-gesture-required", "--no-first-run",
    "--no-default-browser-check", "--disable-features=Translate",
  ];
}

/** Read only the latest process and ownership transition, not a historical registration. */
export function registeredSettingsAccelerator(lines: readonly string[]): string | undefined {
  const start = lastStartIndex(lines);
  if (start < 0) return undefined;
  for (let i = lines.length - 1; i > start; i -= 1) {
    const message = lines[i]?.split("] settings shortcut: ")[1];
    if (!message) continue;
    if (message.startsWith("registered ")) return message.slice("registered ".length);
    if (/^(disabled|suspended|registration failed|unavailable)/.test(message)) return undefined;
  }
  return undefined;
}
