/** OS pointer input for window dragging; renderer sendInputEvent cannot move a native window. */
import { AX_SCRIPT, parseAxResult, type Frame } from "./native-ax.mts";
import { command } from "./processes.mts";

export interface Point { x: number; y: number }
export interface DragEvent extends Point { type: 5 | 1 | 6 | 2; delayMs: number }

export function dragEvents(from: Point, to: Point): DragEvent[] {
  if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) throw new Error("Drag coordinates must be finite");
  if (Math.hypot(to.x - from.x, to.y - from.y) < 8) throw new Error("Drag must cross the native drag threshold");
  return [
    { ...from, type: 5, delayMs: 40 },
    { ...from, type: 1, delayMs: 100 },
    ...Array.from({ length: 16 }, (_, i): DragEvent => ({
      x: from.x + (to.x - from.x) * (i + 1) / 16,
      y: from.y + (to.y - from.y) * (i + 1) / 16,
      type: 6, delayMs: 25,
    })),
    { ...to, type: 2, delayMs: 80 },
  ];
}

type Send = (operation: string, args: string[], signal: AbortSignal) => Promise<void>;
const send: Send = async (operation, args, signal) => {
  parseAxResult(await command("osascript", ["-l", "JavaScript", "-e", AX_SCRIPT, operation, ...args], signal, 3000), operation);
};

/** A separately bounded release also runs if cancellation kills the JXA helper while the button is down. */
export async function nativeDrag(from: Point, to: Point, signal: AbortSignal, post: Send = send): Promise<void> {
  const events = dragEvents(from, to);
  signal.throwIfAborted();
  try { await post("drag-events", [JSON.stringify(events)], signal); }
  finally { await post("release-mouse", [], new AbortController().signal); }
}

export async function restorePointer(point: Point): Promise<void> {
  const result = parseAxResult<{ point: Point; leftDown: boolean }>(await command("osascript", ["-l", "JavaScript", "-e", AX_SCRIPT,
    "move-mouse", String(point.x), String(point.y)], new AbortController().signal, 3000), "pointer restoration");
  if (!result.point || ![result.point.x, result.point.y].every(Number.isFinite) || result.leftDown
    || Math.abs(result.point.x - point.x) > 1 || Math.abs(result.point.y - point.y) > 1)
    throw new Error(`Pointer did not restore with the mouse released: ${JSON.stringify(result)}`);
}

export async function releaseNativeMouse(): Promise<void> {
  const result = parseAxResult<{ leftDown: boolean }>(await command("osascript", ["-l", "JavaScript", "-e", AX_SCRIPT,
    "release-mouse"], new AbortController().signal, 3000), "mouse release");
  if (result.leftDown !== false) throw new Error("Native left mouse button was not released");
}

/** Exact displacement and unchanged size, from independent AX reads; a resize or unrelated nudge cannot pass. */
export function judgeDrag(before: Frame, after: Frame, expected: Point, tolerance = 2): string[] {
  const problems: string[] = [];
  if (![before.x, before.y, before.width, before.height, after.x, after.y, after.width, after.height, expected.x, expected.y].every(Number.isFinite)) return ["invalid window geometry"];
  if (Math.abs(after.width - before.width) > 1 || Math.abs(after.height - before.height) > 1) problems.push("window size changed");
  const actual = { x: after.x - before.x, y: after.y - before.y };
  if (Math.abs(actual.x - expected.x) > tolerance || Math.abs(actual.y - expected.y) > tolerance)
    problems.push(`window moved ${actual.x},${actual.y} pt; expected ${expected.x},${expected.y}`);
  return problems;
}
