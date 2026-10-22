/**
 * Pure parts of `pnpm native:input` (scripts/native-input.mts): an executor's own input to the RecordStuff bundle under
 * test during a guided hands-on round (the native acceptance skill's guided mode). The maintainer allowed executors to
 * operate the tested bundle through Accessibility and CoreGraphics on 2026-10-18, matched by its executable path and
 * pid; these helpers parse the command, choose the element a title names, keep pointer input inside the bundle's own
 * windows, and confirm from the app log that the running process is that bundle before a shortcut is sent.
 */
import { lastStartIndex } from "./acceptance.mts";
import type { Frame, PointHit, WindowElement } from "../runner/native-ax.mts";

export const DEFAULT_WINDOW = "RecordStuff";

export type InputCommand =
  | { kind: "elements"; window: string }
  | { kind: "press"; title: string; window: string }
  | { kind: "click"; x: number; y: number }
  | { kind: "scroll"; x: number; y: number; lines: number }
  | { kind: "shortcut"; which: "record" | "settings" };

export const USAGE = `Usage: pnpm native:input -- <command>
  elements [--window <title>]          list what can be clicked or chosen in the window (default "${DEFAULT_WINDOW}")
  press <title> [--window <title>]     click the one enabled element with exactly that title
  click <x> <y>                        left click at a point inside one of the bundle's windows
  scroll <x> <y> <lines>               scroll whole lines over such a point, positive towards the end
  shortcut [record|settings]           send the shortcut the running bundle registered (default record)
Acts only on this checkout's packaged bundle, running once. One JSON line out.
Exit 0 done; 1 refused (no such element, a point outside the windows or covered by another app, no registered shortcut);
2 blocked (not macOS, the bundle not running or running twice, the screen locked, Accessibility or Automation denied, invalid
arguments).`;

export class UsageError extends Error {}

const number = (value: string | undefined, what: string, integer = false): number => {
  const parsed = value === undefined || value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) throw new UsageError(`${what} must be ${integer ? "a whole number" : "a number"}: ${value ?? "(missing)"}`);
  return parsed;
};

/** The command an argument list names; throws `UsageError` for anything else. */
export function parseInputCommand(args: readonly string[]): InputCommand {
  const rest = [...args];
  let window = DEFAULT_WINDOW;
  const windowAt = rest.indexOf("--window");
  if (windowAt >= 0) {
    const value = rest[windowAt + 1];
    if (!value || value.startsWith("--")) throw new UsageError("--window needs a window title");
    window = value;
    rest.splice(windowAt, 2);
  }
  const [kind, ...operands] = rest;
  const expect = (count: number): void => {
    if (operands.length !== count) throw new UsageError(`${kind} takes ${count} argument${count === 1 ? "" : "s"}, got ${operands.length}`);
  };
  switch (kind) {
    case "elements": expect(0); return { kind, window };
    case "press": {
      expect(1);
      const title = operands[0]!.trim();
      if (!title) throw new UsageError("press needs a non-empty title");
      return { kind, title, window };
    }
    case "click": expect(2); return { kind, x: number(operands[0], "x"), y: number(operands[1], "y") };
    case "scroll": {
      expect(3);
      const lines = number(operands[2], "lines", true);
      if (lines === 0 || Math.abs(lines) > 100) throw new UsageError(`lines must be between -100 and 100 and not 0: ${lines}`);
      return { kind, x: number(operands[0], "x"), y: number(operands[1], "y"), lines };
    }
    case "shortcut": {
      if (operands.length > 1) throw new UsageError(`shortcut takes at most 1 argument, got ${operands.length}`);
      const which = operands[0] ?? "record";
      if (which !== "record" && which !== "settings") throw new UsageError(`shortcut is record or settings: ${which}`);
      if (windowAt >= 0) throw new UsageError("--window does not apply to shortcut");
      return { kind, which };
    }
    default: throw new UsageError(kind ? `unknown command: ${kind}` : "a command is required");
  }
}

/** Thinner than this in either direction, an element is a sliver Chromium left at the edge for one scrolled out of view. */
export const MIN_VISIBLE_PT = 4;

/** Whether the element is drawn in the window, not scrolled out of it. */
export function visible(element: WindowElement): boolean {
  return element.frame.width >= MIN_VISIBLE_PT && element.frame.height >= MIN_VISIBLE_PT;
}

export type ElementChoice = { ok: true; element: WindowElement } | { ok: false; reason: string };

/**
 * The one enabled element whose title is exactly `title` (surrounding space ignored). None, or several, is refused with
 * what was there, so the executor chooses by what a person reads rather than by a guessed point.
 */
