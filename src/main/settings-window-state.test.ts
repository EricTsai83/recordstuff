import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS_SIZE, SettingsWindowState, fitSettingsSize } from "./settings-window-state";
let dir: string;
let file: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-window-")); file = path.join(dir, "settings-window.json"); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
it("restores dimensions across instances without modifying recording preferences", async () => {
  const prefs = path.join(dir, "settings.json"); fs.writeFileSync(prefs, "untouched");
  const store = new SettingsWindowState(file);
  expect(store.size).toEqual(DEFAULT_SETTINGS_SIZE);
  store.save({ width: 640, height: 780 });
  await store.flush();
  expect(new SettingsWindowState(file).size).toEqual({ width: 640, height: 780 });
  expect(fs.readFileSync(prefs, "utf8")).toBe("untouched");
  expect(fs.existsSync(`${file}.tmp`)).toBe(false);
});
it("falls back on invalid geometry and handles write failures without breaking the window", async () => {
  const log = vi.fn();
  for (const value of ["broken", '{"width":-1,"height":500}', '{"width":500.5,"height":500}', '{"width":500}']) {
    fs.writeFileSync(file, value);
    expect(new SettingsWindowState(file, log).size).toEqual(DEFAULT_SETTINGS_SIZE);
  }
  const store = new SettingsWindowState(file, log); store.save({ width: 600, height: 700 });
  await store.flush();
  fs.mkdirSync(`${file}.tmp`);
  store.save({ width: 620, height: 720 });
  expect(store.size).toEqual({ width: 620, height: 720 });
  await store.flush();
  expect(new SettingsWindowState(file).size).toEqual({ width: 600, height: 700 });
  expect(log).toHaveBeenCalledWith(expect.stringContaining("size save failed"));
});
it("fits large and small preferences without exceeding even a tiny work area", () => {
  expect(fitSettingsSize({ width: 2000, height: 1500 }, { width: 1280, height: 800 })).toEqual({ width: 1280, height: 800 });
  expect(fitSettingsSize({ width: 10, height: 10 }, { width: 1280, height: 800 })).toEqual({ width: 380, height: 360 });
  expect(fitSettingsSize(DEFAULT_SETTINGS_SIZE, { width: 320, height: 300 })).toEqual({ width: 320, height: 300 });
});
it("opens any size stored before the sidebar once at the new default, then keeps what the user chooses", async () => {
  // Before the sidebar, and against its first 720 × 580 default (layout 2).
  for (const old of ['{"width":560,"height":680}', '{"width":380,"height":603}', '{"width":900,"height":700}', '{"width":874,"height":543,"layout":2}']) {
    fs.writeFileSync(file, old);
    expect(new SettingsWindowState(file).size).toEqual({ width: 960, height: 640 });
  }
  const store = new SettingsWindowState(file);
  store.save({ width: 380, height: 603 });
  await store.flush();
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ width: 380, height: 603, layout: 3 });
  expect(new SettingsWindowState(file).size).toEqual({ width: 380, height: 603 });
});
