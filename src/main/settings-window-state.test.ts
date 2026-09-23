import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS_SIZE, SettingsWindowState, fitSettingsSize } from "./settings-window-state";
let dir: string;
let file: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-window-")); file = path.join(dir, "settings-window.json"); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
it("restores dimensions across instances without modifying recording preferences", () => {
  const prefs = path.join(dir, "settings.json"); fs.writeFileSync(prefs, "untouched");
  const store = new SettingsWindowState(file);
  expect(store.size).toEqual(DEFAULT_SETTINGS_SIZE);
  store.save({ width: 640, height: 780 });
  expect(new SettingsWindowState(file).size).toEqual({ width: 640, height: 780 });
  expect(fs.readFileSync(prefs, "utf8")).toBe("untouched");
  expect(fs.existsSync(`${file}.tmp`)).toBe(false);
});
it("falls back on invalid geometry and handles write failures without breaking the window", () => {
  const log = vi.fn();
  for (const value of ["broken", '{"width":-1,"height":500}', '{"width":500.5,"height":500}', '{"width":500}']) {
    fs.writeFileSync(file, value);
    expect(new SettingsWindowState(file, log).size).toEqual(DEFAULT_SETTINGS_SIZE);
  }
  const store = new SettingsWindowState(file, log); store.save({ width: 600, height: 700 });
  fs.mkdirSync(`${file}.tmp`);
  store.save({ width: 620, height: 720 });
  expect(store.size).toEqual({ width: 620, height: 720 });
  expect(new SettingsWindowState(file).size).toEqual({ width: 600, height: 700 });
  expect(log).toHaveBeenCalledWith(expect.stringContaining("size save failed"));
});
it("fits large and small preferences without exceeding even a tiny work area", () => {
  expect(fitSettingsSize({ width: 2000, height: 1500 }, { width: 1280, height: 800 })).toEqual({ width: 1280, height: 800 });
  expect(fitSettingsSize({ width: 10, height: 10 }, { width: 1280, height: 800 })).toEqual({ width: 380, height: 360 });
  expect(fitSettingsSize(DEFAULT_SETTINGS_SIZE, { width: 320, height: 300 })).toEqual({ width: 320, height: 300 });
});
