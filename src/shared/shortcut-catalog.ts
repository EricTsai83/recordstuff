/**
 * Every keyboard shortcut RecordStuff itself offers (plan 073): the Keyboard Shortcuts tab lists these rows, and the
 * handlers that act on the keys read the constants below, so the list cannot drift from the key handling it describes.
 *
 * Not listed: the platform's standard editing and menu keys (⌘C, ⌘Q, ⌘H…), ordinary keyboard navigation in lists and
 * dialogs (Tab, arrows, Enter, Esc to cancel) and keys pressed while the shortcut editor records. They are platform
 * conventions, not RecordStuff features (docs/system-design/desktop.md).
 */
import { DEFAULT_HOTKEY, acceleratorKeys, settingsShortcut } from "./hotkey";
import type { PlainMessageKey } from "./i18n";

/** The page's close key with Command (macOS) or Ctrl, no other modifier (`isCloseChord`). */
export const CLOSE_KEY = "w";
/** The page's undo key for Move to Trash, with Command (macOS) or Ctrl. */
export const UNDO_KEY = "z";
/** The window's zoom keys with Command (macOS) or Ctrl, as `KeyboardEvent.key` reports them (`zoomRequest`). */
export const ZOOM_KEYS = { in: ["=", "+"], out: ["-", "_"], reset: ["0"] } as const;

/** The player's keys, as `KeyboardEvent.key` reports them with single characters lower-cased (`playerKeyAction`). */
export const PLAYER_KEYS = {
  playPause: [" ", "k"],
  seek: ["ArrowLeft", "ArrowRight"],
  volume: ["ArrowUp", "ArrowDown"],
  mute: ["m"],
  fullScreen: ["f"],
  /** Only while the seek bar has focus. */
  seekBar: ["PageUp", "PageDown", "Home", "End"],
} as const;
const SEEK_STEP_SECONDS = 5;
const SEEK_BAR_STEP_SECONDS = 10;
const VOLUME_STEP = 0.05;

export type PlayerKeyAction =
  | { kind: "toggle" }
  /** The arrows flash the side they seek to; the seek bar's own keys move its thumb, which shows it already. */
  | { kind: "seekBy"; seconds: number; flash?: "back" | "forward" }
  | { kind: "seekTo"; to: "start" | "end" }
  | { kind: "volume"; by: number }
  | { kind: "mute" }
  | { kind: "fullScreen" };

const has = (keys: readonly string[], key: string): boolean => keys.includes(key);

/**
 * What an unmodified key does in the player, or nothing. Space on a button presses the button instead, and the arrows
 * on the volume slider move the slider; the seek bar's own keys work only on it.
 */
export function playerKeyAction(
  eventKey: string,
  where: { onButton: boolean; onVolume: boolean; onSeek: boolean },
): PlayerKeyAction | undefined {
  const key = eventKey.length === 1 ? eventKey.toLowerCase() : eventKey;
  if ((key === " " && !where.onButton) || (key !== " " && has(PLAYER_KEYS.playPause, key))) return { kind: "toggle" };
  if (has(PLAYER_KEYS.seek, key) && !where.onVolume) {
    const forward = key === PLAYER_KEYS.seek[1];
    return { kind: "seekBy", seconds: forward ? SEEK_STEP_SECONDS : -SEEK_STEP_SECONDS, flash: forward ? "forward" : "back" };
  }
  if (has(PLAYER_KEYS.volume, key) && !where.onVolume)
    return { kind: "volume", by: key === PLAYER_KEYS.volume[0] ? VOLUME_STEP : -VOLUME_STEP };
  if (where.onSeek && has(PLAYER_KEYS.seekBar, key)) {
    if (key === "PageUp") return { kind: "seekBy", seconds: SEEK_BAR_STEP_SECONDS };
    if (key === "PageDown") return { kind: "seekBy", seconds: -SEEK_BAR_STEP_SECONDS };
    return { kind: "seekTo", to: key === "Home" ? "start" : "end" };
  }
  if (has(PLAYER_KEYS.mute, key)) return { kind: "mute" };
  if (has(PLAYER_KEYS.fullScreen, key)) return { kind: "fullScreen" };
  return undefined;
}

export type ShortcutCategory = "global" | "window" | "recordings" | "player" | "fullScreen" | "editor";
export const SHORTCUT_CATEGORIES: readonly ShortcutCategory[] = ["global", "window", "recordings", "player", "fullScreen", "editor"];
export const SHORTCUT_CATEGORY_LABELS: Record<ShortcutCategory, PlainMessageKey> = {
  global: "Anywhere",
  window: "RecordStuff window",
  recordings: "Recordings",
  player: "Player",
  fullScreen: "Full-screen video",
  editor: "Edit view",
};

/** Ids main fills in with the user's current choice and registration status. */
export type GlobalShortcutId = "record" | "open";

