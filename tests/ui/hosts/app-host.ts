/**
 * The production-main integration host (plan 066): the built `out/main/index.js`, its windows, actions, storage and
 * pages, with only the OS boundary replaced (boundary.ts). Launched by the Playwright fixture with a seeded,
 * isolated userData/logs/videos tree; the test drives the pages with Playwright input and reaches this process
 * through `globalThis.__recordstuff` (fixtures.ts `AppHost`).
 *
 * Test-only controls: a write gate that holds settings.json's final rename, the shortcut adapter's failures and
 * key presses, tray clicks and menus, and the adapter calls the boundary recorded. No test IPC reaches a page.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type * as ElectronModule from "electron";
import { createBoundary } from "./boundary";

const require = createRequire(__filename);
const electron = require("electron") as typeof ElectronModule;
const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const root = env("RECORDSTUFF_UI_ROOT");
const data = env("RECORDSTUFF_UI_DATA");
const { app, BrowserWindow } = electron;

for (const name of ["userData", "logs", "sessionData", "videos"] as const) {
  const folder = path.join(data, name);
  fs.mkdirSync(folder, { recursive: true });
  app.setPath(name, folder);
}
app.setName("RecordStuff UI Test");
// `resourcesDir()` reads the tray icons beside the app; the built main resolves pages from its own folder.
app.getAppPath = () => root;
const settingsFile = path.join(data, "userData/settings.json");

const boundary = createBoundary(electron, { trashDir: path.join(data, "trash"), violationsFile: path.join(data, "violations.jsonl") });
for (const accelerator of (process.env.RECORDSTUFF_UI_FAILING_SHORTCUTS ?? "").split(",").filter(Boolean)) boundary.shortcuts.failing.add(accelerator);

/** Holds settings.json's final rename until released, so a confirmed save stays pending deterministically. */
interface WriteGate { started: boolean; release: (fail: boolean) => void; outcome: Promise<boolean> }
let writeGate: WriteGate | undefined;
const rename = fs.promises.rename.bind(fs.promises);
fs.promises.rename = (async (from: fs.PathLike, to: fs.PathLike) => {
  const gate = path.resolve(String(to)) === settingsFile ? writeGate : undefined;
  if (gate) {
    writeGate = undefined;
    gate.started = true;
    if (await gate.outcome) throw Object.assign(new Error("controlled settings write failure"), { code: "EIO" });
  }
  return rename(from, to);
}) as typeof fs.promises.rename;

const Module = require("node:module") as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const load = Module._load;
Module._load = function (request: string, ...rest: [unknown, boolean]) {
  return request === "electron" ? boundary.electron : load.call(this, request, ...rest);
};

const menuItems = (menu: ElectronModule.Menu | undefined): Array<{ label: string; enabled: boolean; checked: boolean; type: string }> =>
  (menu?.items ?? []).map(item => ({ label: item.label, enabled: item.enabled, checked: item.checked, type: item.type }));

/** What the Playwright fixture reaches with `application.evaluate`. */
const host = {
  kind: "app" as const,
  boundary,
  /** The real Electron module, for cleanup drills that bypass the boundary on purpose (drills.spec.ts D06). */
  realElectron: electron,
  settingsFile,
  data,
  readSettings: (): Record<string, unknown> => JSON.parse(fs.readFileSync(settingsFile, "utf8")) as Record<string, unknown>,
  holdSettingsWrite(): void {
    let release!: (fail: boolean) => void;
    writeGate = { started: false, release: fail => release(fail), outcome: new Promise<boolean>(resolve => { release = resolve; }) };
    current = writeGate;
  },
  writeHeld: (): boolean => current?.started === true,
  releaseSettingsWrite(fail = false): void { if (!current) throw new Error("No held settings write"); current.release(fail); current = undefined; },
  /** Before teardown quits the app: a write a failed test left held is let through, so quit is not deferred by the test's own gate. */
  prepareClose(): void { writeGate = undefined; current?.release(false); current = undefined; },
  /** The tray icon clicked with the right button, as macOS reports it: production pops its menu up. */
  rightClickTray(): Array<{ label: string; enabled: boolean; checked: boolean; type: string }> {
    const tray = boundary.tray();
    if (!tray) throw new Error("Production made no tray");
    tray.emit("right-click");
    return menuItems(tray.menu);
  },
  /** Clicks the first item of the last popped-up tray menu whose label matches. */
  clickTrayItem(pattern: string): string {
    const items = boundary.tray()?.menu?.items ?? [];
    const item = items.find(entry => new RegExp(pattern).test(entry.label));
    if (!item) throw new Error(`No tray item matches ${pattern}: ${items.map(entry => entry.label).join(" | ")}`);
    item.click(undefined, undefined, { triggeredByAccelerator: false } as ElectronModule.KeyboardEvent);
    return item.label;
  },
  /** The open Settings window, if any. */
  settingsWindow: (): ElectronModule.BrowserWindow | undefined => BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL().includes("settings.html")),
  /** What production asked of the Settings window: shown, focused, minimized (the boundary's virtual state). */
  settingsState: () => { const window = host.settingsWindow(); return window ? boundary.windowState(window) : undefined; },
  /** The full-screen video window, if one is open, and what production asked of it. */
  videoWindow: (): ElectronModule.BrowserWindow | undefined => BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL().includes("video.html")),
  videoShown: (): boolean => { const window = host.videoWindow(); return Boolean(window?.isVisible() && window.getOpacity() === 1); },
  trayDestroyed: (): boolean => boundary.tray()?.destroyed ?? true,
  settingsWindows: (): number[] => BrowserWindow.getAllWindows().filter(window => !window.isDestroyed() && window.webContents.getURL().includes("settings.html")).map(window => window.id),
};
let current: WriteGate | undefined;
(globalThis as Record<string, unknown>).__recordstuff = host;

require(path.join(root, "out/main/index.js"));
