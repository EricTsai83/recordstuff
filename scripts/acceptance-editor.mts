/**
 * `pnpm acceptance:editor [-- --secondary] [--no-microphone] [--out <dir>]` (plan 087's follow-up, 2026-10-25): an
 * editable recording edited and exported on the packaged app with real input, macOS only; never shipped. Build and quit
 * the bundle first (`pnpm start:app`, then Quit). The runner saves Editable recordings off, the camera and the
 * microphone on (`--no-microphone`: off) and no countdown over the user's settings, launches the bundle, opens the
 * moving test material full screen on the recorded display (the primary, or with `--secondary` the second, so the
 * primary stays free) and records 12 s, started by the tray's Start editable recording (2026-10-25: one recording
 * editable with the setting off) and stopped by the registered shortcut. The camera is the user's own choice and must see something:
 * one that delivers no frame blocks the round. Then, in the app's own window, opened by the tray's Show last recording:
 *
 * - the card's More actions → Edit… opens the edit view, which must draw the camera's bubble;
 * - **Drag.** The bubble is dragged with CoreGraphics pointer events to the bottom-left; the edit record must save it
 *   there (`judgePlace`).
 * - **Resize.** The bubble is clicked, which selects it, and − pressed 5 times (2026-10-25: the size slider went, its
 *   corner handles and + / − resize it); the record must save the bubble smaller by 5 points with its shape kept
 *   (`judgeResize`).
 * - **Hide and Undo.** Hide camera view, in the toolbar's ⋯ More options (2026-10-26; Hide the camera throughout, and Show camera before), is switched on (the record says hidden and the bubble leaves the view), then Undo is
 *   pressed (shown again, the resize kept).
 * - **Volume.** In the toolbar's Overall volume panel (2026-10-26), the microphone's slider is clicked and moved to 50% by the arrow keys; the record must say 50 and the
 *   slider keep the keyboard's focus throughout (a save between presses once took it).
 * - **Volume** (2026-10-26). Shift+→ to 11 s, S, Shift+← to 9 s, S (the part from 9 to 11 s selected), V and each
 *   input's Mute in the Volume popup: the record must hold each input at 0% from 9 to 11 s, the export be asked for
 *   those stretches and be silent there (at most −50 dB) and heard again before and after it (20 dB louder).
 * - **Stretch** (2026-10-26). A click on the camera's lane, then Shift+→ to 4 s, S and C, Shift+→ to 7 s, S and C: the
 *   record must hold the camera hidden from 4 to 7 s alone (version 3); paused at 5 s the bubble must be gone from the
 *   view and back at 2 s. The export must be asked to hide it over that one stretch, and a frame at 5.5 s must be the
 *   screen's picture alone (`judgeScreenOnly`), the composite judged at a frame before the stretch.
 * - **Export.** Export is pressed; main must log the render with the camera shown and the volumes the scene gives, and
 *   publish `<name> (edited).mp4` (「（已剪輯）」 in Traditional Chinese), read from its log line. Its middle frame must hold the camera track's own picture where the scene put the
 *   bubble and the screen track's everywhere else (`judgeComposite`); a camera too flat to recognise (a covered lens)
 *   leaves that check unjudged, which blocks the round rather than passing it. It must have one picture and one sound
 *   track and last as long as the recording.
 *
 * - **Timeline** (2026-10-25, held where a person holds it, which a Computer Use pointer could not): a range dragged
 *   from a fifth in past the timeline's start and let go outside the window must reach the very start, and Delete must
 *   leave the export about a fifth shorter (2026-10-26: the start and end are cut as any range is, the trim handles
 *   gone); a range held across the middle must show its span with the preview at its moving end, and Delete remove it; with Skimming switched on in More options (off by default), the pointer over the timeline must move the preview there and, moved
 *   away, back; the shortcuts button must list the editing shortcuts on a click; and ⌘Z must take every change back.
 * - **The next recording**, by the shortcut, must be plain again: the setting stayed off.
 *
 * Screenshots of the window after each step go beside the report for a person to judge what the preview draws; what
 * the preview sounds like is not judged. Recordings and the export stay in the output folder, the edit in userData.
 * The settings file is restored byte for byte. Exit 0 pass, 1 fail or incomplete cleanup, 2 blocked (not macOS, no
 * bundle, RecordStuff running, no FFmpeg or Chrome, no second display with `--secondary`, a locked screen, a camera
 * without frames or too flat to judge), 130/143 interrupted.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { APP_LOG_PATH, APP_SETTINGS_PATH, runnerArgs, writeAppSettings } from "./lib/runner/runner-env.mts";
import { INTERRUPT_EXIT, electronPattern, escapeRegExp, pgrepPids, recordStuffPids, signalPids, command } from "./lib/runner/processes.mts";
import { confirmedIdle, waitForLog, waitForRecord, type TerminalRecord } from "./lib/acceptance/acceptance-runtime.mts";
import { acceleratorToKeystroke, createMaterialProfile, currentRunId, keystrokeScript, materialOpenArgs, registeredAccelerator, removeMaterialProfile } from "./lib/acceptance/acceptance.mts";
import { DESKTOP_BLOCKED_EXIT, DesktopBlockedError, beginDesktopRound } from "./lib/runner/desktop-session.mts";
import { LogReader } from "./lib/runner/log-reader.mts";
import { roundExit } from "./lib/runner/round-exit.mts";
import { AccessibilityBlockedError, FLAG, KEY, captureRect, centre, osascriptAx, type Frame, type WindowElement } from "./lib/runner/native-ax.mts";
import { nativeDrag } from "./lib/runner/native-drag.mts";
import { developmentAppPath } from "./lib/runner/verification-timing.mts";
import { TrayDriver } from "./lib/acceptance/tray-driver.mts";
import { frameRgb, hasTool, probe, requireMediaTimeout } from "./lib/verification/media-tools.mts";
import { clockSeconds, dragFor, expectedPreviewTracks, judgeComposite, judgePlace, judgeResize, judgeScreenOnly, readEditableDescription, recordScene, sceneLayout } from "./lib/acceptance/editor-acceptance.mts";
import type { Verdict } from "./lib/acceptance/capture-settings.mts";
import { AUDIO_VOLUME_STEP, volumeDb } from "../src/shared/audio-volume.ts";
import type { EditableDescription, EditScene } from "../src/shared/editable.ts";
import { isLanguage, translate, type Language } from "../src/shared/i18n.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = developmentAppPath(REPO_ROOT);
const EXECUTABLE = path.join(BUNDLE, "Contents/MacOS/RecordStuff");
const BUNDLE_ID = (): string => spawnSync("plutil", ["-extract", "CFBundleIdentifier", "raw", path.join(BUNDLE, "Contents/Info.plist")], { encoding: "utf8" }).stdout?.trim() || "com.ericts.record";
const ELECTRON_APP = path.join(REPO_ROOT, "node_modules/electron/dist/Electron.app");
const ELECTRON_APP_REAL = fs.existsSync(ELECTRON_APP) ? fs.realpathSync(ELECTRON_APP) : ELECTRON_APP;
const MATERIAL = path.join(REPO_ROOT, "scripts/test-material.html");
const EDITS = path.join(path.dirname(APP_SETTINGS_PATH), "edits");
const WINDOW = "RecordStuff";
const SECONDS = 12;
/** Where the drag puts the bubble: near the bottom-left, far from where a recording starts it. */
const AIM = { x: 0.1, y: 0.85 };
const SIZE_STEPS = 5;
const MICROPHONE = 50;
/** Where the camera is hidden in the Stretch step, in seconds of the 12-second recording. */
const HIDE_FROM = 4;
const HIDE_TO = 7;
/**
 * Where both inputs are muted in the Volume step, in seconds: a stretch in the middle, so the export must fall silent
 * there and be heard again after it, not only up to it (2026-10-26, the maintainer's question).
 */
