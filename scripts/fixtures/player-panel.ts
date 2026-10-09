/**
 * Electron main for `pnpm acceptance:player` (2026-10-05; reduced by plan 066 to what needs the desktop). Plays a
 * checked-in decodable clip (tests/ui/media) from its card in the app's own Settings window and full screen in the
 * app's own `VideoFullScreen`, shown on the display, with real input events sent to the pages:
 *
 * - N-P01: full screen covers the display: a shown, opaque window with the display's bounds (macOS: the simple
 *   full screen), still playing.
 * - N-P02: F leaves it: the window goes and the Settings window, still open, has its focus back.
 * - N-P03: a double-click on the picture plays full screen again, and Escape leaves it with the player open and
 *   the Settings window focused.
 *
 * The player's controls, keys, drag, rest and wake, the time handed both ways and the 16:9 stage run in the
 * background suite (tests/ui/player.spec.ts). Never a production entry; nothing here ships with the app. Compiled
 * by acceptance-player.mts before Electron loads it.
 */
import { app, BrowserWindow, ipcMain, protocol, screen } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { settingsView } from "../../src/main/settings/settings-model";
import { DEFAULT_QUALITY } from "../../src/shared/quality";
import { DEFAULT_HOTKEY } from "../../src/shared/hotkey";
import type { AppContext } from "../../src/main/app/ui-model";
import { MEDIA_SCHEME, MEDIA_SCHEME_PRIVILEGES, RecordingsLibrary } from "../../src/main/library/recordings-library";
import { settingsWindowOptions } from "../../src/main/settings/settings-window";
import { DEFAULT_SETTINGS_SIZE } from "../../src/main/settings/settings-window-state";
import { VideoFullScreen } from "../../src/main/library/video-fullscreen";
import { isFullScreenChoice } from "../../src/shared/video-player";
import type { Language } from "../../src/shared/i18n";

const [outDir, root, clips] = (() => {
  const [output, repository, folder] = process.argv.slice(-3);
  if (!output || !repository || !folder) throw new Error("Expected output, repository and clip folder");
  return [output, repository, folder] as const;
})();
const out = path.join(root, "out");
app.setPath("userData", path.join(outDir, "user-data"));
protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { ...MEDIA_SCHEME_PRIVILEGES } }]);