export interface CatalogShortcut {
  id: string;
  category: ShortcutCategory;
  label: PlainMessageKey;
  /**
   * Alternatives, any of which works: each an accelerator in `hotkey.ts`'s spelling (`CommandOrControl+W`), or a key
   * alone (`Escape`). Global rows give the default, which main replaces with the current choice.
   */
  keys: readonly string[];
  /** A pointer gesture that does the same, said in words (Double-click). */
  gesture?: PlainMessageKey;
  /** Where the keys work, when that is narrower than the category (On the seek bar). */
  where?: PlainMessageKey;
}

const accelerator = (key: string): string => `CommandOrControl+${key.toUpperCase()}`;

/** The rows, in the order the tab lists them; each category's rows stay together. */
export function shortcutCatalog(platform: string): readonly CatalogShortcut[] {
  return [
    { id: "record", category: "global", label: "Start or stop recording", keys: [DEFAULT_HOTKEY.accelerator] },
    { id: "open", category: "global", label: "Open RecordStuff", keys: [settingsShortcut(platform)] },
    // Escape closes what is open in the window, never the window itself (2026-10-26, the maintainer's request).
    { id: "close", category: "window", label: "Close the window", keys: [accelerator(CLOSE_KEY)] },
    { id: "undoTrash", category: "window", label: "Undo Move to Trash", keys: [accelerator(UNDO_KEY)] },
    { id: "zoomIn", category: "window", label: "Zoom In", keys: ["CommandOrControl+Plus"] },
    { id: "zoomOut", category: "window", label: "Zoom Out", keys: ["CommandOrControl+-"] },
    { id: "zoomReset", category: "window", label: "Actual Size", keys: ["CommandOrControl+0"] },
    { id: "clearSearch", category: "recordings", label: "Clear search", keys: ["Escape"], where: "In the search box" },
    { id: "playPause", category: "player", label: "Play or pause", keys: ["Space", "K"] },
    { id: "seek", category: "player", label: "Back or forward 5 seconds", keys: ["Left", "Right"] },
    { id: "volume", category: "player", label: "Volume up or down", keys: ["Up", "Down"] },
    { id: "mute", category: "player", label: "Mute", keys: ["M"] },
    { id: "fullScreen", category: "player", label: "Full screen", keys: ["F"] },
    { id: "seekPage", category: "player", label: "Forward or back 10 seconds", keys: ["PageUp", "PageDown"], where: "On the seek bar" },
    { id: "seekEnds", category: "player", label: "Jump to the start or end", keys: ["Home", "End"], where: "On the seek bar" },
    { id: "leaveFullScreen", category: "fullScreen", label: "Leave full screen", keys: ["Escape", accelerator(CLOSE_KEY), "F"], gesture: "Double-click" },
    // The edit view's keys (2026-10-26, the maintainer's request: they were only in the view's own keyboard button),
    // as editor.tsx binds them.
    { id: "editPlay", category: "editor", label: "Play or pause", keys: ["Space"] },
    { id: "editFrame", category: "editor", label: "Move a frame", keys: ["Left", "Right"], where: "On the timeline" },
    { id: "editSecond", category: "editor", label: "Move a second", keys: ["Shift+Left", "Shift+Right"], where: "On the timeline" },
    { id: "editSplit", category: "editor", label: "Split", keys: ["S"] },
    { id: "editRemove", category: "editor", label: "Remove the selection", keys: [platform === "darwin" ? "Backspace" : "Delete"] },
    { id: "editUndo", category: "editor", label: "Undo", keys: [accelerator(UNDO_KEY)] },
    { id: "editRedo", category: "editor", label: "Redo", keys: platform === "darwin" ? ["CommandOrControl+Shift+Z"] : ["Control+Y", "Control+Shift+Z"] },
    { id: "editCamera", category: "editor", label: "Hide or show the camera in the selection", keys: ["C"], where: "In an editable recording" },
    { id: "editVolume", category: "editor", label: "Set the volume of the selection", keys: ["V"], where: "In an editable recording" },
  ];
}

/**
 * Key names `acceleratorKeys` leaves as spelled, the same on every platform: it already draws macOS's arrows. Space is
 * a word in the list on macOS too, as its own menus write it: `␣` reads aloud as a symbol, not as a key (review 073).
 */
const KEY_NAMES: Record<string, string> = {
  Plus: "+", Escape: "Esc", Backspace: "Delete", PageUp: "Page Up", PageDown: "Page Down", Up: "↑", Down: "↓", Left: "←", Right: "→", "␣": "Space",
};

/** The keys of one alternative as shown, one per key, with the platform's modifier symbols or names. */
export function shortcutKeys(keys: string, platform: string): string[] {
  return acceleratorKeys(keys, platform).map((key) => KEY_NAMES[key] ?? key);
}

/** One alternative as a phrase, as `describeAccelerator` writes a shortcut: `⌥⌘,`, or `Ctrl+Shift+,` off macOS. */
export function shortcutText(keys: string, platform: string): string {
  return shortcutKeys(keys, platform).join(platform === "darwin" ? "" : "+");
}
