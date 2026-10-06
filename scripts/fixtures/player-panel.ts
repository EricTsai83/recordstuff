/**
 * Electron main for `pnpm acceptance:player` (2026-10-05). Plays a real, decodable clip through the built Settings
 * page's player and the built full-screen window, with real mouse and key input sent to the pages, and reports each
 * case: the player's own controls, their resting and waking, the keys, a seek-bar drag, the volume slider, the
 * window controls' corner, full screen with its title and the time handed both ways, and Close.
 *
 * The view is the real `settingsView` over the app's own `RecordingsLibrary`, served under `recordstuff-media:`,
 * and full screen is the app's own `VideoFullScreen` with the built `video.html` and its preload. Only the IPC
 * handlers are the fixture's: they answer as `SettingsWindow.playFullScreen` does, whose own unit tests cover it.
 * Never a production entry; nothing here ships with the app. Compiled by acceptance-player.mts before Electron loads it.
 */
import { app, BrowserWindow, ipcMain, nativeTheme, protocol, screen } from "electron";
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
import { VIDEO_TIMING, isFullScreenChoice } from "../../src/shared/video-player";
import { phrases, translate, type Language, type PlainMessageKey } from "../../src/shared/i18n";
import { TRAFFIC_LIGHT_ZONE } from "../../src/shared/window-controls";

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
/** Whether the controls have stepped aside: the resting class, the shade faded out and the pointer hidden. */
const resting = (window: BrowserWindow): Promise<{ idle: boolean; opacity: string; cursor: string }> => read(window, `(() => {
  const root = document.querySelector(".pc");
  return { idle: root.classList.contains("pc-idle"), opacity: getComputedStyle(root.querySelector(".pc-bottom")).opacity, cursor: getComputedStyle(root).cursor }; })()`);

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
  await settle(600);
  const shot = async (target: BrowserWindow, file: string): Promise<void> => fs.writeFileSync(path.join(outDir, file), (await target.webContents.capturePage()).toPNG());

  const item = view().library?.items[0];
  record("the Recordings tab lists the generated clip with its length", Boolean(item?.duration === "0:08"), { item });
  if (!item) return false;
  const label = (key: PlainMessageKey): string => translate(key, language);

  // Opening: a real click on the card.
  const card = await box(window, ".clip-open");
  click(window, card!.x, card!.y);
  const opened = await until(async () => { const p = await playback(window, ".player video"); return !p.paused && p.time > 0.3; }, 5000);
  const structure = await read<{ open: boolean; native: boolean; buttons: string[]; labels: string[]; title: string; meta: string }>(window, `(() => {
    const p = document.querySelector(".player");
    return { open: p.hasAttribute("data-open"), native: p.querySelector("video").controls, buttons: [...p.querySelectorAll("button")].map(b => b.id),
      labels: [...p.querySelectorAll("button, input")].map(el => el.getAttribute("aria-label")),
      title: p.querySelector(".pc-title").textContent, meta: p.querySelector(".pc-meta").textContent }; })()`);
  record("a click on a card opens the player and plays the recording", opened && structure.open, { opened, ...(await playback(window, ".player video")) });
  record("the player has its own named controls, none of Chromium's, and the recording's name over the picture",
    !structure.native && structure.buttons.join() === "player-close,player-play,player-mute,player-fullscreen"
      && structure.labels.join() === [label("Close"), label("Playback position"), label("Pause"), label("Mute"), label("Volume"), label("Full screen")].join()
      // Titled by the recording's name, with when it was recorded in the line beneath (2026-10-06).
      && structure.title === item.title && structure.meta.includes(phrases([item.day, item.time], language)), structure);

  // Resting and waking: the pointer over the picture, then still.
  const bar = await box(window, ".player .pc-bottom");
  move(window, bar!.x, bar!.y);
  await settle(250);
  await shot(window, "player-playing-light.png");
  const picture = await box(window, ".player video");
  move(window, picture!.x, picture!.y);
  await settle(VIDEO_TIMING.idleMs + 600);
  // The same state judged, with time for a timer a loaded machine runs late (it failed once 600 ms past it).
  await until(async () => (await resting(window)).idle, 1500);
  const rested = await resting(window);
  await shot(window, "player-resting-light.png");
  record(`while it plays, the controls and the pointer step aside after ${VIDEO_TIMING.idleMs / 1000} s at rest`, rested.idle && rested.opacity === "0" && rested.cursor === "none", rested);
  move(window, picture!.x + 12, picture!.y + 6);
  await settle(350);
  const woken = await resting(window);
  record("a pointer move brings them back", !woken.idle && woken.opacity === "1", woken);

  // A click on the picture pauses; paused, the controls stay.
  click(window, picture!.x, picture!.y);
  const paused = await until(async () => (await playback(window, ".player video")).paused);
  await settle(VIDEO_TIMING.idleMs + 600);
  const stayed = await resting(window);
  record("a click on the picture pauses it, and paused the controls stay", paused && !stayed.idle && stayed.opacity === "1", { paused, ...stayed });
  await shot(window, "player-paused-light.png");

  // YouTube's keys, with focus on the picture after the click.
  press(window, "Space");
  const spacePlays = await until(async () => !(await playback(window, ".player video")).paused);
  press(window, "k");
  const kPauses = await until(async () => (await playback(window, ".player video")).paused);
  await read(window, `document.querySelector(".player video").currentTime = 1`);
  await until(async () => Math.abs((await playback(window, ".player video")).time - 1) < 0.05);
  press(window, "Right");
  const skipped = await until(async () => Math.abs((await playback(window, ".player video")).time - 6) < 0.3);
  press(window, "m");
  // Chromium reports the change (volumechange) a task later than the property: the button is renamed then.
  const muteName = (): Promise<string> => read<string>(window, `document.getElementById("player-mute").getAttribute("aria-label")`);
  const muted = await until(async () => (await playback(window, ".player video")).muted && await muteName() === label("Unmute"));
  const muteLabel = await muteName();
  press(window, "m");
  const unmuted = await until(async () => !(await playback(window, ".player video")).muted);
  record("Space plays, K pauses, → moves 5 s and M mutes and unmutes, from the keyboard",
    spacePlays && kPauses && skipped && muted && muteLabel === label("Unmute") && unmuted,
    { spacePlays, kPauses, skipped, muted, muteLabel, unmuted, at: (await playback(window, ".player video")).time });

  // A real drag along the seek bar, from half a second in, so only a drag that works lands at three quarters (review: drag start).
  await read(window, `document.querySelector(".player video").currentTime = 0.5`);
  await until(async () => Math.abs((await playback(window, ".player video")).time - 0.5) < 0.05);
  const seek = await box(window, ".player .pc-seek");
  move(window, seek!.left + seek!.width * 0.2, seek!.y);
  window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x: Math.round(seek!.left + seek!.width * 0.2), y: Math.round(seek!.y) });
  // A move with the button held, as a hand drags: without the held button Chromium ends the slider's drag at the first move.
  // Each move is sent only once the last one has moved the video, never after a fixed pause: on a loaded machine a pause
  // let later moves arrive before the slider had handled earlier ones (2026-10-06: the drag stopped at 0.5 in one run).
  // The trace records where every step landed and whether the slider still held the drag.
  const { duration } = await playback(window, ".player video");
  const trace: Array<{ at: number; landed: boolean; time: number; dragging: boolean }> = [];
  for (const at of [0.35, 0.5, 0.65, 0.75]) {
    window.webContents.sendInputEvent({ type: "mouseMove", button: "left", modifiers: ["leftbuttondown"], x: Math.round(seek!.left + seek!.width * at), y: Math.round(seek!.y) });
    const landed = await until(async () => Math.abs((await playback(window, ".player video")).time - duration * at) < 0.3, 1500);
    trace.push({ at, landed, ...(await read<{ time: number; dragging: boolean }>(window,
      `({ time: document.querySelector(".player video").currentTime, dragging: document.querySelector(".player .pc-seek").hasAttribute("data-dragging") })`)) });
  }
  window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: Math.round(seek!.left + seek!.width * 0.75), y: Math.round(seek!.y) });
  const sought = await until(async () => { const p = await playback(window, ".player video"); return p.paused && Math.abs(p.time - p.duration * 0.75) < 0.6; });
  record("a drag along the seek bar moves the video from 0.5 s to where it is let go", sought, { ...(await playback(window, ".player video")), trace });

  // The volume slider slides out beside its button under the pointer.
  const mute = await box(window, "#player-mute");
  move(window, mute!.x, mute!.y);
  await settle(350);
  const level = await box(window, ".player .pc-level");
  record("the volume slider slides out beside its button under the pointer", (level?.width ?? 0) > 40, level);

  // The window controls' corner: nothing in the player lies under them, however it is placed.
  if (process.platform === "darwin") {
    const corner = await read<{ top: number; covered: string[] }>(window, `(() => {
      const dialog = document.querySelector(".player"), found = new Set();
      for (let x = 1; x < ${TRAFFIC_LIGHT_ZONE.width}; x += 2) for (let y = 1; y < ${TRAFFIC_LIGHT_ZONE.height}; y += 2)
        // The Base UI backdrop lies around the modal; only controls inside the open popup count.
        for (const hit of document.elementsFromPoint(x, y)) if (hit !== dialog && dialog.contains(hit)) found.add(hit.id || hit.className || hit.tagName);
      return { top: dialog.getBoundingClientRect().top, covered: [...found] }; })()`);
    record("no part of the player lies under the window controls", corner.covered.length === 0 && corner.top >= TRAFFIC_LIGHT_ZONE.height, corner);
  }

  // Full screen, from its button, playing: a window of its own with the title, the same controls and the time handed over.
  press(window, "Space");
  await until(async () => !(await playback(window, ".player video")).paused);
  await read(window, `document.querySelector(".player video").currentTime = 2`);
  await settle(150);
  // Where the player was when full screen was asked for: the full-screen page must start there, not merely pass it later.
  const handed = (await playback(window, ".player video")).time;
  const fullButton = await box(window, "#player-fullscreen");
  click(window, fullButton!.x, fullButton!.y);
  let full: BrowserWindow | undefined;
  const shown = await until(() => {
    full = BrowserWindow.getAllWindows().find(other => other !== window && !other.isDestroyed());
    return Boolean(full?.isVisible() && full.getOpacity() === 1);
  }, 6000);
  if (!full || !shown) { record("Full screen opens a window of its own over the display", false, { shown, windows: BrowserWindow.getAllWindows().length }); return false; }
  const fullPlayback = await playback(full, "#video");
  const fullState = await read<{ title: string; last: string; labels: string[]; native: boolean }>(full, `(() => ({
    title: document.querySelector(".pc-title").textContent, last: document.querySelector(".pc-row").lastElementChild.id,
    labels: [...document.querySelectorAll(".pc button")].map(b => b.getAttribute("aria-label")), native: document.getElementById("video").controls }))()`);
  const display = screen.getDisplayMatching(window.getBounds()).bounds;
  // Shown once its first frame at the handed time is drawn: within the click's travel and the fade, never from the start.
  const handedOver = fullPlayback.time >= handed - 0.3 && fullPlayback.time <= handed + 1.5;
  record("Full screen covers the display with the recording's name, the same controls and the time handed over, still playing",
    fullState.title === item.title && fullState.last === "exit" && !fullState.native
      && fullState.labels.join() === [label("Pause"), label("Mute"), label("Exit full screen")].join()
      && !fullPlayback.paused && handedOver && JSON.stringify(full.getBounds()) === JSON.stringify(display),
    { ...fullState, handed, ...fullPlayback, bounds: full.getBounds(), display });
  move(full, display.width / 2, display.height - 40);
  await settle(250);
  await shot(full, "fullscreen-playing.png");
  move(full, display.width / 2, display.height / 2);
  await settle(VIDEO_TIMING.idleMs + 600);
  const fullRest = await resting(full);
  record("in full screen the controls and the pointer step aside at rest too", fullRest.idle && fullRest.opacity === "0" && fullRest.cursor === "none", fullRest);
  move(full, display.width / 2 + 10, display.height / 2 + 4);
  await settle(350);
  const fullWake = await resting(full);
  record("…and come back on a move", !fullWake.idle && fullWake.opacity === "1", fullWake);

  // F leaves; the player carries on from where full screen was, playing.
  const before = (await playback(full, "#video")).time;
  press(full, "f");
  const left = await until(() => full!.isDestroyed(), 3000);
  // The player seeks to where full screen was and plays on: not behind it, and not further than the fade allows.
  const resumed = await until(async () => { const p = await playback(window, ".player video"); return !p.paused && p.time >= before - 0.3 && p.time <= before + 1.5; }, 3000);
  record("F leaves full screen, and the player carries on from where it was, playing", left && resumed, { left, before, after: await playback(window, ".player video") });

  // A double-click on the picture plays full screen; Escape leaves.
  await settle(1100);
  const again = await box(window, ".player video");
  click(window, again!.x, again!.y, 1);
  window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 2, x: Math.round(again!.x), y: Math.round(again!.y) });
  window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 2, x: Math.round(again!.x), y: Math.round(again!.y) });
  let second: BrowserWindow | undefined;
  const reopened = await until(() => {
    second = BrowserWindow.getAllWindows().find(other => other !== window && !other.isDestroyed());
    return Boolean(second?.isVisible() && second.getOpacity() === 1);
  }, 6000);
  if (second) press(second, "Escape");
  const escaped = await until(() => !second || second.isDestroyed(), 3000);
  const stillOpen = await read<boolean>(window, `document.querySelector(".player")?.hasAttribute("data-open")`);
  record("a double-click on the picture plays full screen, and Escape leaves it with the player still open", reopened && escaped && stillOpen, { reopened, escaped, stillOpen });

  // The title bar strip: while the player is open it no longer drags the window, so a click above the player, on
  // the backdrop, closes it. The system's drag regions are not exercised by page input, so the strip's style is read too.
  if (process.platform === "darwin") {
    const strip = await read<string>(window, `getComputedStyle(document.querySelector(".titlebar")).getPropertyValue("-webkit-app-region") || getComputedStyle(document.querySelector(".titlebar")).getPropertyValue("app-region")`);
    const width = window.getContentBounds().width;
    click(window, width / 2, 12);
    const backdropClosed = await until(async () => !(await read<boolean>(window, `document.querySelector(".player")?.hasAttribute("data-open")`)));
    const dragsAgain = await read<string>(window, `getComputedStyle(document.querySelector(".titlebar")).getPropertyValue("-webkit-app-region") || getComputedStyle(document.querySelector(".titlebar")).getPropertyValue("app-region")`);
    record("while the player is open the title bar strip does not drag, a click there closes the player, and closed it drags again",
      strip === "no-drag" && backdropClosed && dragsAgain === "drag", { strip, backdropClosed, dragsAgain });
    click(window, card!.x, card!.y);
    await until(async () => await read<boolean>(window, `document.querySelector(".player")?.hasAttribute("data-open")`));
    await settle(400);
  }

  // Close: the dialog goes and releases the file.
  await settle(1100);
  const close = await box(window, "#player-close");
  click(window, close!.x, close!.y);
  const closed = await until(async () => !(await read<boolean>(window, `document.querySelector(".player")?.hasAttribute("data-open")`)));
  const released = (await playback(window, ".player video")).src === "";
  record("Close closes the player and releases the file", closed && released, { closed, released });

  // The stage: 16:9 and sized by the window alone, so a portrait recording opens in the same box, black beside it.
  // Measured once the dialog's opening animation has finished: its zoom-in scales the box, and the video's metadata can
  // arrive within those 100 ms (2026-10-06: openings measured 826–851 px wide before this wait, 860 px every time after it).
  const stageAtRest = (): Promise<boolean> => until(() => read<boolean>(window,
    `document.querySelector(".player").getAnimations().every(animation => animation.playState !== "running")`));
  const stage = async (): Promise<{ width: number; height: number; bars: number; source: string }> => (await stageAtRest(), read(window, `(() => {
    const d = document.querySelector(".player").getBoundingClientRect(), v = document.querySelector(".player video");
    const r = v.getBoundingClientRect(), scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    return { width: d.width, height: d.height, bars: r.width - v.videoWidth * scale, source: v.videoWidth + "×" + v.videoHeight }; })()`));
  click(window, card!.x, card!.y);
  await until(async () => (await read<number>(window, `document.querySelector(".player video").readyState`)) >= 1);
  const wide = await stage();
  await read(window, `document.getElementById("player-close").click()`);
  await settle(300);
  const portraitItem = view().library?.items[1];
  const portraitCard = portraitItem ? await box(window, `#clip-${portraitItem.id}-open`) : null;
  if (portraitCard) click(window, portraitCard.x, portraitCard.y);
  await until(async () => (await read<number>(window, `document.querySelector(".player")?.hasAttribute("data-open") ? document.querySelector(".player video").readyState : 0`)) >= 1);
  await read(window, `document.querySelector(".player video").pause()`);
  const tall = await stage();
  await shot(window, "player-portrait-light.png");
  await read(window, `document.getElementById("player-close").click()`);
  record("the player is a 16:9 stage sized by the window: a portrait recording opens in the same box, with black beside it",
    Math.abs(wide.width / wide.height - 16 / 9) < 0.02 && Math.abs(tall.width - wide.width) < 1 && Math.abs(tall.height - wide.height) < 1
      && tall.source === "720×1280" && tall.bars > wide.width * 0.5 && wide.bars < 1, { wide, tall });

  // The dark theme's player, paused, for the evidence.
  nativeTheme.themeSource = "dark";
  await settle(300);
  click(window, card!.x, card!.y);
  await until(async () => !(await playback(window, ".player video")).paused, 4000);
  await read(window, `document.querySelector(".player video").pause()`);
  await settle(300);
  await shot(window, "player-paused-dark.png");
  await read(window, `document.getElementById("player-close").click()`);
  nativeTheme.themeSource = "system";
  record("the pages ran without console errors", errors.length === 0, { errors });
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