interface PlayerCase { name: string; ok: boolean; detail: string }
const results: PlayerCase[] = [];
const writeResults = (): void => fs.writeFileSync(path.join(outDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
/** Each case is saved as it is recorded, so an early stop or an interruption keeps the evidence so far (review: early exits). */
const record = (name: string, ok: boolean, detail: unknown): void => {
  results.push({ name, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
  console.log(`case ${results.length}: ${ok ? "PASS" : "FAIL"} — ${name}`);
  writeResults();
};
/** Every page's console errors, the full-screen windows' included (review: console errors). */
const errors: string[] = [];
app.on("web-contents-created", (_event, contents) => {
  contents.on("console-message", event => { if (event.level === "error") errors.push(`${contents.getURL().split("?")[0]!.split("/").pop()}: ${event.message}`); });
  // The clip's tone stays in this process: the round judges playback, not sound, and must not sound over the desk.
  contents.setAudioMuted(true);
});
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/**
 * Polls until `check` holds. A check that throws, such as one reading an element the page has not made yet, counts
 * as not yet: the case then passes or fails on its own record, never by stopping the round. Giving up says the last
 * error thrown, and whether the checks after it still answered no.
 */
const until = async (check: () => Promise<boolean> | boolean, timeout = 4000): Promise<boolean> => {
  const deadline = Date.now() + timeout;
  let failure: unknown;
  let answered = false;
  do {
    try { if (await check()) return true; answered = true; } catch (error) { failure = error; answered = false; }
    await settle(40);
  } while (Date.now() < deadline);
  if (failure !== undefined) {
    console.log(`until: gave up after ${timeout} ms; a check threw ${String(failure)}${answered ? ", and the later checks answered no" : ""}`);
  }
  return false;
};
const read = <T = unknown>(window: BrowserWindow, script: string): Promise<T> =>
  (window.webContents.executeJavaScript(script) as Promise<T>).catch((error: unknown) => {
    throw new Error(`${String(error)} in: ${script.trim().split("\n")[0]!.slice(0, 160)}`);
  });
interface Box { x: number; y: number; left: number; top: number; right: number; bottom: number; width: number; height: number }
const box = (window: BrowserWindow, selector: string): Promise<Box | null> => read(window, `(() => {
  const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
  return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null; })()`);
/** Real input, as the page receives a person's: a move to the point, then a press and release. */
const move = (window: BrowserWindow, x: number, y: number): void => window.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
const click = (window: BrowserWindow, x: number, y: number, clickCount = 1): void => {
  move(window, x, y);
  for (const type of ["mouseDown", "mouseUp"] as const) window.webContents.sendInputEvent({ type, button: "left", clickCount, x: Math.round(x), y: Math.round(y) });
};
const press = (window: BrowserWindow, keyCode: string): void => {
  window.webContents.sendInputEvent({ type: "keyDown", keyCode });
  if (keyCode.length === 1) window.webContents.sendInputEvent({ type: "char", keyCode });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode });
};
interface Playback { time: number; paused: boolean; muted: boolean; volume: number; src: string; duration: number }
/**
 * A video not made yet (the click that opens the player is delivered after this poll) throws here, in the fixture,
 * so `until` counts it as not yet; thrown in the page it would also be logged there as an uncaught error.
 */
const playback = async (window: BrowserWindow, selector: string): Promise<Playback> => {
  const state = await read<Playback | null>(window, `(() => {
  const v = document.querySelector(${JSON.stringify(selector)});
  return v && { time: v.currentTime, paused: v.paused, muted: v.muted, volume: v.volume, src: v.getAttribute("src") ?? "", duration: v.duration }; })()`);
  if (!state) throw new Error(`no ${selector} yet`);
  return state;
};
async function run(): Promise<boolean> {
  const language: Language = "zh-TW";
  const library = new RecordingsLibrary({ dir: () => clips, changed: () => {}, thumbnail: async () => undefined,
    trash: async () => {}, open: async () => "", reveal: () => {}, log: message => console.log(message) });
  protocol.handle(MEDIA_SCHEME, request => library.handle(request));
  await library.refresh();
  await library.lengths;
  const context = (): AppContext => ({ platform: process.platform, language, outputDir: clips, homeDir: os.homedir(), version: "0.0.0",
    quality: DEFAULT_QUALITY, countdown: 3, countdownSound: true, hotkey: { ...DEFAULT_HOTKEY, registered: true }, notifications: true,
    updates: { enabled: false, state: { kind: "idle" } }, display: { kind: "primary" }, displays: [], library: library.state });
  const view = () => settingsView({ type: "idle" }, context());
  const fullScreen = new VideoFullScreen({ preloadPath: path.join(out, "preload/video.js"), htmlPath: path.join(out, "renderer/video.html"),
    platform: process.platform, log: message => console.log(message) });
  let window!: BrowserWindow;
  ipcMain.handle("settings:read", () => view());
  ipcMain.handle("settings:ready", () => {});
  ipcMain.handle("settings:capture", () => view());
  // As SettingsWindow.playFullScreen answers: the listing's own source and name, over the display this window is on.
  ipcMain.handle("settings:choose", async (_event, group: unknown, choice: unknown) => {
    const id = typeof group === "string" && group.startsWith("recordingFile:") ? group.slice("recordingFile:".length) : undefined;
    const item = view().library?.items.find(entry => entry.id === id);
    if (!item || !isFullScreenChoice(choice)) return { view: view(), applied: false };
    const ended = await fullScreen.play({ src: item.video, state: choice.state, display: screen.getDisplayMatching(window.getBounds()).bounds,
      language, title: item.title, closed: () => { if (!window.isDestroyed()) window.focus(); } });
    return { view: view(), applied: ended !== undefined, ...(ended ? { playback: ended } : {}) };
  });

  window = new BrowserWindow(settingsWindowOptions({ platform: process.platform, preloadPath: path.join(out, "preload/settings.js"),
    title: "RecordStuff", size: DEFAULT_SETTINGS_SIZE, workArea: screen.getPrimaryDisplay().workArea }));
  await window.loadFile(path.join(out, "renderer/settings.html"), { query: { lang: language } });
  if (process.platform === "darwin") app.focus({ steal: true });
  window.show(); window.focus();
  // As SettingsWindow.show does: a full-screen page loads hidden for the next request (video-fullscreen.ts, macOS).
  fullScreen.prepare();
  /** On macOS, that page loaded and waiting, as a user's click a second after opening the window finds it. */
  const waiting = (): Promise<boolean> => process.platform !== "darwin" ? Promise.resolve(true) : until(() =>
    BrowserWindow.getAllWindows().some(other => other !== window && !other.isDestroyed() && !other.isVisible() && !other.webContents.isLoading()), 5000);
  await settle(600);
  const shot = async (target: BrowserWindow, file: string): Promise<void> => fs.writeFileSync(path.join(outDir, file), (await target.webContents.capturePage()).toPNG());

  const item = view().library?.items[0];
  if (!item) { record("N-P00 the Recordings tab lists the clip", false, { items: view().library?.items.length ?? 0 }); writeResults(); return false; }
  const card = await box(window, ".clip-open");
  click(window, card!.x, card!.y);
  await until(async () => { const p = await playback(window, ".player video"); return !p.paused && p.time > 0.3; }, 5000);
  // Full screen from its button, playing.
  await waiting();
  const fullButton = await box(window, "#player-fullscreen");
  click(window, fullButton!.x, fullButton!.y);
  let full: BrowserWindow | undefined;
  const shown = await until(() => {
    full = BrowserWindow.getAllWindows().find(other => other !== window && !other.isDestroyed());
    return Boolean(full?.isVisible() && full.getOpacity() === 1);
  }, 6000);
  const display = screen.getDisplayMatching(window.getBounds()).bounds;
  if (!full || !shown) { record("N-P01 Full screen opens a window of its own over the display", false, { shown, windows: BrowserWindow.getAllWindows().length }); writeResults(); return false; }
  const fullPlayback = await playback(full, "#video");
  record("N-P01 Full screen covers the display: a shown, opaque window with the display's bounds, still playing",
    full.isVisible() && JSON.stringify(full.getBounds()) === JSON.stringify(display) && (process.platform !== "darwin" || full.isSimpleFullScreen()) && !fullPlayback.paused,
    { bounds: full.getBounds(), display, simple: process.platform === "darwin" ? full.isSimpleFullScreen() : "n/a", focused: full.isFocused(), ...fullPlayback });
  move(full, display.width / 2, display.height - 40);
  await settle(250);
  await shot(full, "fullscreen-playing.png");
  press(full, "f");
  const left = await until(() => full!.isDestroyed(), 3000);
  const refocused = await until(() => window.isFocused(), 3000);
  record("N-P02 F leaves full screen: the window goes and the Settings window, still open, has its focus back",
    left && refocused && await read<boolean>(window, `document.querySelector(".player")?.hasAttribute("data-open")`), { left, refocused, after: await playback(window, ".player video") });
  await settle(1100);
  await waiting();
  const again = await box(window, ".player video");
  click(window, again!.x, again!.y, 1);
  window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 2, x: Math.round(again!.x), y: Math.round(again!.y) });
  window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 2, x: Math.round(again!.x), y: Math.round(again!.y) });
  let second: BrowserWindow | undefined;
  const reopened = await until(() => {
    second = BrowserWindow.getAllWindows().find(other => other !== window && !other.isDestroyed());
    return Boolean(second?.isVisible() && second.getOpacity() === 1);
  }, 6000);
  const covered = Boolean(second && JSON.stringify(second.getBounds()) === JSON.stringify(display));
  if (second) press(second, "Escape");
  const escaped = await until(() => !second || second.isDestroyed(), 3000);
  const backFocused = await until(() => window.isFocused(), 3000);
  const stillOpen = await read<boolean>(window, `document.querySelector(".player")?.hasAttribute("data-open")`);
  record("N-P03 a double-click on the picture covers the display again, and Escape leaves it with the player open and Settings focused",
    reopened && covered && escaped && stillOpen && backFocused, { reopened, covered, escaped, stillOpen, backFocused });
  await read(window, `document.getElementById("player-close").click()`);
  record("N-P00 the pages ran without console errors", errors.length === 0, { errors });
  fullScreen.close();
  writeResults();
  return results.every(result => result.ok);
}

app.on("window-all-closed", () => undefined);
app.whenReady()
  .then(run)
  .then(ok => app.exit(ok ? 0 : 1))
  .catch(error => {
    fs.writeFileSync(path.join(outDir, "error.txt"), String(error?.stack ?? error));
    writeResults();
    app.exit(2);
  });
