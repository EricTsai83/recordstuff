/**
 * Plan 099: what a display recording leaves out of the system's own chrome, and the strips it then cuts off. Three
 * switches (D1), each independent: the menu bar with its status items, the Dock, and desktop icons and widgets. A
 * part left out of the picture still keeps its strip on screen while it is shown there (windows stop at the menu bar's
 * lower edge, a maximised window beside the Dock), so a hidden menu bar or Dock that keeps a strip has that strip cut
 * off rather than recorded as wallpaper. One set to hide automatically keeps none, so only its windows are left out.
 */
import type { Rectangle } from "./countdown";

/** Which parts of the system's chrome a recording leaves out (macOS; Windows cannot leave the taskbar out). */
export interface SystemUiChoice {
  menuBar: boolean;
  dock: boolean;
  desktop: boolean;
}

export const SHOW_SYSTEM_UI: SystemUiChoice = { menuBar: false, dock: false, desktop: false };

export function isSystemUiChoice(value: unknown): value is SystemUiChoice {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v["menuBar"] === "boolean" && typeof v["dock"] === "boolean" && typeof v["desktop"] === "boolean";
}

/** Part of a display in its pixels, from its top-left corner: what the engine's `area` source records. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function isPixelRect(value: unknown): value is PixelRect {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return [v["x"], v["y"]].every((n) => Number.isSafeInteger(n) && (n as number) >= 0)
    && [v["width"], v["height"]].every((n) => Number.isSafeInteger(n) && (n as number) >= 2);
}

/**
 * The part of a display to record, in its pixels, or `undefined` for all of it. `bounds` and `workArea` are Electron's
 * (macOS's `frame` and `visibleFrame`, in points): the work area's top inset is the menu bar's strip, its other edges'
 * the Dock's, since the Dock never sits at the top. Only a hidden part's strip is cut: a part that is recorded keeps
 * its strip. Fixed when the recording starts (a Dock moved meanwhile keeps the recording's size). Points become pixels
 * by `scaleFactor`, rounded inwards, and the size is made even for H.264 by giving up a pixel on the right or bottom.
 */
export function systemUiCrop(bounds: Rectangle, workArea: Rectangle, scaleFactor: number, hide: SystemUiChoice): PixelRect | undefined {
  if (!(scaleFactor > 0) || !(bounds.width > 0) || !(bounds.height > 0)) return undefined;
  const inset = (value: number): number => Number.isFinite(value) && value > 0 ? value : 0;
  const top = hide.menuBar ? inset(workArea.y - bounds.y) : 0;
  const dock = hide.dock;
  const left = dock ? inset(workArea.x - bounds.x) : 0;
  const right = dock ? inset(bounds.x + bounds.width - (workArea.x + workArea.width)) : 0;
  const bottom = dock ? inset(bounds.y + bounds.height - (workArea.y + workArea.height)) : 0;
  if (top === 0 && left === 0 && right === 0 && bottom === 0) return undefined;
  const fullWidth = Math.round(bounds.width * scaleFactor);
  const fullHeight = Math.round(bounds.height * scaleFactor);
  const x = Math.min(fullWidth, Math.ceil(left * scaleFactor));
  const y = Math.min(fullHeight, Math.ceil(top * scaleFactor));
  const width = Math.floor((fullWidth - Math.ceil(right * scaleFactor) - x) / 2) * 2;
  const height = Math.floor((fullHeight - Math.ceil(bottom * scaleFactor) - y) / 2) * 2;
  // A work area that leaves less than half the display is not a menu bar's or a Dock's: record all of it.
  if (width < fullWidth / 2 || height < fullHeight / 2) return undefined;
  return { x, y, width, height };
}