export function chooseElement(elements: readonly WindowElement[], title: string): ElementChoice {
  const wanted = title.trim();
  const matches = elements.filter((element) => element.title.trim() === wanted);
  const enabled = matches.filter((element) => element.enabled);
  const shown = enabled.filter(visible);
  if (shown.length === 1) return { ok: true, element: shown[0]! };
  if (enabled.length > 0 && shown.length === 0) return { ok: false, reason: `"${wanted}" is scrolled out of view; scroll it into the window first` };
  if (shown.length > 1) {
    const where = shown.map((element) => `${element.role} at ${element.frame.x},${element.frame.y}`).join("; ");
    return { ok: false, reason: `${shown.length} enabled elements are titled "${wanted}" (${where}); click one by its point instead` };
  }
  if (matches.length > 0) return { ok: false, reason: `"${wanted}" is disabled` };
  const titles = [...new Set(elements.filter((element) => element.enabled && visible(element) && element.title.trim()).map((element) => element.title.trim()))];
  const listed = titles.slice(0, 40).map((t) => `"${t}"`).join(", ");
  return { ok: false, reason: `no element is titled "${wanted}"; visible enabled titles: ${listed || "(none)"}${titles.length > 40 ? `, … ${titles.length - 40} more` : ""}` };
}

/**
 * Why pointer input at a point must not be sent, or undefined: the point outside every window of the bundle, another
 * process's window on top of it there (a click is delivered to whatever is on top, not to the frame it lies in), or, for
 * a press in `window`, another of the bundle's windows on top there. A popup of the same window is `overlayRefusal`'s.
 */
export function pointRefusal(frames: readonly (Frame | undefined)[], hit: PointHit | undefined, pid: number, x: number, y: number, window?: string): string | undefined {
  if (!insideAny(frames, x, y)) return `${x},${y} is outside every window of pid ${pid}`;
  if (hit?.pid !== pid) return `${x},${y} is covered by ${hit === undefined ? "something that cannot be identified" : `pid ${hit.pid}`}, not pid ${pid}; bring the window to the front first`;
  if (window !== undefined && hit.window !== window) {
    return `${x},${y} is covered by ${hit.window ? `the window "${hit.window}"` : "something outside any window"}, not "${window}"; bring "${window}" to the front first`;
  }
  return undefined;
}

/**
 * Why a press on `element` must not be sent although the hit test passed, or undefined: its centre lies under an open list
 * or menu it is not part of. Chromium's hit test falls through such a popup's padding to the element beneath (2026-10-23:
 * at 1388,872, inside the open frame-rate list, it reported the resolution cap under it), while a click lands on the popup.
 */
export function overlayRefusal(element: WindowElement, overlays: readonly Frame[]): string | undefined {
  const point = centreOf(element.frame);
  const over = overlays.findIndex((overlay, index) => index !== element.layer && insideAny([overlay], point.x, point.y));
  return over >= 0 ? `"${element.title}" lies under an open list or menu at ${overlays[over]!.x},${overlays[over]!.y}; close it first` : undefined;
}

/** Input is never sent to a locked session (docs/testing.md); a lock state that cannot be read does not block, as for the runners. */
export function lockRefusal(locked: boolean | undefined): string | undefined {
  return locked === true ? "the screen is locked; unlock it first: executor input never goes to a locked session" : undefined;
}

/** Whether osascript's error says System Events may not be driven (Automation or Accessibility denied): blocked, not failed. */
export function systemEventsDenied(detail: string): boolean {
  return /-1743|-1719|-25211|1002|not authori[sz]ed|not allowed|assistive access/i.test(detail);
}

/** Whether the point lies inside one of the frames (edges included). */
export function insideAny(frames: readonly (Frame | undefined)[], x: number, y: number): boolean {
  return frames.some((f) => f !== undefined && x >= f.x && x <= f.x + f.width && y >= f.y && y <= f.y + f.height);
}

/** The centre of a frame, where a press lands. */
export function centreOf(frame: Frame): { x: number; y: number } {
  return { x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height / 2) };
}

/**
 * Checks that the latest process start in the log is the bundle under test, as pid `pid` and executable `executable`:
 * another copy with the same bundle ID (an older one in /Applications, which macOS may relaunch after a permission
 * change) writes the same log, and its registration must not be taken for this bundle's. Returns why not, or undefined.
 */
export function startMismatch(lines: readonly string[], pid: number, executable: string): string | undefined {
  const start = lastStartIndex(lines);
  if (start < 0) return "the app log has no process start";
  const line = lines[start] ?? "";
  const run = /\brun (\S+?);/.exec(line)?.[1];
  const logged = /\bexecutable (.+?)(?:;|$)/.exec(line)?.[1]?.trim();
  if (!run?.endsWith(`-${pid}`)) return `the latest start in the log is run ${run ?? "(unknown)"}, not pid ${pid}`;
  if (logged !== executable) return `the latest start in the log ran ${logged ?? "(unknown)"}, not ${executable}`;
  return undefined;
}
