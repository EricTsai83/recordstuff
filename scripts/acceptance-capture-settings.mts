/**
 * `pnpm acceptance:capture-settings [-- --skip-camera] [--skip-volume] [--out <dir>]` (2026-10-22): what the camera's
 * layout and the inputs' volumes do to a real recording, on the packaged app, macOS only; never shipped. Build and quit
 * the bundle first (`pnpm start:app`, then Quit). For each case the runner saves the case's settings, launches the
 * bundle, records with the registered shortcut through System Events (no countdown, the primary display), stops, waits
 * for the save and quits, then judges the file:
 *
 * - **Camera** over `scripts/camera-material.html`, one magenta full screen: a new bubble (no layout saved, the default
 *   `DEFAULT_CAMERA_LAYOUT`) and a saved one (a circle near the bottom-left, the primary display's position). A frame
 *   from the middle of each recording must show the camera's picture where `bubbleRect` puts it (each edge within
 *   3 px), filled, its corners rounded as `insideBubble` draws them, and the material everywhere else
 *   (capture-settings.mts). The camera is the user's own choice; one that delivers no frame blocks the case.
 * - **Volume** over `scripts/test-material.html`'s beeps: system audio at 100%, 50%, 600% and 0%. The engine must log
 *   the gain `volumeDb` gives, and each file's peak must differ from 100%'s by that gain within 1 dB; 0% is silent.
 *
 * The frames judged are saved as PNGs beside the report for a person to look at; recordings stay in the output folder.
 * The user's settings file is restored byte for byte at the end. Exit 0 pass, 1 fail or incomplete cleanup, 2 blocked
 * (not macOS, no bundle, RecordStuff running, no FFmpeg or Chrome, a locked screen, a camera without frames),
 * 130/143 interrupted.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
import { osascriptAx } from "./lib/runner/native-ax.mts";
import { developmentAppPath } from "./lib/runner/verification-timing.mts";
import { frameRgb, hasTool, overallPeak, probe, requireMediaTimeout } from "./lib/verification/media-tools.mts";
import { judgeBubble, judgeVolumes, parseOverallPeak, type Verdict } from "./lib/acceptance/capture-settings.mts";
import { DEFAULT_CAMERA_LAYOUT, PRIMARY_DISPLAY_KEY, recordedPosition, type CameraLayout } from "../src/shared/camera-layout.ts";
import { volumeDb } from "../src/shared/audio-volume.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = developmentAppPath(REPO_ROOT);
const EXECUTABLE = path.join(BUNDLE, "Contents/MacOS/RecordStuff");
const ELECTRON_APP = path.join(REPO_ROOT, "node_modules/electron/dist/Electron.app");
const ELECTRON_APP_REAL = fs.existsSync(ELECTRON_APP) ? fs.realpathSync(ELECTRON_APP) : ELECTRON_APP;
const CAMERA_MATERIAL = path.join(REPO_ROOT, "scripts/camera-material.html");
const SOUND_MATERIAL = path.join(REPO_ROOT, "scripts/test-material.html");
const CAMERA_SECONDS = 4;
const VOLUME_SECONDS = 6;
const VOLUMES = [100, 50, 600, 0] as const;
/** A saved bubble unlike the default: a circle near the bottom-left, placed for the primary display. */
const SAVED_LAYOUT: CameraLayout = { width: 0.25, height: 0.25, rounding: 1, mirror: false, positions: [{ display: PRIMARY_DISPLAY_KEY, x: 0.03, y: 0.95 }] };

const usage = "usage: pnpm acceptance:capture-settings [-- --skip-camera] [--skip-volume] [--out <dir>]";
let skipCamera = false, skipVolume = false, outDir: string | undefined;
const argv = runnerArgs();
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]!;
  if (arg === "--skip-camera") skipCamera = true;
  else if (arg === "--skip-volume") skipVolume = true;
  else if (arg === "--out" && argv[i + 1] && !argv[i + 1]!.startsWith("--")) outDir = argv[++i];
  else { console.error(usage); process.exit(2); }
}
if (skipCamera && skipVolume) { console.error(usage); process.exit(2); }

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