const MUTE_FROM = 9;
const MUTE_TO = 11;
/** How long a saved change may take to reach the edit record. */
const SAVE_MS = 5000;

const usage = "usage: pnpm acceptance:editor [-- --secondary] [--no-microphone] [--out <dir>]";
let secondary = false, microphone = true, outDir: string | undefined;
const argv = runnerArgs();
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]!;
  if (arg === "--secondary") secondary = true;
  else if (arg === "--no-microphone") microphone = false;
  else if (arg === "--out" && argv[i + 1] && !argv[i + 1]!.startsWith("--")) outDir = argv[++i];
  else { console.error(usage); process.exit(2); }
}

const controller = new AbortController();
let interruptedBy: keyof typeof INTERRUPT_EXIT | undefined;
for (const name of ["SIGINT", "SIGTERM"] as const) {
  process.on(name, () => { interruptedBy ??= name; controller.abort(new Error(`interrupted by ${name}`)); });
}
const sleep = (ms: number): Promise<void> => delay(ms, undefined, { signal: controller.signal });
const log = new LogReader(APP_LOG_PATH);
const events: string[] = [];
const note = (text: string): void => { events.push(`${new Date().toISOString()} ${text}`); console.log(text); };
class Failure extends Error {}
const fail = (message: string): never => { throw new Failure(message); };
class Blocked extends Error {}
const blocked = (message: string): never => { throw new Blocked(message); };
const running = (): number | undefined => recordStuffPids()[0];

interface Check extends Verdict { judged: boolean }
/** A display as the runner places things on it: its global top-left and size in points, and the app's id for it. */
interface Display { id: string; label: string; frame: Frame }

/** The displays, primary first, in the global coordinates CoreGraphics events and `screencapture` use. */
async function displays(): Promise<Display[]> {
  const out = await command("osascript", ["-l", "JavaScript", "-e", `ObjC.import("AppKit");
    const screens = $.NSScreen.screens, main = screens.objectAtIndex(0).frame, list = [];
    for (let i = 0; i < screens.count; i++) {
      const s = screens.objectAtIndex(i), f = s.frame;
      list.push({ id: String(ObjC.unwrap(s.deviceDescription.objectForKey("NSScreenNumber"))), label: ObjC.unwrap(s.localizedName),
        frame: { x: f.origin.x, y: main.size.height - (f.origin.y + f.size.height), width: f.size.width, height: f.size.height } });
    }
    JSON.stringify(list)`], AbortSignal.timeout(10_000));
  return JSON.parse(out) as Display[];
}

