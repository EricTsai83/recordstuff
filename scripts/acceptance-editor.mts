/**
 * `pnpm acceptance:editor [-- --secondary] [--no-microphone] [--out <dir>]` (plan 087's follow-up, 2026-10-25): an
 * editable recording edited and exported on the packaged app with real input, macOS only; never shipped. Build and quit
 * the bundle first (`pnpm start:app`, then Quit). The runner saves Editable recordings, the camera and the microphone
 * on (`--no-microphone`: off) and no countdown over the user's settings, launches the bundle, opens the moving test
 * material full screen on the recorded display (the primary, or with `--secondary` the second, so the primary stays
 * free) and records 12 s with the registered shortcut. The camera is the user's own choice and must see something:
 * one that delivers no frame blocks the round. Then, in the app's own window, opened by the tray's Show last recording:
 *
 * - the card's More actions → Edit… opens the edit view, which must draw the camera's bubble;
 * - **Drag.** The bubble is dragged with CoreGraphics pointer events to the bottom-left; the edit record must save it
 *   there (`judgePlace`).
 * - **Resize.** The size slider's thumb is clicked and moved 5 steps down by the arrow keys; the record must save the
 *   bubble smaller by 5 points with its shape kept (`judgeResize`).
 * - **Hide and Undo.** Show camera is switched off (the record says hidden and the bubble leaves the view), then Undo is
 *   pressed (shown again, the resize kept).
 * - **Volume.** The microphone's slider is clicked and moved to 50% by the arrow keys; the record must say 50 and the
 *   slider keep the keyboard's focus throughout (a save between presses once took it).
 * - **Export.** Export is pressed; main must log the render with the camera shown and the volumes the scene gives, and
 *   publish `<name> (edited).mp4`. Its middle frame must hold the camera track's own picture where the scene put the
 *   bubble and the screen track's everywhere else (`judgeComposite`); a camera too flat to recognise (a covered lens)
 *   leaves that check unjudged, which blocks the round rather than passing it. It must have one picture and one sound
 *   track and last as long as the recording.
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
import { AccessibilityBlockedError, KEY, captureRect, centre, osascriptAx, type Frame, type WindowElement } from "./lib/runner/native-ax.mts";
import { nativeDrag } from "./lib/runner/native-drag.mts";
import { developmentAppPath } from "./lib/runner/verification-timing.mts";
import { TrayDriver } from "./lib/acceptance/tray-driver.mts";
import { frameRgb, hasTool, probe, requireMediaTimeout } from "./lib/verification/media-tools.mts";
import { dragFor, judgeComposite, judgePlace, judgeResize, readEditableDescription, recordScene, sceneLayout } from "./lib/acceptance/editor-acceptance.mts";
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
    writeAppSettings({ ...original, editableRecording: true, camera: true, microphone, countdown: 0,
      display: secondary ? { kind: "display", id: target.id, label: target.label } : { kind: "primary" } });
    note(`settings: Editable recordings, camera, microphone ${microphone ? "on" : "off"}, no countdown, recording ${secondary ? `${target.label} (${target.id})` : "the primary display"}`);
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
    const pressFrom = log.end();
    await command("osascript", ["-e", script], AbortSignal.timeout(10_000));
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
    check({ check: "Recording: an editable file", expected: `the screen and the camera apart, ${microphone ? 2 : 1} sound track(s), a description with a camera`,
      actual: `${videos.length} picture and ${sourceInfo.streams.filter((s) => s.codec_type === "audio").length} sound track(s), sounds ${description.sounds.join("/")}, camera ${description.camera ? "described" : "none"}`,
      pass: videos.length === 2 && description.camera !== null && description.sounds.length === (microphone ? 2 : 1) });
    if (!screen?.width || !screen.height || !cameraTrack?.width || !cameraTrack.height || !description.camera) fail("the recording is not one this round can edit");
    const shape = { rounding: description.camera!.rounding, mirror: description.camera!.mirror };
    note(`recorded ${source} (${screen!.width}×${screen!.height}, ${sourceDuration.toFixed(1)} s; camera ${cameraStop![1]}, ${cameraStop![2]} frame(s))`);

    await closeMaterial();
    note("test material closed: the edit needs none");
    // The window on Recordings with the newest take, then its card's More actions → Edit….
    const tray = new TrayDriver(ax(), appPid, controller.signal, undefined, BUNDLE_ID());
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
    await click(await find("card menu", (e) => e.title === translate("More actions for {title}", language, { title })));
    await click(await find("Edit… item", (e) => e.role === "AXMenuItem" && e.title === translate("Edit…", language)));
    const marker = "\u0001";
    const bubblePrefix = translate("Camera: {x}% across, {y}% down. Drag it, or use the arrow keys, to move it.", language, { x: marker, y: marker }).split(marker)[0]!;
    const isBubble = (e: WindowElement): boolean => e.role === "AXButton" && e.title.startsWith(bubblePrefix);
    const bubble = await find("camera bubble", isBubble, 20_000);
    // The preview's camera track is copied when the view opens: a moment for it to load and draw.
    await sleep(3000);
    await shot("1-opened.png");
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

    // Resize: the thumb clicked where it is (a click may move it a step: the size it then saved is the start), then the
    // arrow keys.
    await click(await find("camera size slider", (e) => e.role === "AXSlider" && e.title === translate("Camera size", language)));
    await sleep(600);
    const clicked = readScene()?.scene.camera ?? moved;
    before = revision();
    await press(KEY.left, SIZE_STEPS);
    const resizedLonger = Math.round(Math.max(clicked.width, clicked.height) * 100) - SIZE_STEPS;
    scene = await saved(before, (s) => Boolean(s.camera && Math.round(Math.max(s.camera.width, s.camera.height) * 100) <= resizedLonger));
    check(judgeResize(clicked, scene?.camera, SIZE_STEPS));
    await shot("3-resized.png");
    const resized = scene?.camera ?? fail("the resize saved no camera");

    // Hide, then Undo.
    before = revision();
    await click(await find("Show camera switch", (e) => e.role === "AXCheckBox" && e.title === translate("Show camera", language)));
    scene = await saved(before, (s) => s.camera?.shown === false);
    await sleep(500);
    const bubbleGone = !(await elements()).some(isBubble);
    check({ check: "Hide: Show camera switched off", expected: "the record says hidden and the bubble leaves the view",
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

    // The microphone to 50%, by the keyboard after one click on its thumb.
    if (microphone) {
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
    const final = readScene()?.scene ?? fail("no scene saved");

    // Export.
    const exportFrom = log.end();
    await click(await find("Export button", (e) => e.role === "AXButton" && e.title === translate("Export", language)));
    const rendering = await waitForLog(log, exportFrom, /editing: rendering .* \(camera (shown|left out), volumes ([-\d./]+) dB\)/, "the render", controller.signal, 15_000);
    const done = await waitForLog(log, exportFrom, /editing: (exported .* as (.+) \(\d+ bytes\)|the export of .* (was cancelled|failed: .*))$/, "the export's end", controller.signal, 180_000);
    const published = /editing: exported .* as (.+) \(\d+ bytes\)$/.exec(done.line)?.[1];
    const percent = (sound: string): number => sound === "microphone" ? final.volumes.microphone : sound === "system" ? final.volumes.system : 100;
    const volumes = description.sounds.map((sound) => volumeDb(percent(sound)).toFixed(1)).join("/");
    const asked = /\(camera (shown|left out), volumes ([-\d./]+) dB\)/.exec(rendering.line);
    check({ check: "Export: rendered with the scene", expected: `camera shown, volumes ${volumes} dB`, actual: asked ? `camera ${asked[1]}, volumes ${asked[2]} dB` : rendering.line,
      pass: asked?.[1] === "shown" && asked[2] === volumes });
    if (!published) fail(`the export did not publish: ${done.line}`);
    files.push(published!);
    await sleep(1000);
    await shot("7-exported.png");
    const output = probe(published!).info;
    const outVideos = output.streams.filter((s) => s.codec_type === "video"), outSounds = output.streams.filter((s) => s.codec_type === "audio");
    const outDuration = Number(output.format.duration);
    check({ check: "Export: an ordinary file of the whole recording", expected: `one picture and one sound track, ${sourceDuration.toFixed(1)} s (±0.2)`,
      actual: `${outVideos.length} picture, ${outSounds.length} sound, ${outDuration.toFixed(2)} s`, pass: outVideos.length === 1 && outSounds.length === 1 && Math.abs(outDuration - sourceDuration) <= 0.2 });

    // The middle frame: the camera's own picture in the bubble, the screen's elsewhere.
    const at = Math.min(sourceDuration, outDuration) / 2;
    const exported = frameRgb(published!, at, width, height, path.join(dir, "export-frame.png"));
    const screenFrame = frameRgb(source, at, width, height, path.join(dir, "source-screen.png"), 0);
    const cameraFrame = frameRgb(source, at, cameraTrack!.width!, cameraTrack!.height!, path.join(dir, "source-camera.png"), 1);
    const placed = final.camera ?? fail("the final scene has no camera");
    const composite = judgeComposite(exported, screenFrame, cameraFrame, sceneLayout(placed, shape), placed);
    for (const verdict of composite.verdicts) check(verdict, verdict.judged);

    await click(await find("Close button", (e) => e.role === "AXButton" && e.title === translate("Close", language)));
    await sleep(500);
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
