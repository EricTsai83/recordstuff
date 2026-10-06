/**
 * The countdown host (plan 066): the production `CountdownOverlay` with the built countdown preload and page, in a
 * hidden offscreen window behind the OS boundary (boundary.ts), driven by the test as the recorder drives it
 * (`prepare`, `show`, `update`, `dismiss`, `close`). The overlay module imports `electron` when it loads, so it is
 * loaded only after the boundary is installed. Its page is muted: a tick it would play is not heard, and whether one
 * was requested is read from the page's own sound flag. Capture exclusion and the audio route stay with real
 * recording rounds. Test-only; compiled by tests/ui/global-setup.ts.
 */
import path from "node:path";
import { createRequire } from "node:module";
import type * as ElectronModule from "electron";
import { createBoundary } from "./boundary";

const require = createRequire(__filename);
const electron = require("electron") as typeof ElectronModule;
const root = process.env.RECORDSTUFF_UI_ROOT!;
const data = process.env.RECORDSTUFF_UI_DATA!;
const { app } = electron;
const boundary = createBoundary(electron, { trashDir: path.join(data, "trash"), violationsFile: path.join(data, "violations.jsonl") });
const Module = require("node:module") as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const load = Module._load;
Module._load = function (request: string, ...rest: [unknown, boolean]) {
  return request === "electron" ? boundary.electron : load.call(this, request, ...rest);
};
app.setPath("userData", path.join(data, "profile"));
if (process.platform === "darwin") app.dock?.hide();
app.on("window-all-closed", () => undefined);

const logs: string[] = [];
const host: Record<string, unknown> = { kind: "view", boundary, logs };
(globalThis as Record<string, unknown>).__recordstuff = host;

void app.whenReady().then(async () => {
  const { CountdownOverlay } = await import("../../../src/main/recording/countdown-overlay");
  const display = (): { id: string; bounds: ElectronModule.Rectangle; workArea: ElectronModule.Rectangle } => {
    const primary = electron.screen.getPrimaryDisplay();
    return { id: String(primary.id), bounds: primary.bounds, workArea: primary.workArea };
  };
  host.overlay = new CountdownOverlay({
    preloadPath: path.join(root, "out/preload/countdown.js"), htmlPath: path.join(root, "out/renderer/countdown.html"),
    display, primaryDisplay: display, platform: process.platform, log: message => { logs.push(message); },
  });
  host.display = display;
  host.overlayWindow = (): ElectronModule.BrowserWindow | undefined => electron.BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL().includes("countdown.html"));
  host.ready = true;
});