async function main(): Promise<number> {
  if (process.platform !== "darwin" || !fs.existsSync(EXECUTABLE)) {
    console.error(process.platform !== "darwin" ? "BLOCKED: macOS only" : `BLOCKED: no bundle at ${BUNDLE}: build it with \`pnpm start:app\`, then quit it`);
    return 2;
  }
  if (running() !== undefined || pgrepPids(electronPattern(ELECTRON_APP_REAL, "bundle")).length > 0) {
    console.error("BLOCKED: RecordStuff or this project's Electron.app is running: quit it first; this runner launches the bundle itself");
    return 2;
  }
  requireMediaTimeout();
  if (!hasTool("ffmpeg") || !hasTool("ffprobe")) { console.error("BLOCKED: ffmpeg and ffprobe are needed (brew install ffmpeg)"); return 2; }
  if (spawnSync("open", ["-Ra", "Google Chrome"]).status !== 0) { console.error("BLOCKED: Google Chrome is needed for the material"); return 2; }
  if (!fs.existsSync(APP_SETTINGS_PATH)) { console.error(`BLOCKED: no settings at ${APP_SETTINGS_PATH}: launch RecordStuff once first`); return 2; }
  const screens = await displays();
  const target = secondary ? screens[1] : screens[0];
  if (!target) { console.error("BLOCKED: --secondary needs a second display"); return 2; }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = outDir ?? path.join(REPO_ROOT, "docs/verification/measurements", `${stamp}-editor-acceptance`);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) { console.error("output directory is not empty"); return 2; }
  fs.mkdirSync(dir, { recursive: true });
  const originalText = fs.readFileSync(APP_SETTINGS_PATH, "utf8");
  const original = JSON.parse(originalText) as Record<string, unknown>;
  fs.writeFileSync(path.join(dir, "settings.before.json"), originalText);
  const language: Language = isLanguage(original["language"]) ? original["language"] : "en";
  const desktop = await beginDesktopRound().catch((cause: unknown) => {
    if (cause instanceof DesktopBlockedError) { console.error(`BLOCKED: ${cause.message}`); process.exit(DESKTOP_BLOCKED_EXIT); }
    throw cause;
  });
  const checks: Check[] = [];
  const cleanup: string[] = [];
  const files: string[] = [];
  const shots: string[] = [];
  let runError: unknown;
  let launchIssued = false;
  let appPid = 0;
  let launcher: ChildProcess | undefined;
  const profile = createMaterialProfile("editor");
  const materialPids = (): number[] => pgrepPids(escapeRegExp(profile));
  const ax = () => osascriptAx(controller.signal, 30_000);
  const check = (verdict: Verdict, judged = true): void => {
    checks.push({ ...verdict, judged });
    note(`${judged ? (verdict.pass ? "PASS" : "FAIL") : "UNJUDGED"} ${verdict.check}: ${verdict.actual}`);
  };

  const quitApp = async (): Promise<void> => {
    if (launchIssued && running() === undefined) for (const end = Date.now() + 10_000; running() === undefined && Date.now() < end;) await delay(250);
    if (running() === undefined) return;
    await command("osascript", ["-e", `tell application ${JSON.stringify(BUNDLE)} to quit`], AbortSignal.timeout(15_000));
    for (const end = Date.now() + 30_000; running() !== undefined;) {
      if (Date.now() > end) fail("RecordStuff did not exit within 30 s of Quit");
      await delay(200);
    }
  };
  /** The window's web elements, read with Chromium's accessibility tree on (left on for the round: nothing here is timed). */
  const elements = async (): Promise<WindowElement[]> => (await ax().elements(appPid, WINDOW)).elements;
  /** The first element `pick` chooses, waited for up to `ms`. */
  const find = async (what: string, pick: (element: WindowElement) => boolean, ms = 10_000): Promise<WindowElement> => {
    let problem = "";
    for (const end = Date.now() + ms; ;) {
      // A window still opening or moving reads as none for a moment.
      const read = await elements().then((list) => list, (error: unknown) => { if (error instanceof AccessibilityBlockedError) throw error; problem = String(error); return []; });
      const found = read.find(pick);
      if (found) return found;
      if (Date.now() > end) return fail(`no ${what} in the window${problem ? ` (${problem})` : ""}`);
      await sleep(300);
    }
  };
  const click = async (element: WindowElement): Promise<void> => {
    const point = centre(element.frame);
    await ax().mouse("left", point.x, point.y);
    await sleep(400);
  };
  const shot = async (name: string): Promise<void> => {
    const window = (await ax().windows(appPid)).windows.find((w) => w.title === WINDOW)?.frame;
    if (!window) return;
    await command("screencapture", ["-x", "-R", captureRect(window), path.join(dir, name)], AbortSignal.timeout(10_000));
    shots.push(name);
  };
  const press = async (code: number, times: number): Promise<void> => {
    for (let i = 0; i < times; i++) { await ax().key(code); await sleep(250); }
  };

  /** Closes the material's browser, once: the edit needs no material, and its full-screen Space would hide the window. */
  let materialClosed = false;
  const closeMaterial = async (): Promise<void> => {
    if (materialClosed) return;
    materialClosed = true;
    const opening = launcher;
    if (opening && opening.exitCode === null && opening.signalCode === null) await Promise.race([new Promise((resolve) => opening.once("exit", resolve)), delay(10_000)]);
    for (let attempt = 0; attempt < 40 && materialPids().length > 0; attempt += 1) { signalPids(materialPids(), "SIGTERM"); await delay(250); }
    if (materialPids().length > 0) cleanup.push(`could not close the material browser (private profile ${profile})`);
    else {
      const problem = await removeMaterialProfile(profile);
      if (problem) cleanup.push(`could not remove the material profile: ${problem}`);
    }
  };

  try {
    // The case's settings over the user's: restored byte for byte at the end.
    // Editable recordings off: the tray's Start editable recording makes the one recorded here editable (2026-10-25).
    writeAppSettings({ ...original, editableRecording: false, camera: true, microphone, countdown: 0,
      display: secondary ? { kind: "display", id: target.id, label: target.label } : { kind: "primary" } });
    note(`settings: Editable recordings off (the tray's Start editable recording records), camera, microphone ${microphone ? "on" : "off"}, no countdown, recording ${secondary ? `${target.label} (${target.id})` : "the primary display"}`);
    launcher = spawn("open", materialOpenArgs(MATERIAL, profile, target.frame), { stdio: "ignore" });
    await sleep(5000);
    if (!materialPids().length) blocked("the test material did not open in Google Chrome");
    note(`test material open full screen on ${secondary ? target.label : "the primary display"}`);

    // Launch, idle with the shortcut registered.
    const from = log.end();
    launchIssued = true;
    await command("open", ["-a", BUNDLE], AbortSignal.timeout(15_000));
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
    const start = await waitForLog(log, from, /\] start: /, "`start:`", signal, 60_000);
    await waitForLog(log, start.at, /\] ready;/, "`ready;`", signal, 60_000);
    let lines: string[] = [];
    for (;;) {
      lines = [start.line, ...log.since(start.at).lines.map((line) => line.text)];
      if (confirmedIdle(lines) && registeredAccelerator(lines)) break;
      if (signal.aborted && !controller.signal.aborted) fail("RecordStuff did not reach idle with its shortcut registered within 60 s");
      await sleep(200);
    }
    launchIssued = false;
    appPid = running() ?? fail("RecordStuff did not stay running after launch");
    const run = currentRunId(lines) ?? fail("the start line has no run id");
    const script = keystrokeScript(acceleratorToKeystroke(registeredAccelerator(lines)!) ?? fail("cannot type the recording shortcut"));
    note(`RecordStuff pid ${appPid}, run ${run}`);

    // Record over the material, the pointer in the middle of the recorded display.
    await command("osascript", ["-l", "JavaScript", "-e", `const se = Application("System Events");
      for (const pid of ${JSON.stringify(materialPids())}) { const p = se.processes.whose({ unixId: pid }); if (p.length) { p[0].frontmost = true; break; } }`], AbortSignal.timeout(10_000));
    await sleep(800);
    await ax().move(Math.round(target.frame.x + target.frame.width / 2), Math.round(target.frame.y + target.frame.height / 2));
    await sleep(800);
    // Started by the tray's Start editable recording, with the setting off.
    const tray = new TrayDriver(ax(), appPid, controller.signal, undefined, BUNDLE_ID());
    const pressFrom = log.end();
    await tray.open();
    await tray.select(translate("Start editable recording", language));
    await waitForLog(log, pressFrom, /state → recording/, "`state → recording`", controller.signal);
    const capture = await waitForRecord(log, pressFrom, (r): r is Extract<typeof r, { kind: "capture" }> => r.kind === "capture" && r.run === run, "the capture record", controller.signal);
    await sleep(SECONDS * 1000);
    await command("osascript", ["-e", script], AbortSignal.timeout(10_000));
    const terminal = await waitForRecord(log, capture.next, (r): r is TerminalRecord => (r.kind === "saved" || r.kind === "failed") && r.run === run && r.session === capture.record.session,
      "the save", controller.signal, 60_000);
    if (terminal.record.kind === "failed") fail(`the recording failed: ${terminal.record.code} ${terminal.record.detail}`);
    const source = terminal.record.kind === "saved" ? terminal.record.path : fail("no saved file");
    files.push(source);
    const session = log.since(pressFrom).lines.map((line) => line.text);
    const cameraStop = session.map((line) => /camera: at the stop (.+?): running \w+, (\d+) frame\(s\) delivered/.exec(line)).find(Boolean);
    if (!cameraStop) fail("the engine logged no camera in the recording (is Camera access granted?)");
    if (Number(cameraStop![2]) === 0) blocked(`the camera ${cameraStop![1]} delivered no frame; connect or wake it and run again`);
    const description: EditableDescription = readEditableDescription(fs.readFileSync(source)) ?? fail(`${source} carries no editable description`);
    const sourceInfo = probe(source).info;
    const videos = sourceInfo.streams.filter((s) => s.codec_type === "video");
    const screen = videos[0], cameraTrack = videos[1];
    const sourceDuration = Number(sourceInfo.format.duration);
    // With the microphone too (plan 098): both inputs mixed on the first sound track, then each on its own.
    const soundTracks = sourceInfo.streams.filter((s) => s.codec_type === "audio").length;
    check({ check: "Recording: an editable file from the tray's Start editable recording, the setting off",
      expected: `the screen and the camera apart, ${microphone ? "3 sound tracks (the inputs mixed, then each), a version-2 description" : "1 sound track"} with a camera`,
      actual: `${videos.length} picture and ${soundTracks} sound track(s), sounds ${description.sounds.join("/")}${description.mix ? " after their mix" : ""}, camera ${description.camera ? "described" : "none"}`,
      pass: videos.length === 2 && description.camera !== null && description.sounds.length === (microphone ? 2 : 1)
        && soundTracks === (microphone ? 3 : 1) && Boolean(description.mix) === microphone });
    if (!screen?.width || !screen.height || !cameraTrack?.width || !cameraTrack.height || !description.camera) fail("the recording is not one this round can edit");
    const shape = { rounding: description.camera!.rounding, mirror: description.camera!.mirror };
    note(`recorded ${source} (${screen!.width}×${screen!.height}, ${sourceDuration.toFixed(1)} s; camera ${cameraStop![1]}, ${cameraStop![2]} frame(s))`);

    await closeMaterial();
    note("test material closed: the edit needs none");
    // The window on Recordings with the newest take, then its card's More actions → Edit….
    await tray.open();
    await tray.select(translate("Show last recording", language));
    for (const end = Date.now() + 10_000; !(await ax().windows(appPid)).windows.some((w) => w.title === WINDOW);) {
      if (Date.now() > end) fail("Show last recording opened no window");
      await sleep(300);
    }
    await sleep(1500);
    if (secondary) {
      await command("osascript", ["-l", "JavaScript", "-e", `const p = Application("System Events").processes.whose({ unixId: ${appPid} })[0];
        for (const w of p.windows()) if (w.name() === ${JSON.stringify(WINDOW)}) { w.position = [${Math.round(target.frame.x + 40)}, ${Math.round(target.frame.y + 80)}]; break; }`], AbortSignal.timeout(10_000));
      await sleep(1000);
    }
    await ax().enableWebAccessibility(appPid);
    const title = path.basename(source).replace(/\.[^.]+$/, "");
    // The card's menu, tried again if its Edit… does not show (a card just listed can take the first press while it arrives).
    const isEdit = (e: WindowElement): boolean => e.role === "AXMenuItem" && e.title === translate("Edit…", language);
    let editItem: WindowElement | undefined;
    for (let attempt = 1; attempt <= 3 && !editItem; attempt += 1) {
      await click(await find("card menu", (e) => e.title === translate("More actions for {title}", language, { title })));
      editItem = await find("Edit… item", isEdit, 4000).catch(() => undefined);
      if (!editItem) {
        await shot(`0-no-edit-item-${attempt}.png`);
        note(`attempt ${attempt}: the card's menu showed no Edit…`);
        await ax().key(KEY.escape);
        await sleep(800);
      }
    }
    await click(editItem ?? fail("no Edit… item in the card's menu after 3 tries"));
    const marker = "\u0001";
    const bubblePrefix = translate("Camera: {x}% across, {y}% down, {size}% in size. Drag it or use the arrow keys to move it; drag a corner, or press + or −, to resize it.", language, { x: marker, y: marker, size: marker }).split(marker)[0]!;
    const isBubble = (e: WindowElement): boolean => e.role === "AXButton" && e.title.startsWith(bubblePrefix);
    const bubble = await find("camera bubble", isBubble, 20_000);
    // The preview's camera track is copied when the view opens: a moment for it to load and draw.
    await sleep(3000);
    await shot("1-opened.png");
    // Its tracks copied for the preview: with a mix, both inputs' own sounds (plan 098).
    const copied = log.since(pressFrom).lines.map((line) => /editing: the preview's (\w+) of .* is ready/.exec(line.text)?.[1]).filter((track): track is string => track !== undefined);
    const wanted = expectedPreviewTracks(description);
    check({ check: "Edit view: the preview's tracks copied", expected: wanted.join(", "), actual: copied.join(", ") || "none",
      pass: wanted.every((track) => copied.includes(track)) && copied.length === wanted.length });
    note(`edit view open; the bubble drawn at ${bubble.frame.x},${bubble.frame.y} ${bubble.frame.width}×${bubble.frame.height}`);

    const recordFile = path.join(EDITS, `${createHash("sha256").update(path.resolve(source)).digest("hex").slice(0, 32)}.json`);
    const readScene = (): { revision: number; scene: EditScene } | undefined => fs.existsSync(recordFile) ? recordScene(fs.readFileSync(recordFile, "utf8")) : undefined;
    /** The record's scene once `ready` holds for a revision past `after`, or the last read when it does not within the bound. */
    const saved = async (after: number, ready: (scene: EditScene) => boolean): Promise<EditScene | undefined> => {
      let last: EditScene | undefined;
      for (const end = Date.now() + SAVE_MS; ;) {
        const read = readScene();
        if (read && read.revision > after) { last = read.scene; if (ready(read.scene)) return read.scene; }
        if (Date.now() > end) return last;
        await sleep(200);
      }
    };
    const revision = (): number => readScene()?.revision ?? -1;

    /**
     * The timeline with real input, held where a person holds it (2026-10-25: a Computer Use pointer could neither hold
     * a drag nor move without pressing, so these ran only in the UI tests): the start cut by a range dragged past it and
     * let go outside the window, a range's preview following its end,
     * Skimming's hover and its way back, the shortcuts opened by a click, and every change undone.
     */
    const timeline = async (): Promise<void> => {
      const M = "\u0001";
      const texts = async (): Promise<string[]> => (await ax().texts(appPid, WINDOW)).texts.map((t) => t.text);
      /** The first text starting as `text` does before its first placeholder, given as \u0001. */
      const textStarting = async (text: string): Promise<string | undefined> => {
        const prefix = text.split(M)[0]!;
        return (await texts()).find((t) => t.startsWith(prefix));
      };
      const lengthText = translate("Video length {length}", language, { length: M });
      const playheadText = translate("Playhead {time}", language, { time: M });
      const removed = (): number => (fs.existsSync(recordFile) ? (JSON.parse(fs.readFileSync(recordFile, "utf8")) as { removed?: unknown[] }).removed?.length : 0) ?? 0;
      // The timeline's span, from every part's bounds together (the camera's and the volumes' checks before it split
      // the recording, Codex's review). A part is a pressed-or-not button, which Chromium gives macOS as a toggle.
      const partMarker = "\u0004";
      const suffixOf = (key: "{from} to {to}, kept" | "{from} to {to}, removed"): string =>
        translate(key, language, { from: partMarker, to: partMarker }).split(partMarker).at(-1)!;
      const keptSuffix = suffixOf("{from} to {to}, kept"), removedSuffix = suffixOf("{from} to {to}, removed");
      const isPart = (e: WindowElement): boolean => (e.role === "AXButton" || e.role === "AXCheckBox") && (e.title.endsWith(keptSuffix) || e.title.endsWith(removedSuffix));
      const part = async (): Promise<WindowElement> => find("a kept part", (e) => isPart(e) && e.title.endsWith(keptSuffix));
      const window = (await ax().windows(appPid)).windows.find((w) => w.title === WINDOW)?.frame ?? fail("no window frame");
      const parts = (await elements()).filter(isPart);
      if (parts.length === 0) fail("no timeline parts");
      const whole = {
        x: Math.min(...parts.map((e) => e.frame.x)), y: parts[0]!.frame.y,
        width: Math.max(...parts.map((e) => e.frame.x + e.frame.width)) - Math.min(...parts.map((e) => e.frame.x)), height: parts[0]!.frame.height,
      };
      const left = whole.x, right = whole.x + whole.width, y = Math.round(whole.y + whole.height / 2);
      const top = whole.y, span = right - left;
      // The volume's stretch is still selected, and a selection's actions cover the times in a narrow view (2026-10-26):
      // Deselect lets it go first.
      const deselect = await find("Deselect button", (e) => e.role === "AXButton" && e.title === translate("Deselect", language), 1000).catch(() => undefined);
      if (deselect) { await click(deselect); await sleep(400); }
      const full = await textStarting(lengthText) ?? fail("no video length shown");
      const fullSeconds = clockSeconds(full) ?? fail(`unreadable video length: ${full}`);
      const hold = async (from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> => {
        await ax().pointer("down", from.x, from.y);
        for (let i = 1; i <= 8; i++) { await ax().pointer("drag", Math.round(from.x + (to.x - from.x) * i / 8), Math.round(from.y + (to.y - from.y) * i / 8)); await sleep(30); }
        await sleep(400);
      };

      // The start cut as any range is (2026-10-26: no trim handles): dragged from a fifth in past the timeline's start
      // and let go outside the window, the range reaches the very start; Delete leaves the export a fifth shorter.
      const fifth = { x: Math.round(left + span * 0.2), y }, outside = { x: Math.round(window.x - 120), y };
      try { await hold(fifth, outside); } finally { await ax().pointer("up", outside.x, outside.y); }
      await sleep(400);
      await ax().key(KEY.delete);
      await sleep(1500);
      const head = (fs.existsSync(recordFile) ? (JSON.parse(fs.readFileSync(recordFile, "utf8")) as { removed?: Array<[number, number]> }).removed?.[0] : undefined);
      const cut = await textStarting(lengthText);
      await shot("8-start-cut.png");
      check({ check: "Start: a range dragged past it, then Delete", expected: `the range from the very start removed, the export about ${(fullSeconds * 0.8).toFixed(1)} s`,
        actual: `removed ${JSON.stringify(head ?? null)}, "${cut ?? "none"}"`,
        pass: head?.[0] === 0 && Math.abs((clockSeconds(cut ?? "") ?? 0) - fullSeconds * 0.8) <= 0.6 });

      // A range held across the middle: the preview follows the end being dragged; Delete removes it.
      const before = removed();
      const from = { x: Math.round(left + span * 0.4), y }, to = { x: Math.round(left + span * 0.6), y };
      let heldSelection: string | undefined;
      let heldAt = -1;
      try {
        await hold(from, to);
        const selection = await textStarting(translate("Selection {from}–{to} ({length})", language, { from: M, to: M, length: M }));
        heldSelection = selection;
        // While held, the preview is at the moving end.
        heldAt = clockSeconds(await textStarting(playheadText) ?? "") ?? -1;
      } finally { await ax().pointer("up", to.x, to.y); }
      await sleep(400);
      await ax().key(KEY.delete);
      await sleep(1500);
      check({ check: "Range: Delete removes it", expected: "one more removed range", actual: `${before} → ${removed()}`, pass: removed() === before + 1 });
      // Let go, the playhead went to the range's start (2026-10-27), where the removal leaves it. The player's own clock
      // went with its controls (2026-10-26), so the view's playhead readout says it.
      const marker = "\u0003";
      const playheadPrefix = translate("Playhead {time}", language, { time: marker }).split(marker)[0]!;
      const readout = (await texts()).find((t) => t.startsWith(playheadPrefix));
      const shown = clockSeconds(readout ?? "") ?? -1;
      check({ check: "Range: held across the middle", expected: `a selection, the preview at its moving end, about ${(fullSeconds * 0.6).toFixed(1)} s, then the playhead at its start, about ${(fullSeconds * 0.4).toFixed(1)} s`,
        actual: `"${heldSelection ?? "none"}" at ${heldAt.toFixed(2)} s, then "${readout ?? "no playhead readout"}"`,
        pass: heldSelection !== undefined && Math.abs(heldAt - fullSeconds * 0.6) <= 1.2 && Math.abs(shown - fullSeconds * 0.4) <= 1.2 });

      // Skimming, off by default (2026-10-26), switched on in More options: the preview shows what is under the pointer, and
      // goes back when it leaves. The shortcuts' button reaches AX as a pop-up button, found by name.
      await click(await find("More options button", (e) => e.title === translate("More options", language)));
      await sleep(400);
      await click(await find("Skimming switch", (e) => e.role === "AXCheckBox" && e.title === translate("Skimming", language)));
      await sleep(300);
      await ax().key(KEY.escape);
      await sleep(400);
      const playhead = clockSeconds(await textStarting(playheadText) ?? "") ?? -1;
      const over = Math.round(left + span * 0.85);
      await ax().move(over - 20, y);
      await sleep(200);
      await ax().move(over, y);
      await sleep(800);
      const skimmed = clockSeconds(await textStarting(playheadText) ?? "") ?? -1;
      await ax().move(over, Math.round(top - 160));
      await sleep(800);
      const back = clockSeconds(await textStarting(playheadText) ?? "") ?? -1;
      check({ check: "Skimming: the pointer over the timeline, then away", expected: `the preview at about ${(fullSeconds * 0.85).toFixed(1)} s, then back at ${playhead.toFixed(2)} s`,
        actual: `${skimmed.toFixed(2)} s, then ${back.toFixed(2)} s`, pass: Math.abs(skimmed - fullSeconds * 0.85) <= 0.6 && Math.abs(back - playhead) <= 0.05 });

      // The shortcuts, opened by a click on their button.
      const keysButton = await find("shortcuts button", (e) => e.title.startsWith(translate("Keyboard shortcuts", language)));
      await click(keysButton);
      await sleep(600);
      const listed = (await texts()).includes(translate("Editing shortcuts", language));
      await shot("10-shortcuts.png");
      check({ check: "Shortcuts: a click on their button", expected: "the editing shortcuts listed", actual: listed ? "listed" : "nothing opened", pass: listed });
      await click(keysButton);

      // Every change undone from the keyboard, the focus kept in the view throughout.
      // A kept part, on screen however the window lies across displays, takes the focus into the timeline.
      await click(await part());
      for (let i = 0; i < 12 && removed() > 0; i++) { await ax().key(KEY.z, FLAG.command); await sleep(700); }
      check({ check: "Undo: every timeline change taken back by ⌘Z", expected: "nothing removed", actual: `${removed()} removed`, pass: removed() === 0 });
      await shot("11-undone.png");
    };

    // Drag.
    const width = screen!.width!, height = screen!.height!;
    const startScene = { x: description.camera!.x, y: description.camera!.y, width: description.camera!.width, height: description.camera!.height, shown: true };
    const { start: grip, end: drop } = dragFor(bubble.frame, sceneLayout(startScene, shape), startScene, AIM, width, height);
    let before = revision();
    await nativeDrag(grip, drop, controller.signal);
    let scene = await saved(before, (s) => Boolean(s.camera && Math.abs(s.camera.x - AIM.x) <= 0.03 && Math.abs(s.camera.y - AIM.y) <= 0.03));
    check(judgePlace(scene?.camera, AIM));
    await shot("2-dragged.png");
    const moved = scene?.camera ?? fail("the drag saved no camera");

    // Resize: the bubble clicked, which selects it and saves nothing, then − pressed.
    await click(await find("camera bubble", isBubble));
    await sleep(600);
    const clicked = readScene()?.scene.camera ?? moved;
    before = revision();
    await press(KEY.minus, SIZE_STEPS);
    const resizedLonger = Math.round(Math.max(clicked.width, clicked.height) * 100) - SIZE_STEPS;
    scene = await saved(before, (s) => Boolean(s.camera && Math.round(Math.max(s.camera.width, s.camera.height) * 100) <= resizedLonger));
    check(judgeResize(clicked, scene?.camera, SIZE_STEPS));
    await shot("3-resized.png");
    const resized = scene?.camera ?? fail("the resize saved no camera");

    // Hide, then Undo; the switch is in the popup the toolbar's ⋯ (More options) opens (2026-10-26).
    await click(await find("More options button", (e) => e.title === translate("More options", language)));
    await sleep(400);
    before = revision();
    await click(await find("Hide camera view switch", (e) => e.role === "AXCheckBox" && e.title === translate("Hide camera view", language)));
    scene = await saved(before, (s) => s.camera?.shown === false);
    await sleep(500);
    const bubbleGone = !(await elements()).some(isBubble);
    check({ check: "Hide: Hide the camera throughout switched on", expected: "the record says hidden and the bubble leaves the view",
      actual: `record ${scene?.camera?.shown === false ? "hidden" : `shown=${String(scene?.camera?.shown)}`}, bubble ${bubbleGone ? "gone" : "still drawn"}`, pass: scene?.camera?.shown === false && bubbleGone });
    await shot("4-hidden.png");
    before = revision();
    await click(await find("Undo button", (e) => e.role === "AXButton" && e.title === translate("Undo", language)));
    scene = await saved(before, (s) => s.camera?.shown === true);
    const back = await find("camera bubble", isBubble, 3000).then(() => true, () => false);
    const sameSize = scene?.camera?.width === resized.width && scene.camera.height === resized.height;
    check({ check: "Undo: the hide taken back", expected: "shown again in the record and the view, the resize kept",
      actual: `record shown=${String(scene?.camera?.shown)}, ${sameSize ? "size kept" : "size changed"}, bubble ${back ? "drawn" : "missing"}`, pass: scene?.camera?.shown === true && sameSize && back });
    await shot("5-undone.png");

    // The microphone to 50%, by the keyboard after one click on its thumb, in the volume its toolbar button opens.
    if (microphone) {
      // The overall volumes are a panel of their own (2026-10-26): Escape closes More options, then their button opens it.
      if (!(await elements()).some((e) => e.role === "AXSlider" && e.title === translate("Microphone", language))) {
        await ax().key(KEY.escape);
        await sleep(300);
        await click(await find("Overall volume button", (e) => e.title === translate("Overall volume", language)));
        await sleep(400);
      }
      const slider = await find("Microphone slider", (e) => e.role === "AXSlider" && e.title === translate("Microphone", language));
      await click(slider);
      await sleep(600);
      // A click may move the thumb a step; the keys go from where it saved.
      const startVolume = readScene()?.scene.volumes.microphone ?? 100;
      const presses = Math.abs(startVolume - MICROPHONE) / AUDIO_VOLUME_STEP;
      before = revision();
      await press(startVolume > MICROPHONE ? KEY.left : KEY.right, presses);
      scene = await saved(before, (s) => s.volumes.microphone === MICROPHONE);
      const focused = (await ax().windows(appPid)).focused;
      const kept = focused?.role === "AXSlider" && (focused.title === translate("Microphone", language) || focused.description === translate("Microphone", language));
      check({ check: `Volume: the microphone's slider, ${presses} presses down`, expected: `${MICROPHONE}% saved, the slider still focused`,
        actual: `${scene?.volumes.microphone ?? "?"}% saved, focus on ${focused ? `${focused.role} ${focused.title || focused.description}` : "nothing"}`,
        pass: scene?.volumes.microphone === MICROPHONE && kept });
      await shot("6-volume.png");
    }
    // Hidden over a stretch (2026-10-26): a click on the camera's lane selects it there and focuses the timeline, the
    // playhead is stepped to 4 s by Shift+→, S splits there (the part after it selected) and C hides the camera from
    // there on; stepped on to 7 s, S and C show it again after that, leaving it hidden from 4 to 7 s.
    const stretchMarker = "\u0002";
    const shownSuffix = translate("{from} to {to}, camera shown", language, { from: stretchMarker, to: stretchMarker }).split(stretchMarker).at(-1)!;
    // The overall volumes' panel, open from the volume, hides the rest of the window from accessibility: Escape closes it.
    await ax().key(KEY.escape);
    await sleep(500);
    // A stretch is a pressed-or-not button, which Chromium gives macOS as a toggle (AXCheckBox).
    await click(await find("camera lane", (e) => (e.role === "AXButton" || e.role === "AXCheckBox") && e.title.endsWith(shownSuffix)));
    await sleep(500);
    const step = async (code: number, times: number, flags?: number): Promise<void> => {
      for (let i = 0; i < times; i++) { await ax().key(code, flags); await sleep(150); }
    };
    await step(KEY.left, Math.ceil(sourceDuration) + 2, FLAG.shift);
    await step(KEY.right, HIDE_FROM, FLAG.shift);
    await step(KEY.s, 1);
    before = revision();
    await step(KEY.c, 1);
    scene = await saved(before, (s) => Boolean(s.camera?.hidden?.length));
    await step(KEY.right, HIDE_TO - HIDE_FROM, FLAG.shift);
    await step(KEY.s, 1);
    before = revision();
    await step(KEY.c, 1);
    const tolerance = 0.05 * 90_000;
    scene = await saved(before, (s) => s.camera?.hidden?.length === 1 && Math.abs(s.camera.hidden[0]![1] - HIDE_TO * 90_000) <= tolerance);
    const stretch = scene?.camera?.hidden?.[0];
    const stretchOk = scene?.camera?.shown === true && scene.camera.hidden?.length === 1 && stretch !== undefined
      && Math.abs(stretch[0] - HIDE_FROM * 90_000) <= tolerance && Math.abs(stretch[1] - HIDE_TO * 90_000) <= tolerance;
    check({ check: `Stretch: the camera hidden from ${HIDE_FROM} s to ${HIDE_TO} s by S and C`, expected: `the record holds one hidden stretch [${HIDE_FROM}, ${HIDE_TO}) s (±0.05)`,
      actual: scene?.camera ? `shown=${String(scene.camera.shown)}, hidden ${JSON.stringify((scene.camera.hidden ?? []).map(([a, b]) => [+(a / 90_000).toFixed(3), +(b / 90_000).toFixed(3)]))} s` : "no camera", pass: stretchOk });
    await shot("6b-hidden-stretch.png");
    // The preview in the stretch, paused: the bubble is not drawn there; before it, it is.
    await step(KEY.left, 2, FLAG.shift);
    await sleep(800);
    const goneInStretch = !(await elements()).some(isBubble);
    await shot("6c-preview-in-stretch.png");
    await step(KEY.left, 3, FLAG.shift);
    const backBefore = await find("camera bubble", isBubble, 3000).then(() => true, () => false);
    check({ check: "Stretch: the preview follows the playhead", expected: `no bubble at ${HIDE_TO - 2} s, the bubble at ${HIDE_TO - 5} s`,
      actual: `${goneInStretch ? "none" : "a bubble"} at ${HIDE_TO - 2} s, ${backBefore ? "the bubble" : "none"} at ${HIDE_TO - 5} s`, pass: goneInStretch && backBefore });

    // Volume over a stretch in the middle (2026-10-26): S at 11 s, then back at 9 s S again, which selects the part from
    // 9 to 11 s; V opens the Volume popup over it and each input's Mute silences it there. The record must hold those
    // stretches, and the export be silent there and heard before and after it (judged after the export).
    await step(KEY.right, MUTE_TO - (HIDE_TO - 5), FLAG.shift);
    await step(KEY.s, 1);
    await step(KEY.left, MUTE_TO - MUTE_FROM, FLAG.shift);
    await step(KEY.s, 1);
    await step(KEY.v, 1);
    await sleep(600);
    const inputs = description.sounds.filter((sound): sound is "system" | "microphone" => sound === "system" || sound === "microphone");
    for (const input of inputs) {
      const name = translate(input === "system" ? "System audio" : "Microphone", language);
      const title = translate("Mute {name} in the selection", language, { name });
      before = revision();
      await click(await find(`Mute ${input} button`, (e) => (e.role === "AXButton" || e.role === "AXCheckBox") && e.title === title));
      scene = await saved(before, (s) => Boolean(s.volumeStretches?.[input]?.length));
    }
    await shot("6d-volume-muted.png");
    await ax().key(KEY.escape);
    await sleep(400);
    const muted = inputs.map((input) => scene?.volumeStretches?.[input]?.[0]);
    const mutedOk = muted.length > 0 && muted.every((stretch) => stretch !== undefined && stretch[2] === 0
      && Math.abs(stretch[0] - MUTE_FROM * 90_000) <= tolerance && Math.abs(stretch[1] - MUTE_TO * 90_000) <= tolerance);
    check({ check: `Volume: ${inputs.join(" and ")} muted from ${MUTE_FROM} s to ${MUTE_TO} s by S, S, V and Mute`, expected: `each a stretch at 0% from ${MUTE_FROM} s to ${MUTE_TO} s (±0.05)`,
      actual: muted.map((stretch, n) => `${inputs[n]} ${stretch ? `${(stretch[0] / 90_000).toFixed(3)}–${(stretch[1] / 90_000).toFixed(3)} s at ${stretch[2]}%` : "none"}`).join(", "), pass: mutedOk });

    const final = readScene()?.scene ?? fail("no scene saved");

    // Export.
    const exportFrom = log.end();
    // Save a copy… (plan 100) asks in which form; the Video, its default, is saved.
    await click(await find("Save a copy button", (e) => e.role === "AXButton" && e.title === translate("Save a copy…", language)));
    await click(await find("Save button", (e) => e.role === "AXButton" && e.title === translate("Save", language)));
    const rendering = await waitForLog(log, exportFrom, /editing: rendering .* \(camera (shown|left out), volumes ([-\d./]+) dB\)/, "the render", controller.signal, 15_000);
    const done = await waitForLog(log, exportFrom, /editing: (exported .* as (.+) \(\d+ bytes\)|the export of .* (was cancelled|failed: .*))$/, "the export's end", controller.signal, 180_000);
    const published = /editing: exported .* as (.+) \(\d+ bytes\)$/.exec(done.line)?.[1];
    const percent = (sound: string): number => sound === "microphone" ? final.volumes.microphone : sound === "system" ? final.volumes.system : 100;
    const volumes = description.sounds.map((sound) => volumeDb(percent(sound)).toFixed(1)).join("/");
    const asked = /\(camera (shown|left out), volumes ([-\d./]+) dB\)/.exec(rendering.line);
    check({ check: "Export: rendered with the scene", expected: `camera shown, volumes ${volumes} dB`, actual: asked ? `camera ${asked[1]}, volumes ${asked[2]} dB` : rendering.line,
      pass: asked?.[1] === "shown" && asked[2] === volumes });
    const tracksAsked = /sound tracks ([\d/]+)/.exec(rendering.line)?.[1];
    check({ check: "Export: each input's own track, never the mix", expected: description.mix ? "sound tracks 1/2" : "every sound track (none named)",
      actual: tracksAsked ? `sound tracks ${tracksAsked}` : "none named", pass: description.mix ? tracksAsked === "1/2" : tracksAsked === undefined });
    const asked2 = /volume stretches ([\d/]+)/.exec(rendering.line)?.[1];
    check({ check: "Export: the inputs' volume stretches asked", expected: `one stretch for ${inputs.join(" and ")}`, actual: asked2 ? `stretches ${asked2}` : "none asked",
      pass: asked2 !== undefined && description.sounds.every((sound, n) => asked2.split("/")[n] === (sound === "silent" ? "0" : "1")) });
    const stretches = /the camera hidden over (\d+) stretch\(es\)/.exec(rendering.line)?.[1];
    check({ check: "Export: the camera left out over its stretch", expected: "the render asked to hide the camera over 1 stretch", actual: stretches ? `over ${stretches}` : "no stretch asked", pass: stretches === "1" });
    if (!published) fail(`the export did not publish: ${done.line}`);
    files.push(published!);
    await sleep(1000);
    await shot("7-exported.png");
    const output = probe(published!).info;
    const outVideos = output.streams.filter((s) => s.codec_type === "video"), outSounds = output.streams.filter((s) => s.codec_type === "audio");
    const outDuration = Number(output.format.duration);
    check({ check: "Export: an ordinary file of the whole recording", expected: `one picture and one sound track, ${sourceDuration.toFixed(1)} s (±0.2)`,
      actual: `${outVideos.length} picture, ${outSounds.length} sound, ${outDuration.toFixed(2)} s`, pass: outVideos.length === 1 && outSounds.length === 1 && Math.abs(outDuration - sourceDuration) <= 0.2 });

    // A frame before the hidden stretch: the camera's own picture in the bubble, the screen's elsewhere.
    const at = Math.min(sourceDuration, outDuration, HIDE_FROM) / 2;
    const exported = frameRgb(published!, at, width, height, path.join(dir, "export-frame.png"));
    const screenFrame = frameRgb(source, at, width, height, path.join(dir, "source-screen.png"), 0);
    const cameraFrame = frameRgb(source, at, cameraTrack!.width!, cameraTrack!.height!, path.join(dir, "source-camera.png"), 1);
    const placed = final.camera ?? fail("the final scene has no camera");
    const composite = judgeComposite(exported, screenFrame, cameraFrame, sceneLayout(placed, shape), placed);
    for (const verdict of composite.verdicts) check(verdict, verdict.judged);
    // The sound: silent where both inputs are muted, heard before and after it (mean volume over each span).
    // A measurement that failed is no evidence (Codex's review): FFmpeg must exit cleanly having decoded samples and
    // said a mean volume; digital silence it reports as -91 dB, or -inf.
    const loudness = (from: number, seconds: number): { db: number } | { failed: string } => {
      const run = spawnSync("ffmpeg", ["-hide_banner", "-ss", String(from), "-t", String(seconds), "-i", published!, "-vn", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
      // FFmpeg may say an empty first instance of the filter (n_samples: 0) before the one that heard the sound: the last.
      const samples = Number([...(run.stderr ?? "").matchAll(/n_samples:\s*(\d+)/g)].at(-1)?.[1] ?? 0);
      const db = [...(run.stderr ?? "").matchAll(/mean_volume:\s*(-?[\d.]+|-inf) dB/g)].at(-1)?.[1];
      if (run.status !== 0 || samples <= 0 || db === undefined) return { failed: `FFmpeg exit ${String(run.status)}, ${samples} samples${run.error ? `, ${run.error.message}` : ""}` };
      return { db: db === "-inf" ? Number.NEGATIVE_INFINITY : Number(db) };
    };
    // Each span 0.3 s inside its stretch, clear of the 10 ms eases at its ends; after it, to the export's end.
    const heard = loudness(1, 2), silent = loudness(MUTE_FROM + 0.3, MUTE_TO - MUTE_FROM - 0.6);
    const after = loudness(MUTE_TO + 0.3, Math.max(0.3, outDuration - MUTE_TO - 0.4));
    const said = (m: { db: number } | { failed: string }): string => ("failed" in m ? `not measured (${m.failed})` : `${m.db.toFixed(1)} dB`);
    check({ check: `Export: silent where the inputs are muted (${MUTE_FROM}–${MUTE_TO} s), heard before and after`,
      expected: `at most −50 dB there, and at least 20 dB louder at 1–3 s and after ${MUTE_TO} s`,
      actual: `${said(silent)} at ${MUTE_FROM + 0.3}–${MUTE_TO - 0.3} s, ${said(heard)} at 1–3 s, ${said(after)} after ${MUTE_TO + 0.3} s`,
      pass: "db" in silent && "db" in heard && "db" in after && silent.db <= -50 && heard.db - silent.db >= 20 && after.db - silent.db >= 20 });
    // A frame in the hidden stretch: the screen's alone.
    const hiddenAt = (HIDE_FROM + HIDE_TO) / 2;
    const hiddenFrame = frameRgb(published!, hiddenAt, width, height, path.join(dir, "export-frame-hidden.png"));
    const hiddenScreen = frameRgb(source, hiddenAt, width, height, path.join(dir, "source-screen-hidden.png"), 0);
    check(judgeScreenOnly(hiddenFrame, hiddenScreen, sceneLayout(placed, shape), placed, hiddenAt));

    await timeline();

    await click(await find("Close button", (e) => e.role === "AXButton" && e.title === translate("Close", language)));
    await sleep(500);

    // The next recording, by the shortcut: plain again, the setting still off.
    const nextFrom = log.end();
    await command("osascript", ["-e", script], AbortSignal.timeout(10_000));
    await waitForLog(log, nextFrom, /state → recording/, "`state → recording`", controller.signal);
    const nextCapture = await waitForRecord(log, nextFrom, (r): r is Extract<typeof r, { kind: "capture" }> => r.kind === "capture" && r.run === run, "the second capture record", controller.signal);
    await sleep(3000);
    await command("osascript", ["-e", script], AbortSignal.timeout(10_000));
    const nextEnd = await waitForRecord(log, nextCapture.next, (r): r is TerminalRecord => (r.kind === "saved" || r.kind === "failed") && r.run === run && r.session === nextCapture.record.session,
      "the second save", controller.signal, 60_000);
    const nextPath = nextEnd.record.kind === "saved" ? nextEnd.record.path : fail("the second recording was not saved");
    files.push(nextPath);
    const plainNext = readEditableDescription(fs.readFileSync(nextPath)) === undefined;
    check({ check: "The next recording: plain again", expected: "no editable description, Editable recordings still off",
      actual: plainNext ? "plain" : "editable", pass: plainNext });
  } catch (error) {
    runError = error;
  } finally {
    try { await closeMaterial(); } catch (error) { cleanup.push(`could not close the material: ${String(error)}`); }
    try { await quitApp(); } catch (error) { cleanup.push(String(error)); }
    try {
      if (running() === undefined) fs.writeFileSync(APP_SETTINGS_PATH, originalText);
      else cleanup.push(`RecordStuff is still running: settings NOT restored; copy them back from ${path.join(dir, "settings.before.json")}`);
    } catch (error) { cleanup.push(`could not restore the settings: ${String(error)}`); }
    desktop.end();
  }

  const failed = checks.some((c) => c.judged && !c.pass);
  const unjudged = checks.some((c) => !c.judged);
  const cleanupIncomplete = cleanup.length > 0;
  const prerequisite = runError instanceof Blocked || runError instanceof AccessibilityBlockedError;
  const errored = Boolean(runError) && !prerequisite;
  const { outcome, code } = roundExit({ cleanupIncomplete, interrupted: interruptedBy, locked: desktop.lockedAt !== undefined, failed: failed || errored, blocked: prerequisite || unjudged });
  const result = cleanupIncomplete ? "INCOMPLETE CLEANUP" : outcome.toUpperCase();
  const report = [
    "# Edit view acceptance (`pnpm acceptance:editor`)", "",
    `Result: **${result}**.${runError ? ` Stopped by: ${runError instanceof Error ? runError.message : String(runError)}.` : ""}`, "",
    "Input: CoreGraphics pointer events and key presses on the packaged app (scripted native input). Judged from the edit record, the app's log and the files; the screenshots are for a person to look at, and what the preview sounds like is not judged.", "",
    "| Check | Expected | Actual | Verdict |", "| --- | --- | --- | --- |",
    ...checks.map((c) => `| ${c.check} | ${c.expected} | ${c.actual} | ${c.judged ? (c.pass ? "pass" : "fail") : "unjudged"} |`), "",
    "## Files", "", ...files.map((file) => `- ${file}`), "",
    "## Screenshots", "", ...(shots.length ? shots.map((name) => `- \`${name}\``) : ["None."]), "",
    "Frames compared: `export-frame.png`, `source-screen.png`, `source-camera.png`.", "",
    "## Cleanup", "", cleanupIncomplete ? cleanup.map((line) => `- ${line}`).join("\n") : "Complete: RecordStuff exited, the material closed and the settings file was restored byte for byte. The recording, its export and its edit record are kept.", "",
    "## Desktop", "", desktop.summary, "",
    "## Events", "", ...events.map((line) => `- ${line}`), "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "report.json"), `${JSON.stringify({ result, checks, files, shots, cleanup, events, error: runError ? String(runError) : null }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "report.md"), report);
  console.log(`Report ${path.relative(REPO_ROOT, dir)}/report.md`);
  console.log(result);
  return code;
}

main().then((code) => process.exit(code), (error: unknown) => {
  console.error(error);
  process.exit(1);
});
