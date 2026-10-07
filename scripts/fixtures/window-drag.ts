/** Production window options, preload and page; only the idle model/IPC and userData are isolated. */
import { app, BrowserWindow, ipcMain, nativeTheme, screen } from "electron";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { settingsWindowOptions } from "../../src/main/settings/settings-window";
import { settingsView } from "../../src/main/settings/settings-model";
import { DEFAULT_QUALITY } from "../../src/shared/quality";
import { DEFAULT_HOTKEY } from "../../src/shared/hotkey";
import type { AppContext } from "../../src/main/app/ui-model";
import { AccessibilityBlockedError, AX_SCRIPT, captureRect, KEY, osascriptAx, parseAxResult, type Frame } from "../lib/runner/native-ax.mts";
import { judgeDrag, nativeDrag, restorePointer, type Point } from "../lib/runner/native-drag.mts";
import { command } from "../lib/runner/processes.mts";

const [dir, root] = process.argv.slice(-2) as [string, string];
app.setPath("userData", path.join(dir, "user-data"));
const controller = new AbortController();
const ax = osascriptAx(controller.signal);
const cases: Array<{ name: string; ok: boolean; detail: unknown }> = [];
let complete = false, blocked = false, error: string | undefined, cleanupError: string | undefined;
let pointer: Point | undefined, window: BrowserWindow | undefined;
let blurs = 0;
class Blocked extends Error {}
const read = <T>(script: string): Promise<T> => window!.webContents.executeJavaScript(script) as Promise<T>;
const record = (name: string, ok: boolean, detail: unknown): void => {
  cases.push({ name, ok, detail });
  fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify({ cases, complete, blocked, error, cleanupError }, null, 2));
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
};
async function until(check: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt++) {
    controller.signal.throwIfAborted();
    if (await check()) return true;
    await delay(50, undefined, { signal: controller.signal });
  }
  return false;
}
async function frame(): Promise<Frame> {
  const snapshot = await ax.windows(process.pid);
  if (snapshot.frontmostPid !== process.pid || !window!.isFocused() || !window!.isVisible()) throw new Blocked("The owned test window lost foreground focus");
  const result = snapshot.windows.find(item => item.title === "RecordStuff")?.frame;
  if (!result) throw new Error("No AX frame for the owned RecordStuff test window");
  return result;
}
async function rect(selector: string): Promise<Frame> {
  const box = await read<Frame | null>(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`);
  if (!box || box.width <= 0 || box.height <= 0) throw new Error(`No visible target: ${selector}`);
  const origin = window!.getContentBounds(), zoom = window!.webContents.getZoomFactor();
  return { x: origin.x + box.x * zoom, y: origin.y + box.y * zoom, width: box.width * zoom, height: box.height * zoom };
}
const centre = (box: Frame): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
async function click(selector: string): Promise<void> {
  await frame();
  const point = centre(await rect(selector));
  await ax.mouse("left", point.x, point.y);
}
async function dragCase(name: string, point: Point, moves: boolean): Promise<void> {
  const before = await frame(), startBlurs = blurs;
  const area = captureRect({ ...before, width: before.width + 60, height: before.height + 40 });
  await command("screencapture", ["-x", "-R", area, path.join(dir, `${name}-before.png`)], controller.signal, 15_000);
  // No setBounds, renderer input or IPC between these two independent OS frame reads.
  await nativeDrag(point, { x: point.x + 60, y: point.y + 40 }, controller.signal);
  await delay(200, undefined, { signal: controller.signal });
  const after = await frame();
  if (blurs !== startBlurs) throw new Blocked(`Window blurred during ${name}`);
  const expected = moves ? { x: 60, y: 40 } : { x: 0, y: 0 };
  const problems = judgeDrag(before, after, expected);
  await command("screencapture", ["-x", "-R", area, path.join(dir, `${name}-after.png`)], controller.signal, 15_000);
  record(name, problems.length === 0, { before, after, expected, point, problems });
  // Setup for the next case, explicitly outside the measured drag. Never evidence for a pass.
  window!.setBounds(before);
  await delay(100, undefined, { signal: controller.signal });
}

const ctx: AppContext = {
  platform: "darwin", language: "en", outputDir: "/tmp", homeDir: "/tmp", version: "acceptance",
  quality: DEFAULT_QUALITY, countdown: 3, countdownSound: true, hotkey: { ...DEFAULT_HOTKEY, registered: true },
  notifications: false, updates: { enabled: true, state: { kind: "idle" } }, display: { kind: "primary" },
  displays: [{ id: "1", label: "Fixture display", logicalWidth: 1920, logicalHeight: 1080, scaleFactor: 2, internal: true, primary: true }],
};
const view = settingsView({ type: "idle" }, ctx);
ipcMain.handle("settings:read", () => view);
ipcMain.handle("settings:ready", () => {});
ipcMain.handle("settings:zoom", () => {});
ipcMain.handle("settings:capture", () => view);
ipcMain.handle("settings:choose", () => ({ view, applied: false }));
app.on("window-all-closed", () => {});
// Let a cancelled drag release its button before quitting; the parent still bounds cleanup.
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());

async function run(): Promise<void> {
  const access = parseAxResult<{ allowed: boolean }>(await command("osascript", ["-l", "JavaScript", "-e", AX_SCRIPT, "screen-access"], controller.signal, 3000), "screen access");
  if (!access.allowed) throw new Blocked("Screen Recording access is missing for OS screenshots; the runner never requests or changes privacy permissions");
  const work = screen.getPrimaryDisplay().workArea;
  if (work.width < 1090 || work.height < 700) throw new Blocked("Need a primary display work area of at least 1090×700 pt for wide 150% and a 60×40 pt drag");
  pointer = screen.getCursorScreenPoint();
  nativeTheme.themeSource = "light";
  window = new BrowserWindow(settingsWindowOptions({ platform: "darwin", title: "RecordStuff", size: { width: 900, height: 600 },
    workArea: work, preloadPath: path.join(root, "out/preload/settings.js") }));
  window.on("blur", () => { blurs++; });
  const consoleErrors: string[] = [];
  window.webContents.on("console-message", event => { if (event.level === "error") consoleErrors.push(event.message); });
  await window.loadFile(path.join(root, "out/renderer/settings.html"), { query: { lang: "en" } });
  if (!await until(() => read<boolean>(`Boolean(document.querySelector('#tab-general'))`))) throw new Error("Settings did not render");
  app.focus({ steal: true }); window.show(); window.focus();
  if (!await until(async () => window!.isFocused())) throw new Blocked("Could not activate the owned test window");
  await frame(); // Accessibility preflight before any pointer input.
  fs.writeFileSync(path.join(dir, "environment.json"), JSON.stringify({ pid: process.pid, electron: process.versions.electron,
    workArea: work, pointer, runtime: "out/preload/settings.js + out/renderer/settings.html", userData: app.getPath("userData") }, null, 2));

  for (const profile of [{ name: "wide-100", width: 900, zoom: 1 }, { name: "wide-150", width: 930, zoom: 1.5 }, { name: "narrow-100", width: 480, zoom: 1 }]) {
    controller.signal.throwIfAborted();
    window.webContents.setZoomFactor(profile.zoom);
    window.setBounds({ x: work.x + 50, y: work.y + 50, width: profile.width, height: 600 });
    await delay(400, undefined, { signal: controller.signal });
    const top = await rect(".titlebar");
    for (const [label, fraction] of [["left", 0.25], ["middle", 0.55], ["right", 0.85]] as const)
      await dragCase(`${profile.name}-top-${label}`, { x: top.x + top.width * fraction, y: top.y + Math.min(top.height / 2, 20) }, true);
    if (profile.name.startsWith("narrow")) continue;
    const brand = await rect(".brand"), lastTab = await rect("#tab-failures"), footer = await rect("#sidebar-about-hide");
    const bottom = lastTab.y + lastTab.height, gap = footer.y - bottom;
    if (gap < 80) throw new Error("Sidebar has no unambiguous blank gap for dragging");
    await dragCase(`${profile.name}-sidebar-blank`, { x: centre(lastTab).x, y: bottom + gap / 2 }, true);
    await dragCase(`${profile.name}-brand`, centre(brand), true);
    await dragCase(`${profile.name}-tab-no-drag`, centre(await rect("#tab-recording")), false);
    await click("#tab-recording");
    const selected = await until(() => read<boolean>(`document.querySelector('#tab-recording')?.getAttribute('aria-selected') === 'true'`));
    record(`${profile.name}-tab-click`, selected, { selected });
    await dragCase(`${profile.name}-menu-button-no-drag`, centre(await rect("#sidebar-about-hide-menu")), false);
    await click("#sidebar-about-hide-menu");
    const opened = await until(() => read<boolean>(`Boolean(document.querySelector('[role="menu"][data-open]'))`));
    record(`${profile.name}-menu-click`, opened, { opened });
    if (!opened) throw new Error("Window actions menu did not open; cannot test the overlay");
    await dragCase(`${profile.name}-menu-overlay-no-drag`, { x: top.x + top.width * 0.85, y: top.y + Math.min(top.height / 2, 20) }, false);
    // The outside mouse-down used by the overlay case may already dismiss the menu.
    // Escape with no menu open would correctly close Settings instead of preparing the next profile.
    if (await read<boolean>(`Boolean(document.querySelector('[role="menu"][data-open]'))`)) await ax.key(KEY.escape);
    if (!await until(() => read<boolean>(`!document.querySelector('[role="menu"][data-open]')`))) throw new Error("Window actions menu did not close");
  }
  record("console", consoleErrors.length === 0, consoleErrors);
  complete = true;
}

app.whenReady().then(run).catch(cause => {
  blocked = cause instanceof AccessibilityBlockedError || cause instanceof Blocked;
  error = String(cause?.stack ?? cause);
}).finally(async () => {
  try { if (pointer) await restorePointer(pointer); } catch (cause) { cleanupError = String(cause); }
  if (window && !window.isDestroyed()) window.close();
  fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify({ cases, complete, blocked, error, cleanupError }, null, 2));
  app.quit();
});
