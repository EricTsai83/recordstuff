/**
 * The pure half of `pnpm prep:edit-view` (2026-10-26): where the RecordStuff window goes for a computer-use round of the
 * edit view, and which files a round left beside a copied recording. scripts/edit-view-prep.mts does the I/O.
 */

/** A display as Cocoa gives it: its frame from the bottom-left of the main display, y upward. */
export interface CocoaScreen { x: number; y: number; width: number; height: number; main: boolean }
export interface WindowFrame { x: number; y: number; width: number; height: number }

/** The window's largest size for a round, the size the editor's toolbar was measured at (1060 px keeps its words). */
export const ROUND_WINDOW = { width: 1060, height: 1400 } as const;
/** Room kept for a menu bar above the window and a margin at its sides. */
const TOP = 30, SIDE = 10;

/**
 * The window's frame for a round, in Accessibility's coordinates (from the top-left of the main display, y downward):
 * on a display other than the main one when there is one (the main keeps the user's menu bar and windows), as large as
 * `ROUND_WINDOW` within it.
 */
export function roundWindowFrame(screens: readonly CocoaScreen[]): WindowFrame {
  const main = screens.find((s) => s.main) ?? screens[0];
  if (!main) throw new Error("no display");
  const target = screens.find((s) => !s.main) ?? main;
  // Cocoa's y counts up from the main display's bottom; Accessibility's down from its top.
  const top = main.height - (target.y + target.height);
  const width = Math.min(ROUND_WINDOW.width, target.width - 2 * SIDE);
  const height = Math.min(ROUND_WINDOW.height, target.height - TOP - SIDE);
  return { x: target.x + SIDE, y: top + TOP, width, height };
}

/**
 * The files an export of `base` (a recording's name without `.mp4`) may have left in its folder: `<base>（已編輯）.mp4`,
 * `<base> (edited).mp4` and their numbered forms (main/editing/editing.ts names them so), among `names`.
 */
export function exportsOf(base: string, names: readonly string[]): string[] {
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escape(base)}(?:（已編輯(?: \\d+)?）| \\(edited(?: \\d+)?\\))\\.mp4$`);
  return names.filter((name) => pattern.test(name));
}

/** A recording's name for `at`, as the recorder names it (`YYYY-MM-DD HH-MM-SS.mp4`). */
export function recordingName(at: Date): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}-${two(at.getMinutes())}-${two(at.getSeconds())}.mp4`;
}
