import { describe, expect, it } from "vitest";
import { describeAccelerator } from "./hotkey";
import {
  CLOSE_KEY, PLAYER_KEYS, SHORTCUT_CATEGORIES, UNDO_KEY, ZOOM_KEYS, playerKeyAction, shortcutCatalog, shortcutKeys, shortcutText,
  type PlayerKeyAction,
} from "./shortcut-catalog";

const nowhere = { onButton: false, onVolume: false, onSeek: false };
/** The `KeyboardEvent.key` a listed key name stands for. */
const eventKey = (name: string): string =>
  ({ Space: " ", Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown" })[name] ?? name;

describe("the shortcut catalog (plan 073)", () => {
  it("lists each row once, in category order, with every category used", () => {
    for (const platform of ["darwin", "win32"]) {
      const rows = shortcutCatalog(platform);
      expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
      const order = rows.map((row) => SHORTCUT_CATEGORIES.indexOf(row.category));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(new Set(rows.map((row) => row.category))).toEqual(new Set(SHORTCUT_CATEGORIES));
    }
  });

  it("names every player key the player acts on, and the player acts on every key it lists", () => {
    const expected: Record<string, (key: string) => PlayerKeyAction> = {
      playPause: () => ({ kind: "toggle" }),
      seek: (key) => key === "ArrowLeft" ? { kind: "seekBy", seconds: -5, flash: "back" } : { kind: "seekBy", seconds: 5, flash: "forward" },
      volume: (key) => ({ kind: "volume", by: key === "ArrowUp" ? 0.05 : -0.05 }),
      mute: () => ({ kind: "mute" }),
      fullScreen: () => ({ kind: "fullScreen" }),
      seekPage: (key) => ({ kind: "seekBy", seconds: key === "PageUp" ? 10 : -10 }),
      seekEnds: (key) => ({ kind: "seekTo", to: key === "Home" ? "start" : "end" }),
    };
    const listed = shortcutCatalog("darwin").filter((row) => row.category === "player");
    expect(listed.map((row) => row.id).sort()).toEqual(Object.keys(expected).sort());
    const keys: string[] = [];
    for (const row of listed) {
      const where = row.where ? { ...nowhere, onSeek: true } : nowhere;
      for (const name of row.keys) {
        const key = eventKey(name);
        keys.push(key.length === 1 ? key.toLowerCase() : key);
        expect(playerKeyAction(key, where), `${row.id} ${name}`).toEqual(expected[row.id]!(key));
      }
    }
    // Nothing the player handles is missing from the list.
    expect(keys.sort()).toEqual(Object.values(PLAYER_KEYS).flat().sort());
  });

  it("keeps the player's existing exceptions", () => {
    // Space presses a focused button; K still toggles there.
    expect(playerKeyAction(" ", { ...nowhere, onButton: true })).toBeUndefined();
    expect(playerKeyAction("k", { ...nowhere, onButton: true })).toEqual({ kind: "toggle" });
    expect(playerKeyAction("K", nowhere)).toEqual({ kind: "toggle" });
    // The arrows move the volume slider itself.
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) expect(playerKeyAction(key, { ...nowhere, onVolume: true }), key).toBeUndefined();
    // The seek bar's own keys work only on it; the arrows seek 5 s there too.
    for (const key of ["PageUp", "PageDown", "Home", "End"]) expect(playerKeyAction(key, nowhere), key).toBeUndefined();
    expect(playerKeyAction("ArrowRight", { ...nowhere, onSeek: true })).toEqual({ kind: "seekBy", seconds: 5, flash: "forward" });
    expect(playerKeyAction("x", nowhere)).toBeUndefined();
  });

  it("lists the window keys the page and main compare", () => {
    const rows = shortcutCatalog("darwin");
    const keysOf = (id: string) => rows.find((row) => row.id === id)!.keys;
    // Escape never closes the window (2026-10-26).
    expect(keysOf("close")).toEqual([`CommandOrControl+${CLOSE_KEY.toUpperCase()}`]);
    expect(keysOf("undoTrash")).toEqual([`CommandOrControl+${UNDO_KEY.toUpperCase()}`]);
    expect(keysOf("leaveFullScreen")).toContain(`CommandOrControl+${CLOSE_KEY.toUpperCase()}`);
    expect([...keysOf("zoomIn"), ...keysOf("zoomOut"), ...keysOf("zoomReset")].map((key) => key.split("+")[1]))
      .toEqual(["Plus", ZOOM_KEYS.out[0], ZOOM_KEYS.reset[0]]);
    expect(ZOOM_KEYS.in).toContain("+");
  });

  it("draws keys with the platform's modifier symbols or names", () => {
    expect(shortcutKeys("CommandOrControl+Alt+,", "darwin")).toEqual(["⌥", "⌘", ","]);
    expect(shortcutKeys("Control+Shift+,", "win32")).toEqual(["Ctrl", "Shift", ","]);
    expect(shortcutKeys("CommandOrControl+Plus", "win32")).toEqual(["Ctrl", "+"]);
    expect(shortcutKeys("Escape", "darwin")).toEqual(["Esc"]);
    expect(shortcutKeys("Left", "win32")).toEqual(["←"]);
    // Space is a word on both: `␣` reads aloud as a symbol, not a key.
    for (const platform of ["darwin", "win32"]) expect(shortcutText("Space", platform)).toBe("Space");
    // A global shortcut reads as menus and notifications write it.
    for (const platform of ["darwin", "win32"])
      expect(shortcutText("CommandOrControl+Shift+1", platform)).toBe(describeAccelerator("CommandOrControl+Shift+1", platform));
  });
});