interface Check extends Verdict { group: "camera" | "volume" }
interface Recorded { file: string; width: number; height: number; duration: number; lines: string[] }

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
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = outDir ?? path.join(REPO_ROOT, "docs/verification/measurements", `${stamp}-capture-settings-acceptance`);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) { console.error("output directory is not empty"); return 2; }
  fs.mkdirSync(dir, { recursive: true });
  const originalText = fs.readFileSync(APP_SETTINGS_PATH, "utf8");
  const original = JSON.parse(originalText) as Record<string, unknown>;
  // Kept first, so a round that cannot restore them leaves the copy to restore by hand.
  fs.writeFileSync(path.join(dir, "settings.before.json"), originalText);
  const desktop = await beginDesktopRound().catch((cause: unknown) => {
    if (cause instanceof DesktopBlockedError) { console.error(`BLOCKED: ${cause.message}`); process.exit(DESKTOP_BLOCKED_EXIT); }
    throw cause;
  });
  const checks: Check[] = [];
  const cleanup: string[] = [];
  const recordings: string[] = [];
  let runError: unknown;
  let launchIssued = false;
  let launcher: ChildProcess | undefined;
  let profile: string | undefined;
  const materialPids = (): number[] => profile ? pgrepPids(escapeRegExp(profile)) : [];

  const openMaterial = async (file: string): Promise<void> => {
    profile = createMaterialProfile("capture-settings");
    launcher = spawn("open", materialOpenArgs(file, profile), { stdio: "ignore" });
    await sleep(5000);
    if (!materialPids().length) blocked(`the material ${path.basename(file)} did not open in Google Chrome`);
    note(`${path.basename(file)} open full screen on the primary display`);
  };
  const closeMaterial = async (): Promise<void> => {
    const opening = launcher;
    if (opening && opening.exitCode === null && opening.signalCode === null) await Promise.race([new Promise((resolve) => opening.once("exit", resolve)), delay(10_000)]);
    for (let attempt = 0; attempt < 40 && materialPids().length > 0; attempt += 1) { signalPids(materialPids(), "SIGTERM"); await delay(250); }
    if (materialPids().length > 0) cleanup.push(`could not close the material browser (private profile ${profile})`);
    else if (profile) {
      const problem = await removeMaterialProfile(profile);
      if (problem) cleanup.push(`could not remove the material profile: ${problem}`);
    }
    profile = undefined; launcher = undefined;
  };
  /** The material's browser in front, as a recording made over another app has it. */
  const materialToFront = async (): Promise<void> => {
    const pids = materialPids();
    await command("osascript", ["-l", "JavaScript", "-e", `const se = Application("System Events");
      for (const pid of ${JSON.stringify(pids)}) { const p = se.processes.whose({ unixId: pid }); if (p.length) { p[0].frontmost = true; break; } }`], AbortSignal.timeout(10_000));
    await sleep(800);
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

  /** One case: its settings saved over the user's, a launch, a recording of `seconds` by the shortcut, the save, a quit. */
  const record = async (name: string, patch: (settings: Record<string, unknown>) => Record<string, unknown>, seconds: number): Promise<Recorded> => {
    writeAppSettings(patch({ ...original, countdown: 0, display: { kind: "primary" } }));
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
      if (signal.aborted && !controller.signal.aborted) fail(`${name}: RecordStuff did not reach idle with its shortcut registered within 60 s`);
      await sleep(200);
    }
    launchIssued = false;
    const run = currentRunId(lines) ?? fail(`${name}: the start line has no run id`);
    const accelerator = registeredAccelerator(lines)!;
    const script = keystrokeScript(acceleratorToKeystroke(accelerator) ?? fail(`${name}: cannot type ${accelerator}`));
    await materialToFront();
    // The pointer in the middle of the primary display: at an edge it would bring the Dock or the menu bar over the material.
    const centre = JSON.parse(await command("osascript", ["-l", "JavaScript", "-e", `ObjC.import("AppKit"); const f = $.NSScreen.screens.objectAtIndex(0).frame; JSON.stringify({ x: f.size.width / 2, y: f.size.height / 2 })`], AbortSignal.timeout(10_000))) as { x: number; y: number };
    await osascriptAx(controller.signal).move(Math.round(centre.x), Math.round(centre.y));
    await sleep(1000);
    const pressFrom = log.end();
    await command("osascript", ["-e", script], AbortSignal.timeout(10_000));
    await waitForLog(log, pressFrom, /state → recording/, `${name}: \`state → recording\``, controller.signal);
    const capture = await waitForRecord(log, pressFrom, (r): r is Extract<typeof r, { kind: "capture" }> => r.kind === "capture" && r.run === run,
      `${name}: the capture record`, controller.signal);
    await sleep(seconds * 1000);
    await command("osascript", ["-e", script], AbortSignal.timeout(10_000));
    const terminal = await waitForRecord(log, capture.next, (r): r is TerminalRecord => (r.kind === "saved" || r.kind === "failed") && r.run === run && r.session === capture.record.session,
      `${name}: the save`, controller.signal, 60_000);
    if (terminal.record.kind === "failed") throw new Failure(`${name}: the recording failed: ${terminal.record.code} ${terminal.record.detail}`);
    const file = terminal.record.path;
    recordings.push(file);
    // From the press: the volumes are sent once the session is prepared, before it records.
    const session = log.since(pressFrom).lines.map((line) => line.text);
    await quitApp();
    const video = probe(file).info;
    const stream = video.streams.find((s) => s.codec_type === "video");
    if (!stream?.width || !stream.height) fail(`${name}: ${file} has no video stream`);
    const duration = Number(video.format.duration);
    note(`${name}: saved ${file} (${stream!.width}×${stream!.height}, ${duration.toFixed(1)} s)`);
    return { file, width: stream!.width!, height: stream!.height!, duration, lines: session };
  };

  try {
    if (!skipCamera) {
      await openMaterial(CAMERA_MATERIAL);
      const cases: Array<{ name: string; layout: CameraLayout; patch: (s: Record<string, unknown>) => Record<string, unknown> }> = [
        // A new bubble: no layout saved, so the app takes its default.
        { name: "camera-default", layout: DEFAULT_CAMERA_LAYOUT, patch: ({ cameraLayout: _saved, ...s }) => ({ ...s, camera: true }) },
        { name: "camera-saved", layout: SAVED_LAYOUT, patch: (s) => ({ ...s, camera: true, cameraLayout: SAVED_LAYOUT }) },
      ];
      for (const each of cases) {
        const recorded = await record(each.name, each.patch, CAMERA_SECONDS);
        // The engine's own account of the camera at the stop: a camera that sent nothing leaves no picture to judge.
        const stop = recorded.lines.map((line) => /camera: at the stop (.+?): running \w+, (\d+) frame\(s\) delivered/.exec(line)).find(Boolean);
        if (!stop) fail(`${each.name}: the engine logged no camera in the recording (is Camera access granted?)`);
        if (Number(stop![2]) === 0) blocked(`${each.name}: the camera ${stop![1]} delivered no frame; connect or wake it and run again`);
        note(`${each.name}: camera ${stop![1]}, ${stop![2]} frame(s)`);
        const png = path.join(dir, `${each.name}.png`);
        const frame = frameRgb(recorded.file, recorded.duration / 2, recorded.width, recorded.height, png);
        const result = judgeBubble(frame, each.layout, recordedPosition(each.layout, PRIMARY_DISPLAY_KEY));
        for (const verdict of result.verdicts) checks.push({ group: "camera", ...verdict, check: `${each.name}: ${verdict.check}` });
        // A flat bubble may be a dark room or a covered lens as much as a picture never drawn: said, for a person to judge.
        note(`${each.name}: the bubble's picture varies by ${result.spread.toFixed(1)} (luma standard deviation; near 0 is a flat fill: look at ${each.name}.png)`);
      }
      await closeMaterial();
    }
    if (!skipVolume) {
      await openMaterial(SOUND_MATERIAL);
      const peaks = new Map<number, number>();
      for (const volume of VOLUMES) {
        const name = `volume-${volume}`;
        const recorded = await record(name, (s) => ({ ...s, camera: false, microphone: false, audioVolume: { system: volume, microphone: 100 } }), VOLUME_SECONDS);
        // The gain the engine was given, as its host logs it.
        const gain = recorded.lines.map((line) => /capture host: audio: system (-?\d+(?:\.\d)?) dB/.exec(line)?.[1]).find((value) => value !== undefined);
        const want = volumeDb(volume).toFixed(1);
        checks.push({ group: "volume", check: `${name}: the engine's system gain`, expected: `${want} dB`, actual: gain ? `${gain} dB` : "not logged", pass: gain === want });
        peaks.set(volume, overallPeak(recorded.file, parseOverallPeak));
      }
      for (const verdict of judgeVolumes(peaks)) checks.push({ group: "volume", ...verdict, check: `volume ${verdict.check}: recorded level` });
      await closeMaterial();
    }
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

  const failed = checks.some((check) => !check.pass);
  const cleanupIncomplete = cleanup.length > 0;
  const prerequisite = runError instanceof Blocked;
  const errored = Boolean(runError) && !prerequisite;
  const { outcome, code } = roundExit({ cleanupIncomplete, interrupted: interruptedBy, locked: desktop.lockedAt !== undefined, failed: failed || errored, blocked: prerequisite });
  const result = cleanupIncomplete ? "INCOMPLETE CLEANUP" : outcome.toUpperCase();
  const table = (group: Check["group"]): string[] => checks.filter((check) => check.group === group)
    .map((check) => `| ${check.check} | ${check.expected} | ${check.actual} | ${check.pass ? "pass" : "fail"} |`);
  const report = [
    "# Capture settings acceptance (`pnpm acceptance:capture-settings`)", "",
    `Result: **${result}**.${runError ? ` Stopped by: ${runError instanceof Error ? runError.message : String(runError)}.` : ""}`, "",
    ...(skipCamera ? [] : ["## Camera", "", "Frames judged: `camera-default.png`, `camera-saved.png` (look at them: the bubble's picture and edge).", "",
      "| Check | Expected | Actual | Verdict |", "| --- | --- | --- | --- |", ...table("camera"), ""]),
    ...(skipVolume ? [] : ["## Volume", "", "| Check | Expected | Actual | Verdict |", "| --- | --- | --- | --- |", ...table("volume"), ""]),
    "## Recordings", "", ...recordings.map((file) => `- ${file}`), "",
    "## Cleanup", "", cleanupIncomplete ? cleanup.map((line) => `- ${line}`).join("\n") : "Complete: RecordStuff exited, the material closed and the settings file was restored byte for byte.", "",
    "## Desktop", "", desktop.summary, "",
    "## Events", "", ...events.map((line) => `- ${line}`), "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "report.json"), `${JSON.stringify({ result, checks, recordings, cleanup, events, error: runError ? String(runError) : null }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "report.md"), report);
  console.log(`Report ${path.relative(REPO_ROOT, dir)}/report.md`);
  console.log(result);
  return code;
}

main().then((code) => process.exit(code), (error: unknown) => {
  console.error(error);
  process.exit(1);
});
