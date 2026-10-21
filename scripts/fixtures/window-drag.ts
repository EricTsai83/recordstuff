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
/** The sidebar's blank space between its last tab and the window actions: its height and the point at its middle. */
async function sidebarGap(actions: string): Promise<{ size: number; x: number; y: number }> {
  const last = await rect("#tab-failures"), foot = await rect(actions), bottom = last.y + last.height;
  return { size: foot.y - bottom, x: centre(last).x, y: bottom + (foot.y - bottom) / 2 };
}
/** Open or close the sidebar by a click on its toggle, the user's own input; setup, never evidence. */
async function setSidebar(mode: "full" | "collapsed"): Promise<void> {
  const collapsed = (): Promise<boolean> => read<boolean>(`document.querySelector("main")?.dataset.sidebar === "collapsed"`);
  if (await collapsed() !== (mode === "collapsed")) await click("#sidebar-toggle");
  if (!await until(async () => await collapsed() === (mode === "collapsed"))) throw new Error(`The sidebar toggle did not make the sidebar ${mode}`);
  await delay(200, undefined, { signal: controller.signal });
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
  if (work.width < 1090 || work.height < 760) throw new Blocked("Need a primary display work area of at least 1090×760 pt for wide 150% and a 60×40 pt drag");
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

  // The full sidebar at 100% and 150%, the collapsed one in the same windows, and a narrow window, which keeps the
  // collapsed sidebar without its toggle (2026-10-21). The full sidebar needs a page over 420 px tall, so the 150%
  // window is 660 pt (440 px) tall.
  for (const profile of [{ name: "wide-100", width: 900, height: 600, zoom: 1, wide: true }, { name: "wide-150", width: 930, height: 660, zoom: 1.5, wide: true },
    { name: "narrow-100", width: 480, height: 600, zoom: 1, wide: false }]) {
    controller.signal.throwIfAborted();
    window.webContents.setZoomFactor(profile.zoom);
    window.setBounds({ x: work.x + 50, y: work.y + 50, width: profile.width, height: profile.height });
    await delay(400, undefined, { signal: controller.signal });
    const top = await rect(".titlebar");
    for (const [label, fraction] of [["left", 0.25], ["middle", 0.55], ["right", 0.85]] as const)
      await dragCase(`${profile.name}-top-${label}`, { x: top.x + top.width * fraction, y: top.y + Math.min(top.height / 2, 20) }, true);
    for (const mode of profile.wide ? ["full", "collapsed"] as const : ["collapsed"] as const) {
      const name = profile.wide ? `${profile.name}-${mode}` : profile.name;
      if (profile.wide) await setSidebar(mode);
      const actions = mode === "full" ? "#sidebar-about-hide" : "#sidebar-about-hide-menu";
      // The sidebar's blank space between the tabs and the window actions drags. Should six tabs leave too little of it
      // to aim at unambiguously, the window grows, as a user would make it, first.
      let gap = await sidebarGap(actions);
      if (gap.size < 80) {
        const height = Math.ceil(window.getBounds().height + 90 - gap.size);
        if (work.y + 50 + height > work.y + work.height) throw new Blocked(`Need a primary display work area of at least ${height + 50} pt tall for ${name}'s sidebar gap`);
        window.setBounds({ ...window.getBounds(), height });
        await delay(400, undefined, { signal: controller.signal });
        gap = await sidebarGap(actions);
        if (gap.size < 80) throw new Error(`Sidebar has no unambiguous blank gap for dragging (${name}, ${gap.size} pt)`);
      }
      await dragCase(`${name}-sidebar-blank`, { x: gap.x, y: gap.y }, true);
      if (mode === "full") await dragCase(`${name}-brand`, centre(await rect(".brand")), true);
      await dragCase(`${name}-tab-no-drag`, centre(await rect("#tab-recording")), false);
      await click("#tab-recording");
      const selected = await until(() => read<boolean>(`document.querySelector('#tab-recording')?.getAttribute('aria-selected') === 'true'`));
      record(`${name}-tab-click`, selected, { selected });
      await click("#tab-library");
      if (profile.wide) await dragCase(`${name}-toggle-no-drag`, centre(await rect("#sidebar-toggle")), false);
      await dragCase(`${name}-menu-button-no-drag`, centre(await rect("#sidebar-about-hide-menu")), false);
      await click("#sidebar-about-hide-menu");
      const opened = await until(() => read<boolean>(`Boolean(document.querySelector('[role="menu"][data-open]'))`));
      record(`${name}-menu-click`, opened, { opened });
      if (!opened) throw new Error("Window actions menu did not open; cannot test the overlay");
      await dragCase(`${name}-menu-overlay-no-drag`, { x: top.x + top.width * 0.85, y: top.y + Math.min(top.height / 2, 20) }, false);
      // The outside mouse-down used by the overlay case may already dismiss the menu.
      // Escape with no menu open would correctly close Settings instead of preparing the next profile.
      if (await read<boolean>(`Boolean(document.querySelector('[role="menu"][data-open]'))`)) await ax.key(KEY.escape);
      if (!await until(() => read<boolean>(`!document.querySelector('[role="menu"][data-open]')`))) throw new Error("Window actions menu did not close");
    }
    if (profile.wide) await setSidebar("full");
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
