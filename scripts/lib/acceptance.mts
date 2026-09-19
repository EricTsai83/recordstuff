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
  if (!key || key.length !== 1 || !/^[a-z0-9]$/i.test(key)) return undefined;
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
  return `tell application "System Events" to keystroke "${k.key}"${using}`;
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
  for (let i = start; i < lines.length; i += 1) {
    const m = /hotkey: registered (\S+)/.exec(lines[i] ?? "");
    if (m) return m[1];
    if (/hotkey: (disabled|registration failed)/.test(lines[i] ?? "")) return undefined;
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
