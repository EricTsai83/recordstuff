/**
 * `pnpm measure:cpu [-- --minutes 5] [--fps 60] [--repeat N] [--skip-recording] [--skip-settings] [--skip-playback] [--camera <value>] [--studio] [--studio-active] [--material moving|still] [--audio off] [--capture-interval frame] [--diagnostics] [--profile] [--out <dir>]`
 *
 * The CPU budget on the packaged app (plan 049, docs/system-design/tooling.md#cpu-budget).
 * Build and quit the bundle first (`pnpm start:app`, then Quit); this runner refuses to start
 * while any RecordStuff runs, launches that bundle (dist/mac-arm64, dist/mac on Intel) itself and samples its
 * process tree once a second with the shared sampler (scripts/lib/verification/cpu-sampler.mts):
 *
 * - A. Idle after launch, Settings closed: `--minutes` (5) after a 60-second warm-up.
 * - R. Recording: a 60-second recording started and stopped with the recording shortcut over
 *   the moving test material, judged over seconds 5 to 55, VTEncoderXPCService followed. The
 *   countdown is seeded Off, the recorded display to the primary one (where the material opens)
 *   and the quality to Standard, Source, 30 fps; `--fps 60` relaunches at 60 fps for a second
 *   set; `--repeat N` (odd) records each set N times and judges the median run.
 * - B. Idle after the recording: from 30 seconds after the last save, `--minutes`, with the encoder
 *   back to nothing.
 * - C. Settings open behind another app: 3 minutes, the pointer parked on the menu bar (`--hover-card`: on the
 *   first card, whose preview a window without the focus no longer plays).
 * - P. Playback (plan 072): the last 30 fps recording, reached as a person does (the tray's Show last recording
 *   focuses its card's Play button, confirmed by its element id, Return plays it), judged over 50 s after a 5-second settle, per role: the app,
 *   its GPU process and its renderers. Skipped without a recording in this launch. The file must have been saved as
 *   a plain MP4: a fragmented one costs the renderer more the longer it is, which a 60-second file cannot show.
 *
 * `--camera <value>` (plan 075 step 2's gate) launches the bundle with `RECORDSTUFF_CAMERA_PROTOTYPE=<value>`, which
 * makes the Camera switch available, and seeds the switch on (with `cameraDevice` when the value has `device=<id>`):
 * the camera composed into every recording at the stored layout, and its preview page open unless the value has
 * `preview=0`. It measures A and R only: B, C and P need `--skip-settings --skip-playback`, and B is left
 * out, since the preview page is a renderer the idle contract does not allow after a recording.
 *
 * `--profile` (plan 081) also writes 10 s of `sample` of main, the GPU process, every renderer and the capture process
 * beside the report, from 25 s into each recording and 20 s into each Live preview: native stacks to attribute a
 * process's share by thread (Electron's own frames are stripped, so its symbols are only approximate). It perturbs the
 * window it falls in, which the report's figures then include.
 *
 * `--studio` (plan 075 step 8, with `--camera`) adds, before the recordings with Settings closed and over the same
 * moving material, the Recording Studio (D19, D20), opened from the tray's Open Recording Studio… before the material's
 * full screen hides the menu bar, and closed again before R. Then
 * S. the same recordings with the Studio showing the engine's preview and the meters, judged against R's median at the
 * same rate (D18: at most 8 points more), and L. a Live preview held for 50 s, judged against the camera's recording
 * budget at that rate (D18: a recording without the file), whose Live preview switch, pressed to start and again to stop, is found through
 * Chromium's accessibility tree, turned off again at once (Chromium may keep some of its cost: L is measured after
 * S for that reason), and pressed with the pointer. Run with `--camera preview=0`
 * so R has no prototype page; the Studio window should stand on another display than the material, which the report
 * notes.
 *
 * Each idle scenario also checks the app's processes by Chromium role against the idle contract (`IDLE_ROLES`): no
 * pre-warmed renderer after launch, neither Chromium's audio service nor the native engine's capture process after a
 * recording (plan 076), and with Settings closed no renderer after a recording. Five seconds after
 * every save the roles are snapshotted, and every snapshot of a launch must match the first: what
 * a recording starts once is expected, what it adds each time is a leak.
 *
 * `--diagnostics` (plan 083) launches the bundle with `RECORDSTUFF_DIAGNOSTICS=1`, so each session logs its pipeline's
 * figures once it ends (core/diagnostics.rs, the Studio page's while it shows the preview), and adds them to the report
 * per recording and per scenario: each stage's count, mean, p50, p95 and maximum, the queues' high-water marks and the
 * drops (scripts/lib/verification/pipeline-report.mts). A recording or Live preview without the engine's figures fails
 * its check. Compare a run with it against one without on the same bundle: the switch's own cost is in the figures.
 * `--material still` records `scripts/still-material.html`, static text, instead of the moving material: a still screen,
 * whose capture delivers few pictures (the recording's idle path). `--studio` without `--camera` shows the screen's
 * preview with the camera switch held off, so no camera opens; `--studio-active` rests the pointer on the Studio during S,
 * where Power saving shows 10 frames a second instead of the 5 it shows while only looked at (plan 081, D1); L presses
 * Live preview with the pointer, so Power saving is at 10 there either way. `--studio-rate off|power|standard|smooth`
 * (plan 092, D1; default `power`, the Studio as it was before the choice) seeds the Studio's preview rate in
 * settings.json, restored with the other seeded keys: under `off` S and L show no preview, only the meters.
 *
 * Plan 091's isolating switches, each a development switch passed with `open --env` (launchd's copy is refused above):
 * `--audio off` records without sound (`RECORDSTUFF_CAPTURE_AUDIO=off`, native-host-process.ts `developmentCapture`,
 * which leaves the microphone off too), and `--capture-interval frame` asks capture for the frame interval instead of a
 * quarter of it (`RECORDSTUFF_CAPTURE_INTERVAL=frame`, native/capture/src/pacing.rs, macOS). Neither is a product
 * setting: they measure what one cause costs, and a recording made under them is not a pacing or sync baseline.
 *
 * It writes report.md and report.json under docs/verification/measurements/<time>-cpu/
 * (gitignored). Like the other runners it declares user activity and holds a display and
 * idle-sleep assertion for its lifetime, sets the seeded settings only while the app is quit and
 * restores the file once no RecordStuff process remains, quits the app normally and confirms that
 * it exited. Exit 0 when every judged check passed, 1 when one failed, 2 when blocked (no Command
 * Line Tools, a locked screen) and 130/143 when interrupted. macOS only; never shipped.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { APP_LOG_PATH, APP_SETTINGS_PATH, readAppSettings, writeAppSettings, runnerArgs } from "./lib/runner/runner-env.mts";
import { INTERRUPT_EXIT, electronPattern, escapeRegExp, pgrepPids, recordStuffPids, signalPids, command } from "./lib/runner/processes.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { confirmedIdle, recordingOutcome, settleRecording, waitForLog } from "./lib/acceptance/acceptance-runtime.mts";
import { acceleratorToKeystroke, createMaterialProfile, currentRunId, keystrokeScript, lastStartIndex, materialOpenArgs, registeredAccelerator, removeMaterialProfile } from "./lib/acceptance/acceptance.mts";
import {
  CpuSampler, ENCODER_SERVICE, IDLE_ROLES, afterStudio, SamplerBlockedError, SamplerInterruptedError, checkBaselines, compileSampler, cpuBaseline, intervals, judgeCoverage, judgeIdle, judgePlayback, judgeRecording, judgeRoles,
  judgeSettingsOpen, judgeSteadyState, machineModel, readRoleTree, readRoles, roleText, summarize, type RoleCounts, type Summary, type Verdict,
} from "./lib/verification/cpu-sampler.mts";
import { DESKTOP_BLOCKED_EXIT, DesktopBlockedError, beginDesktopRound } from "./lib/runner/desktop-session.mts";
import { launchdCaptureVariables } from "./lib/runner/capture-engine.mts";
import { cameraPreviewOn } from "../src/shared/camera-preview.ts";
import { LogReader, type LogCursor } from "./lib/runner/log-reader.mts";
import { AccessibilityBlockedError, FLAG, KEY, centre, osascriptAx } from "./lib/runner/native-ax.mts";
import { parseSessionRecord } from "./lib/runner/session-records.mts";
import { percentile } from "./lib/verification/stats.mts";
import { roundExit } from "./lib/runner/round-exit.mts";
import { DIAGNOSTICS_ENV } from "../src/shared/pipeline-histogram.ts";
import { formatSession, mergeSessions, parsePipelineLog, summarizeSession, type PipelineSession, type SessionSummary } from "./lib/verification/pipeline-report.mts";
import { developmentAppPath } from "./lib/runner/verification-timing.mts";
import { SETTINGS_SHORTCUT } from "../src/shared/hotkey.ts";
import { isLanguage, translate, type Language } from "../src/shared/i18n.ts";
import { TrayDriver } from "./lib/acceptance/tray-driver.mts";
import { recordingCardOpenId } from "./lib/acceptance/tray-acceptance.mts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = developmentAppPath(REPO_ROOT);
const EXECUTABLE = path.join(BUNDLE, "Contents/MacOS/RecordStuff");
/** Names the bundle's status-item window, where the tray driver clicks (clickTarget in tray-driver.mts). */
const BUNDLE_ID = (): string => spawnSync("plutil", ["-extract", "CFBundleIdentifier", "raw", path.join(BUNDLE, "Contents/Info.plist")], { encoding: "utf8" }).stdout?.trim() || "com.ericts.record";
const ELECTRON_APP = path.join(REPO_ROOT, "node_modules/electron/dist/Electron.app");
const ELECTRON_APP_REAL = fs.existsSync(ELECTRON_APP) ? fs.realpathSync(ELECTRON_APP) : ELECTRON_APP;
const LOG_PATH = APP_LOG_PATH;
const SETTINGS_PATH = APP_SETTINGS_PATH;
const MATERIALS = { moving: path.join(REPO_ROOT, "scripts/test-material.html"), still: path.join(REPO_ROOT, "scripts/still-material.html") } as const;
const RECORDING_SECONDS = 60;
const SETTINGS_MINUTES = 3;
/** Judged after a 5-second settle, inside the 60-second recording it plays. */
const PLAYBACK_SECONDS = 50;

const usage = `usage: pnpm measure:cpu [-- --minutes N] [--fps 60] [--repeat N (odd, 1-9)] [--skip-recording] [--skip-settings] [--skip-playback] [--hover-card] [--camera <value> (with --skip-settings --skip-playback)] [--studio [--studio-active] [--studio-rate off|power|standard|smooth] (with --skip-settings --skip-playback)] [--material moving|still] [--audio off] [--capture-interval frame] [--diagnostics] [--profile] [--out <dir>]`;
let minutes = 5, repeat = 1, with60 = false, skipRecording = false, skipSettings = false, skipPlayback = false, hoverCard = false;
let outDir: string | undefined;
let camera: string | undefined;
let studio = false;
/** Plan 083: the pointer rests on the Studio during S, and each session's pipeline figures are logged and reported. */
let studioActive = false;
/** Plan 092: the Studio's preview rate, seeded for the round. */
const STUDIO_RATES = ["off", "power", "standard", "smooth"] as const;
let studioRate: (typeof STUDIO_RATES)[number] | undefined;
/** What each rate shows while the Studio is only looked at, and while the pointer is on it. */
const STUDIO_RATE_FPS = { off: [0, 0], power: [5, 10], standard: [10, 10], smooth: [15, 15] } as const;
let diagnostics = false;
let materialKind: keyof typeof MATERIALS = "moving";
/** Plan 091: record without sound, and ask capture for the frame interval. */
let audioOff = false;
let frameInterval = false;
/** Plan 081 step 1: `sample` each of the app's processes for 10 s inside every recording and Live preview. */
let profileProcesses = false;
/** Whether `--camera` opens the preview page, which `cameraPreviewOn` decides as the app does. */
let cameraPreview = false;
/** A role contract that also allows the camera prototype's preview page, one renderer, and nothing else more. */
const withPreviewPage = (contract: { required: readonly string[]; allowed: Readonly<Record<string, number>> }) =>
  ({ required: contract.required, allowed: { ...contract.allowed, renderer: (contract.allowed["renderer"] ?? 0) + 1 } });
const argv = runnerArgs();
const roles = IDLE_ROLES;
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--minutes") minutes = Number(argv[++i]);
  else if (arg === "--repeat") repeat = Number(argv[++i]);
  else if (arg === "--fps" && argv[i + 1] === "60") { with60 = true; i += 1; }
  else if (arg === "--skip-recording") skipRecording = true;
  else if (arg === "--skip-settings") skipSettings = true;
  else if (arg === "--skip-playback") skipPlayback = true;
  else if (arg === "--hover-card") hoverCard = true;
  else if (arg === "--camera" && argv[i + 1] && !argv[i + 1]!.startsWith("--")) camera = argv[++i];
  else if (arg === "--studio") studio = true;
  else if (arg === "--studio-active") studioActive = true;
  else if (arg === "--studio-rate" && STUDIO_RATES.includes(argv[i + 1] as (typeof STUDIO_RATES)[number])) studioRate = argv[++i] as (typeof STUDIO_RATES)[number];
  else if (arg === "--diagnostics") diagnostics = true;
  else if (arg === "--material" && (argv[i + 1] === "moving" || argv[i + 1] === "still")) materialKind = argv[++i] as keyof typeof MATERIALS;
  else if (arg === "--profile") profileProcesses = true;
  else if (arg === "--audio" && argv[i + 1] === "off") { audioOff = true; i += 1; }
  else if (arg === "--capture-interval" && argv[i + 1] === "frame") { frameInterval = true; i += 1; }
  else if (arg === "--out" && argv[i + 1] && !argv[i + 1]!.startsWith("--")) outDir = argv[++i];
  else { console.error(usage); process.exit(2); }
}
// An odd count, so the median is one run's own figure and its breakdown.
if (!(minutes > 0 && minutes <= 60) || !Number.isInteger(repeat) || repeat < 1 || repeat > 9 || repeat % 2 === 0) { console.error(usage); process.exit(2); }
if (camera !== undefined && (!skipSettings || !skipPlayback || /[\s]/.test(camera))) { console.error(usage); process.exit(2); }
// The Studio's window stays open between its scenarios and C's or P's, whose role contracts do not allow its services.
if (studio && (skipRecording || !skipSettings || !skipPlayback)) { console.error(usage); process.exit(2); }
if ((studioActive || studioRate !== undefined) && !studio) { console.error(usage); process.exit(2); }
const shownRate = studioRate ?? "power";
const MATERIAL = MATERIALS[materialKind];
cameraPreview = camera !== undefined && cameraPreviewOn({ RECORDSTUFF_CAMERA_PROTOTYPE: camera });

const controller = new AbortController();
let interruptedBy: keyof typeof INTERRUPT_EXIT | undefined;
for (const name of ["SIGINT", "SIGTERM"] as const) {
  process.on(name, () => {
    interruptedBy ??= name;
    controller.abort(new Error(`interrupted by ${name}`));
  });
}
const sleep = (ms: number): Promise<void> => delay(ms, undefined, { signal: controller.signal });
const log = new LogReader(LOG_PATH);
const now = (): string => new Date().toISOString();
const events: string[] = [];
const note = (text: string): void => { events.push(`${now()} ${text}`); console.log(text); };

class Failure extends Error {}
const fail = (message: string): never => { throw new Failure(message); };

function running(): number | undefined {
  return recordStuffPids()[0];
}
/** This checkout's development app shares the bundle's settings.json and userData lock. */
const developmentRunning = (): boolean => pgrepPids(electronPattern(ELECTRON_APP_REAL, "bundle")).length > 0;

async function waitUntilGone(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (running() !== undefined) {
    if (Date.now() > deadline) return false;
    await delay(200);
  }
  return true;
}

/** Set once `open` was asked to launch the bundle, so cleanup waits for an app still on its way. */
let launchIssued = false;
/** How long after a launch request the app may still appear. */
const LAUNCH_SETTLE_MS = 10_000;

/** Launches the bundle and waits for idle and settled startup work: history loaded and the update check done or skipped. */
async function launch(): Promise<{ pid: number; run: string; recordingKey: string }> {
  const from = log.end();
  launchIssued = true;
  const env = [...(camera === undefined ? [] : [`RECORDSTUFF_CAMERA_PROTOTYPE=${camera}`]), ...(diagnostics ? [`${DIAGNOSTICS_ENV}=1`] : []),
    ...(audioOff ? ["RECORDSTUFF_CAPTURE_AUDIO=off"] : []), ...(frameInterval ? ["RECORDSTUFF_CAPTURE_INTERVAL=frame"] : [])];
  await command("open", [...env.flatMap((value) => ["--env", value]), "-a", BUNDLE], AbortSignal.timeout(15_000));
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
  // Each wait is bounded by the launch's shared 60 s rather than its own default.
  const start = await waitForLog(log, from, /\] start: /, "`start:`", signal, 60_000);
  await waitForLog(log, start.at, /\] ready;/, "`ready;`", signal, 60_000);
  await waitForLog(log, start.at, /recording history: (loaded|load failed)/, "the history load", signal, 60_000);
  // The check's outcome or its skip; `feed failed …; trying GitHub` is the check still running.
  await waitForLog(log, start.at, /\] updates: (launch check skipped|current;|available;|check failed:)/, "the launch update check or its skip", signal, 60_000);
  // Bounded like the waits above: without screen permission the app never reports idle.
  while (!confirmedIdle(log.since(start.at).lines.map((line) => line.text))) {
    if (signal.aborted && !controller.signal.aborted) fail("RecordStuff did not confirm idle with screen-recording permission within 60 s of launch");
    await sleep(200);
  }
  const lines = log.since(start.at).lines.map((line) => line.text);
  const pid = running() ?? fail("RecordStuff did not stay running after launch");
  launchIssued = false;
  return { pid, run: currentRunId([start.line, ...lines]) ?? "?", recordingKey: registeredAccelerator([start.line, ...lines]) ?? fail("the app registered no recording shortcut") };
}

async function sendKeys(accelerator: string): Promise<void> {
  const keystroke = acceleratorToKeystroke(accelerator) ?? fail(`cannot type ${accelerator}`);
  await command("osascript", ["-e", keystrokeScript(keystroke)], AbortSignal.timeout(5000), 5000);
}

/**
 * The seeded keys, `countdown`, `display` and `quality`, written only while the app is quit (it
 * reads the file at launch and writes its whole copy on every save) and set back to their original
 * values once no process can write them again; anything else the app saved meanwhile is kept. The
 * display is the primary one because the material opens there.
 */
const SEEDED_KEYS = ["countdown", "display", "quality", "camera", "cameraDevice", "studioPreview"] as const;
let originalSettings: Buffer | undefined;
let seeded = false;
const readSettings = (): Record<string, unknown> => readAppSettings(SETTINGS_PATH) ?? {};
const writeSettings = (next: Record<string, unknown>): void => writeAppSettings(next, SETTINGS_PATH);
function seed(frameRate: 30 | 60): void {
  if (running() !== undefined || developmentRunning()) fail("refusing to change settings.json while RecordStuff runs");
  originalSettings ??= fs.existsSync(SETTINGS_PATH) ? fs.readFileSync(SETTINGS_PATH) : Buffer.alloc(0);
  const current = readSettings();
  if (!Object.keys(current).length) fail(`no ${SETTINGS_PATH}: launch RecordStuff once and choose an output folder first`);
  const quality = { ...(current["quality"] as Record<string, unknown> | undefined), videoQuality: "standard", resolutionCap: "source", frameRate };
  // `--camera`: the Camera switch on (plan 075), the device the value names if it names one; the value itself, in the
  // launch's environment, makes the switch available and says whether preview frames are made.
  const device = camera === undefined ? undefined : /(?:^|,)\s*device\s*=\s*([^,]+)/.exec(camera)?.[1]?.trim();
  // Without `--camera` the switch is held off, so no recording or Studio of the round opens a camera.
  const cameraSettings = camera === undefined ? { camera: false } : { camera: true, ...(device ? { cameraDevice: { id: device, label: device } } : {}) };
  // `--studio`: the preview at the round's rate (plan 092), composed; the last rate shown is kept as the app keeps it.
  const studioSettings = studio ? { studioPreview: { rate: shownRate, view: "composed" } } : {};
  writeSettings({ ...current, countdown: 0, display: { kind: "primary" }, quality, ...cameraSettings, ...studioSettings });
  seeded = true;
}
function restoreSettings(): string | undefined {
  if (!seeded || !originalSettings?.length) return undefined;
  if (running() !== undefined) return "RecordStuff is still running, so it could write the seeded values again";
  const original = JSON.parse(originalSettings.toString("utf8")) as Record<string, unknown>;
  const next = readSettings();
  for (const key of SEEDED_KEYS) {
    if (key in original) next[key] = original[key]; else delete next[key];
  }
  writeSettings(next);
  seeded = false;
  return undefined;
}

async function quitApp(): Promise<void> {
  // A launch already requested can still bring the app up after an interruption; wait for it, apart from the interrupt.
  if (launchIssued && running() === undefined) {
    for (const deadline = Date.now() + LAUNCH_SETTLE_MS; running() === undefined && Date.now() < deadline;) await delay(250);
  }
  if (running() === undefined) return;
  await command("osascript", ["-e", `tell application ${JSON.stringify(BUNDLE)} to quit`], AbortSignal.timeout(15_000));
  if (!await waitUntilGone(30_000)) fail("RecordStuff did not exit within 30 s of Quit");
}

const terminal = (line: string): boolean => ["saved", "failed"].includes(parseSessionRecord(line)?.kind ?? "");

interface Scenario { name: string; key: string; summary: Summary; verdicts: Verdict[]; roles?: RoleCounts; note?: string; pipeline?: SessionSummary }
/** `roles` and `residentBytes` (the app's memory in total) five seconds after the save; `pipeline`, its figures (`--diagnostics`). */
interface Recording { fps: 30 | 60; file?: string; summary: Summary; roles: RoleCounts; residentBytes: number; samplerFailure: string | undefined; studio?: boolean; pipeline?: PipelineSession }

/**
 * Plan 083: the figures of the session that ended after `from`, waiting up to 15 s for the engine's line, which the
 * capture host logs once the file is finished or the session cancelled; undefined when it never came.
 */
async function pipelineSince(from: LogCursor, signal: AbortSignal): Promise<PipelineSession | undefined> {
  const engine = /capture host: diagnostics: \{"kind":"engine"/;
  await waitForLog(log, from, engine, "the session's pipeline figures", signal, 15_000).catch((error: unknown) => { if (signal.aborted) throw error; });
  // The page's last report comes as its port is let go, just after: a moment for it.
  await delay(1500, undefined, { signal });
  const report = parsePipelineLog(log.since(from).lines.map((line) => line.text));
  for (const problem of report.problems) note(`pipeline figures: ${problem}`);
  return report.sessions.findLast((session) => session.outcome !== undefined);
}
/** The check that a scenario's sessions logged their figures, with `--diagnostics`. */
const judgePipeline = (sessions: readonly (PipelineSession | undefined)[]): Verdict => {
  const missing = sessions.filter((session) => !session?.outcome || Object.keys(session.stages).length === 0).length;
  return { check: "Pipeline figures logged (--diagnostics)", limit: "every session", actual: `${sessions.length - missing} of ${sessions.length}`, verdict: missing ? "fail" : "pass" };
};

async function main(): Promise<number> {
  if (process.platform !== "darwin") fail("macOS only");
  if (!fs.existsSync(EXECUTABLE)) fail(`no bundle at ${BUNDLE}: build it with \`pnpm start:app\`, then quit it`);
  // A missing prerequisite, as the other runners say it (blocked, 2), not a failed round.
  if (running() !== undefined || developmentRunning()) {
    console.error("BLOCKED: RecordStuff or this project's Electron.app is running: quit it first; this runner launches the bundle itself and must own its process tree");
    return 2;
  }
  // Read after the recording scenarios: a malformed hand-edited file must stop the round before it records.
  try { checkBaselines(); } catch (cause) { fail(cause instanceof Error ? cause.message : String(cause)); }
  const stamp = now().replace(/[:.]/g, "-");
  const dir = outDir ?? path.join(REPO_ROOT, "docs/verification/measurements", `${stamp}-cpu`);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) fail("output directory is not empty");
  fs.mkdirSync(dir, { recursive: true });
  let binary: string;
  try { binary = compileSampler(dir); }
  catch (error) {
    if (error instanceof SamplerBlockedError) { console.error(`BLOCKED: ${error.message}`); return 2; }
    // Nothing was launched yet: an interrupt here exits 130/143 like one during the round.
    if (error instanceof SamplerInterruptedError) { console.error(`INTERRUPTED: ${error.message}; nothing was launched`); return INTERRUPT_EXIT[error.signal]; }
    throw error;
  }
  // `open` hands the bundle launchd's environment, which `scrubbedEnv` cannot reach: a capture switch left there would
  // record another source or sound than this round measures.
  const held = Object.entries(launchdCaptureVariables());
  if (held.length) {
    console.error(`BLOCKED: launchd holds ${held.map(([key, value]) => `${key}=${value}`).join(", ")}; unset it (\`launchctl unsetenv <name>\`) before this round`);
    return 2;
  }
  // Plan 083: a run without `--diagnostics` is the comparison's other half, which launchd's switch would turn on unseen.
  const launchdDiagnostics = spawnSync("launchctl", ["getenv", DIAGNOSTICS_ENV], { encoding: "utf8" }).stdout?.trim();
  if (launchdDiagnostics && !diagnostics) {
    console.error(`BLOCKED: launchd holds ${DIAGNOSTICS_ENV}=${launchdDiagnostics}; unset it (\`launchctl unsetenv ${DIAGNOSTICS_ENV}\`) or pass --diagnostics`);
    return 2;
  }
  const desktop = await beginDesktopRound().catch((cause: unknown) => {
    if (cause instanceof DesktopBlockedError) { console.error(`BLOCKED: ${cause.message}`); process.exit(DESKTOP_BLOCKED_EXIT); }
    throw cause;
  });
  const scenarios: Scenario[] = [];
  const recordings: Recording[] = [];
  const cleanup: string[] = [];
  let runError: unknown;
  let sampler: CpuSampler | undefined;
  let material: ChildProcess | undefined;
  const profile = createMaterialProfile("cpu");
  /** The material browser's processes; the profile path is escaped, so a `TMPDIR` with regex characters matches itself. */
  const materialPids = (): number[] => pgrepPids(escapeRegExp(profile));
  /** The recording in flight: its log cursor from before the start key and whether the stop key went out. */
  let active: { from: LogCursor; stopSent: boolean } | undefined;
  let recordingKey = "";
  let appPid = 0;
  const model = machineModel();
  const window = (fromMs: number, toMs: number, expectChanges = false): Summary => summarize(intervals(sampler!.samples), fromMs, toMs, expectChanges);
  /**
   * `--profile`: 10 s of `sample` on main, the GPU process, every renderer and the capture process, at once, written
   * beside the report; it perturbs the window it falls in, which the report's figures then include.
   */
  let profiled = 0;
  const profileAfter = (label: string, afterMs: number): Promise<void> | undefined => {
    if (!profileProcesses) return undefined;
    const run = async (): Promise<void> => {
      await sleep(afterMs);
      profiled += 1;
      const wanted = [...readRoleTree(appPid)].filter(([, role]) => ["main", "gpu", "renderer", "utility:node"].includes(role));
      await Promise.all(wanted.map(([pid, role]) => command("sample", [String(pid), "10", "-mayDie", "-file",
        path.join(dir, `profile-${String(profiled).padStart(2, "0")}-${label}-${role.replace(":", "-")}-${pid}.txt`)], AbortSignal.timeout(60_000), 60_000)
        .catch((cause: unknown) => note(`profile ${label} ${role} ${pid}: ${cause instanceof Error ? cause.message : String(cause)}`))));
      note(`profiled ${label}: ${wanted.map(([pid, role]) => `${role} ${pid}`).join(", ")}`);
    };
    // Never rejects: an interrupt during its delay is the caller's to handle, and a rejection nothing awaits yet would
    // end Node before the runner's cleanup.
    return run().catch((cause: unknown) => {
      if (!controller.signal.aborted) note(`profile ${label}: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  };

  const openMaterial = async (): Promise<void> => {
    if (material) return;
    material = spawn("open", materialOpenArgs(MATERIAL, profile), { stdio: "ignore" });
    note("test material opened fullscreen on the primary display; waiting 5 s");
    await sleep(5000);
  };
  /** Closes the material browser and confirms it exited; returns why not. */
  const closeMaterial = async (): Promise<string | undefined> => {
    const launcher = material;
    if (!launcher) return undefined;
    // `open` returns once Launch Services started Chrome; before that pkill could find nothing.
    if (launcher.exitCode === null && launcher.signalCode === null) await Promise.race([new Promise((resolve) => launcher.once("exit", resolve)), delay(10_000)]);
    for (let attempt = 0; attempt < 40 && materialPids().length > 0; attempt += 1) {
      signalPids(materialPids(), "SIGTERM");
      await delay(250);
    }
    if (materialPids().length > 0) return `the material browser (private profile ${profile}) is still running`;
    // A launch that never settled may still start Chrome and recreate the profile (run-matrix.mts): not closed yet.
    if (launcher.exitCode === null && launcher.signalCode === null) return "the material launch (`open`), which may still start Chrome";
    material = undefined;
    return undefined;
  };
  const closeMaterialOrFail = async (): Promise<void> => {
    const problem = await closeMaterial();
    if (problem) fail(problem);
  };
  const record = async (fps: 30 | 60, withStudio = false): Promise<void> => {
    const from = log.end();
    // Set before the key goes out, so cleanup settles a recording that the key may have started.
    active = { from, stopSent: false };
    await sendKeys(recordingKey);
    await waitForLog(log, from, /\] state → recording/, "`state → recording`", AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
    const started = Date.now();
    const profiling = profileAfter(`${withStudio ? "S" : "R"}${fps}`, 25_000);
    await sleep(RECORDING_SECONDS * 1000);
    await profiling;
    // A session that already ended must not get the key: on an idle app it starts a new recording.
    const ended = recordingOutcome(log.since(from).lines.map((line) => line.text));
    if (ended.settled) {
      active = undefined;
      throw new Failure(`the ${fps} fps recording ended before its stop key: ${ended.failure ?? (ended.saved ? `saved early (${ended.saved})` : "cancelled")}`);
    }
    const beforeStop = log.end();
    // Marked first: a stop key possibly delivered is never followed by a second toggle.
    active.stopSent = true;
    await sendKeys(recordingKey);
    const settled = await waitForLog(log, beforeStop, terminal, "the session's saved or failed record", AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]), 60_000);
    active = undefined;
    const record = parseSessionRecord(settled.line);
    const file = record?.kind === "saved" ? record.path : undefined;
    if (record?.kind === "failed") fail(`the ${fps} fps recording failed: ${settled.line}`);
    const summary = window(started + 5000, started + (RECORDING_SECONDS - 5) * 1000);
    const pipeline = diagnostics ? await pipelineSince(from, controller.signal) : undefined;
    // The capture host and overlay are destroyed as the state settles; give their processes time to exit.
    await sleep(5000);
    const roles = readRoles(appPid);
    const residentBytes = (sampler!.samples.at(-1)?.procs ?? []).filter((p) => !p.followed).reduce((total, p) => total + p.resident_bytes, 0);
    recordings.push({ fps, ...(file ? { file } : {}), summary, roles, residentBytes, samplerFailure: sampler!.failure, ...(withStudio ? { studio: true } : {}), ...(pipeline ? { pipeline } : {}) });
    note(`recording at ${fps} fps: average ${summary.cpuPercent.average.toFixed(1)}%, 95th ${summary.cpuPercent.p95.toFixed(1)}%, encoder ${summary.followed.cpuPercent.average.toFixed(1)}%; ${file ?? "no file"}; then ${roleText(roles)}`);
  };
  // After the Studio its two Chromium services stay (plan 082, D2): R's contract allows them, and its check says so.
  const recordingRoles = cameraPreview ? withPreviewPage(roles.afterRecording) : roles.afterRecording;
  const afterRecordingRoles = studio ? afterStudio(recordingRoles) : recordingRoles;
  const medianRecording = (fps: 30 | 60): void => {
    const set = recordings.filter((r) => r.fps === fps && !r.studio);
    if (!set.length) return;
    const averages = set.map((r) => r.summary.cpuPercent.average);
    // Nearest rank, not the midpoint median: with an odd count it is one run's own figure.
    const median = percentile(averages, 0.5);
    const chosen = set.find((r) => r.summary.cpuPercent.average === median) ?? set[0]!;
    scenarios.push({ name: `R. Recording at ${fps} fps (median of ${set.length})`, key: `recording${fps}`, summary: chosen.summary,
      verdicts: [...judgeRecording(chosen.summary, fps, cpuBaseline(`measure:cpu recording ${fps}`, model)),
        ...set.map((r, i) => ({ ...judgeCoverage(r.summary, RECORDING_SECONDS - 10, r.samplerFailure), check: `Sampled coverage, run ${i + 1}` })),
        { ...judgeRoles(set.at(-1)!.roles, afterRecordingRoles), check: `Process roles 5 s after the last save${studio ? " (the Studio's utility:video_capture and utility:audio allowed)" : ""}` },
        judgeSteadyState(set.map((r) => r.roles)), ...(diagnostics ? [judgePipeline(set.map((r) => r.pipeline))] : [])],
      ...(diagnostics ? { pipeline: summarizeSession(mergeSessions(`R. ${fps} fps, ${set.length} run(s)`, set.flatMap((r) => r.pipeline ? [r.pipeline] : []))) } : {}),
      note: `Run averages: ${averages.map((a) => `${a.toFixed(1)}%`).join(", ")}; the median run's breakdown is shown. App memory 5 s after each save: ${set.map((r) => mb(r.residentBytes)).join(", ")}.` });
  };

  /** The median run of a set, by its average: with an odd count, one run's own figure. */
  const medianOf = (set: Recording[]): Recording | undefined => {
    if (!set.length) return undefined;
    const median = percentile(set.map((r) => r.summary.cpuPercent.average), 0.5);
    return set.find((r) => r.summary.cpuPercent.average === median) ?? set[0];
  };
  /** D18's camera budgets: a recording at 30 fps at most 20% of a core, at 60 fps 25%; a Live preview the same. */
  const cameraBudget = (fps: 30 | 60): number => (fps === 30 ? 20 : 25);
  /**
   * Clicks the Settings element titled by one of `titles`, read through Chromium's accessibility tree, which is turned
   * off again at once so it costs nothing measured; fails when it is not there.
   */
  /** Runs a step, its failure saying which it was: a timeout's own message names none. */
  const step = async <T,>(what: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error(`${what}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };
  const clickNamed = async (titles: readonly string[], what: string): Promise<void> => {
    // Longer than the helper's 10 s: the first read of a busy page's tree, a preview and meters drawing, can take that.
    const ax = osascriptAx(controller.signal, 30_000);
    await ax.enableWebAccessibility(appPid);
    let frame: { x: number; y: number; width: number; height: number } | undefined;
    try {
      for (let attempt = 0; attempt < 20 && !frame; attempt += 1) {
        const layout = await ax.layout(appPid, "RecordStuff", { width: 10_000, height: 10_000 });
        frame = layout.clickable.find((element) => titles.includes(element.title))?.frame;
        if (!frame) await sleep(250);
      }
    } finally {
      await ax.enableWebAccessibility(appPid, false);
    }
    if (!frame) fail(`${what}: no element titled ${titles.join(" or ")} in Settings`);
    const point = centre(frame!);
    await ax.mouse("left", point.x, point.y);
  };
  let studioDisplay = "unknown";
  let studioOnAnotherDisplay = false;
  // The primary display's size, in the top-left coordinates the window frames use: a window off it, on any side, is on another.
  const [primaryWidth = 0, primaryHeight = 0] = spawnSync("osascript", ["-l", "JavaScript", "-e",
    'ObjC.import("AppKit"); const f = $.NSScreen.screens.objectAtIndex(0).frame; `${f.size.width},${f.size.height}`'], { encoding: "utf8" }).stdout.trim().split(",").map(Number);
  /**
   * Opens the Recording Studio from the tray's Open Recording Studio… (D19), as a person does, so S measures a page whose
   * accessibility tree was never asked for: Live preview's button, which only that tree finds, is pressed after S.
   */
  const openStudio = async (): Promise<void> => {
    const stored = readSettings()["language"];
    const language: Language = isLanguage(stored) ? stored : "en";
    const tray = new TrayDriver(osascriptAx(controller.signal), appPid, controller.signal, undefined, BUNDLE_ID());
    await tray.open();
    await tray.select(translate("Open Recording Studio…", language));
    await sleep(3000);
    let settings = (await osascriptAx(controller.signal).windows(appPid)).windows.find((window) => window.title === "RecordStuff");
    if (!settings) fail("the Recording Studio: Settings did not open");
    // The window opens on the display under the pointer, the primary one with the tray's menu: moved to another
    // display, so the material's full screen neither hides it (a page out of sight shows and costs nothing) nor is hidden.
    const aside = await command("osascript", ["-l", "JavaScript", "-e", `ObjC.import("AppKit");
      const screens = $.NSScreen.screens, main = screens.objectAtIndex(0).frame;
      let target = null;
      for (let i = 1; i < screens.count; i++) { const f = screens.objectAtIndex(i).frame; target = { x: f.origin.x + 40, y: main.size.height - (f.origin.y + f.size.height) + 80 }; break; }
      if (target) { const p = Application("System Events").processes.whose({ unixId: ${appPid} })[0]; p.windows[0].position = [Math.round(target.x), Math.round(target.y)]; }
      JSON.stringify(target)`], AbortSignal.timeout(10_000)).then((output) => output.trim(), () => "null");
    if (aside === "null") note("the Recording Studio: no other display to stand on; S and L measure a window the material hides");
    await sleep(1500);
    settings = (await osascriptAx(controller.signal).windows(appPid)).windows.find((window) => window.title === "RecordStuff") ?? settings;
    const frame = settings!.frame;
    // An unread primary size judges nothing off it.
    studioOnAnotherDisplay = aside !== "null" && frame !== undefined && primaryWidth > 0 && primaryHeight > 0 && (frame.x < 0 || frame.y < 0 || frame.x >= primaryWidth || frame.y >= primaryHeight);
    studioDisplay = frame ? `${frame.x},${frame.y} ${frame.width}x${frame.height}${studioOnAnotherDisplay ? " (on another display)" : " (on the primary display, behind the material: S and L are not valid)"}` : "unknown";
    note(`the Recording Studio open in Settings at ${studioDisplay}`);
  };
  /** S: the recordings again, with the Studio showing the engine's preview and the meters (D18: ≤ 8 points over R). */
  const medianStudio = (fps: 30 | 60): void => {
    const plain = medianOf(recordings.filter((r) => r.fps === fps && !r.studio));
    const chosen = medianOf(recordings.filter((r) => r.fps === fps && r.studio));
    if (!chosen) return;
    const extra = plain ? chosen.summary.cpuPercent.average - plain.summary.cpuPercent.average : Number.NaN;
    const set = recordings.filter((r) => r.fps === fps && r.studio);
    scenarios.push({ name: `S. Recording at ${fps} fps with the Recording Studio showing it${studioActive ? " (the pointer on it)" : ""}`, key: `studioRecording${fps}`, summary: chosen.summary,
      note: `The Studio window at ${studioDisplay}; the preview ${shownRate === "off" ? "off" : `at ${shownRate}`}; ${studioActive ? `the pointer rested on it (${STUDIO_RATE_FPS[shownRate][1]} frames a second)` : `the pointer off it (${STUDIO_RATE_FPS[shownRate][0]} frames a second once it rests)`}${camera === undefined ? "; no camera composed" : ""}.`,
      ...(diagnostics ? { pipeline: summarizeSession(mergeSessions(`S. ${fps} fps, ${set.length} run(s)`, set.flatMap((r) => r.pipeline ? [r.pipeline] : []))) } : {}),
      verdicts: [judgeCoverage(chosen.summary, RECORDING_SECONDS - 10, chosen.samplerFailure),
        { check: "Over R's median at the same rate (D18)", limit: "≤ 8 points", actual: plain ? `${extra.toFixed(1)} points (${chosen.summary.cpuPercent.average.toFixed(1)}% against ${plain.summary.cpuPercent.average.toFixed(1)}%)` : "no R to compare",
          verdict: !studioOnAnotherDisplay || !plain ? "report" : extra <= 8 ? "pass" : "fail" },
        { check: `Average ${camera === undefined ? "within the camera's budget, no camera composed" : "with the camera"} (D18)`, limit: `≤ ${cameraBudget(fps) + 8}%`, actual: `${chosen.summary.cpuPercent.average.toFixed(1)}%`,
          verdict: chosen.summary.cpuPercent.average <= cameraBudget(fps) + 8 ? "pass" : "fail" },
        ...(diagnostics ? [judgePipeline(set.map((r) => r.pipeline))] : [])] });
    note(`S at ${fps} fps: average ${chosen.summary.cpuPercent.average.toFixed(1)}%${plain ? `, ${extra.toFixed(1)} points over R` : ""}`);
  };
  /** L: a Live preview held for 50 s (D20), judged as a recording with the camera at the launch's rate (D18). */
  const livePreview = async (fps: 30 | 60): Promise<void> => {
    const from = log.end();
    // RecordStuff in front first: a click on an inactive window only activates it on macOS, which plan 082's D1 keeps,
    // so the material in front had cost every round a first press that did nothing. A click that still reaches no
    // button (2026-10-18: a run aborted with none logged) is tried again, each step named.
    await step("L: bringing RecordStuff to the front", () => command("osascript", ["-e", `tell application id ${JSON.stringify(BUNDLE_ID())} to activate`], AbortSignal.timeout(10_000)));
    await sleep(800);
    for (let attempt = 1; ; attempt += 1) {
      const clickFrom = log.end();
      await step(`L: pressing Live preview (attempt ${attempt})`, () => clickNamed(["Live preview", "即時預覽"], "Live preview"));
      // waitForLog's own timeout, which says what it waited for: an AbortSignal.timeout fires inside its delay as a
      // bare "The operation was aborted".
      const started = await waitForLog(log, clickFrom, /recorder: session \S+ prepared after|studio: Live preview not started/, "the Live preview's start",
        controller.signal, 15_000).then((hit) => hit.line, (error: unknown) => { if (controller.signal.aborted) throw error; return undefined; });
      if (started?.includes("prepared after")) break;
      if (attempt === 3) fail(`L: Live preview did not start after ${attempt} presses${started ? `: ${started}` : " (nothing logged)"}`);
      note(`L: Live preview did not start${started ? `: ${started}` : " within 15 s"}; pressing it again`);
    }
    note(`L. Live preview at ${fps} fps prepared; settling 5 s`);
    await sleep(5000);
    const lFrom = Date.now();
    const profiling = profileAfter(`L${fps}`, 20_000);
    await sleep(50_000);
    await profiling;
    const summary = window(lFrom, Date.now());
    const wrote = log.since(from).lines.some((line) => /\] state → recording|record sent/.test(line.text));
    const verdicts: Verdict[] = [judgeCoverage(summary, 50, sampler!.failure),
      { check: `Average ${camera === undefined ? "within the camera's budget, no camera composed" : "with the camera"} (D18: a recording without the file)`, limit: `≤ ${cameraBudget(fps)}%`, actual: `${summary.cpuPercent.average.toFixed(1)}%`,
        verdict: summary.cpuPercent.average <= cameraBudget(fps) ? "pass" : "fail" },
      { check: "Nothing recorded", limit: "no record sent", actual: wrote ? "a recording began" : "none", verdict: wrote ? "fail" : "pass" }];
    const scenario: Scenario = { name: `L. Live preview at ${fps} fps in the Recording Studio`, key: `livePreview${fps}`, summary, note: `The Studio window at ${studioDisplay}.`, verdicts };
    scenarios.push(scenario);
    note(`L at ${fps} fps: average ${summary.cpuPercent.average.toFixed(1)}%`);
    const stopFrom = log.end();
    await step("L: pressing Live preview again to stop it", () => clickNamed(["Live preview", "即時預覽"], "Live preview"));
    await step("L: the Live preview let go of", () => waitForLog(log, stopFrom, /cancelled \(preview\)/, "the Live preview let go of", controller.signal, 15_000));
    if (diagnostics) {
      // Its figures come once the cancelled session is let go: after the scenario's own window.
      const pipeline = await pipelineSince(from, controller.signal);
      verdicts.push(judgePipeline([pipeline]));
      if (pipeline) scenario.pipeline = summarizeSession(mergeSessions(`L. ${fps} fps`, [pipeline]));
    }
  };
  /**
   * Closes Settings before R, which measures the recording with it closed: ⌘W while it is focused in front, then its
   * window's close button for one still open (plan 083's round of 2026-10-23: after L, ⌘W left the Studio open, so R ran
   * with it showing the preview); a window that stays fails the round rather than measuring R with it.
   */
  const closeStudio = async (): Promise<void> => {
    const open = async (): Promise<boolean> => (await osascriptAx(controller.signal).windows(appPid)).windows.some((window) => window.title === "RecordStuff");
    if (await settingsInFront()) {
      await command("osascript", ["-e", 'tell application "System Events" to keystroke "w" using {command down}'], AbortSignal.timeout(5000));
      await sleep(1000);
    }
    if (!await open()) return;
    const button = (await osascriptAx(controller.signal).layout(appPid, "RecordStuff", { width: 1, height: 1 })).controls.find((control) => control.name === "AXCloseButton")?.frame;
    if (button) {
      const point = centre(button);
      await osascriptAx(controller.signal).mouse("left", point.x, point.y);
      await sleep(1500);
    }
    if (await open()) fail("the Recording Studio did not close before R, which must run with Settings closed");
    note("the Recording Studio closed with its window's close button");
  };
  /**
   * The Studio's scenarios at the launch's rate. The Studio opens from the tray before the material does, since the
   * material's full screen hides the menu bar the tray is in; then S and L over the material, and the Studio closes
   * before R, which runs with Settings closed.
   */
  const studioScenarios = async (fps: 30 | 60): Promise<void> => {
    await openStudio();
    await openMaterial();
    if (studioActive) {
      // On the Studio's window, after the material took the front: the pointer over it is someone working in it.
      const frame = (await osascriptAx(controller.signal).windows(appPid)).windows.find((window) => window.title === "RecordStuff")?.frame;
      if (!frame) fail("--studio-active: the Studio's window was not found to rest the pointer on");
      const point = centre(frame!);
      await osascriptAx(controller.signal).move(point.x, point.y);
      note(`S: the pointer rests on the Studio at ${point.x},${point.y}`);
    }
    for (let i = 0; i < repeat; i += 1) await record(fps, true);
    await livePreview(fps);
    await closeStudio();
  };

  /** How the app saved `file`, from its log: `to plain MP4` or `kept fragmented (…)`. */
  const finalizedAs = (file: string): string | undefined => {
    const lines = log.all();
    const session = lines.map((line) => /recorder: session (\S+) file finalized (.+)$/.exec(line)).findLast((match) => match?.[2] === file)?.[1];
    if (!session) return undefined;
    const timing = new RegExp(`recorder: session ${escapeRegExp(session)} finalize timing: .*?finalize \\S+ ms (to plain MP4|kept fragmented \\(.*?\\))`);
    return lines.map((line) => timing.exec(line)?.[1]).findLast((text) => text !== undefined);
  };
  /** Whether RecordStuff is frontmost with Settings focused, so a key reaches the page and ⌘W no other app. */
  const settingsInFront = async (): Promise<boolean> => {
    const front = await osascriptAx(controller.signal).windows(appPid);
    return front.frontmostPid === appPid && front.focusedWindow === "RecordStuff";
  };
  const playback = async (file: string): Promise<void> => {
    const ax = osascriptAx(controller.signal);
    const stored = readSettings()["language"];
    const language: Language = isLanguage(stored) ? stored : "en";
    const tray = new TrayDriver(ax, appPid, controller.signal, undefined, BUNDLE_ID());
    // From another app, as acceptance-tray's Show last recording case reaches it.
    await command("osascript", ["-e", 'tell application "Finder" to activate'], AbortSignal.timeout(5000));
    const from = log.end();
    await tray.open();
    await tray.select(translate("Show last recording", language));
    const entry = await waitForLog(log, from, /\] show last recording: (.*)$/, "the Show last recording entry", AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]));
    const target = /show last recording: Recordings with (.+)$/.exec(entry.line)?.[1];
    if (target !== file) fail(`Show last recording named ${target ?? "no recording"}, not this run's save ${file}`);
    await tray.until("RecordStuff with Settings focused in front", async () => (await settingsInFront()) || undefined);
    // Return must reach this file's Play button, which the page focuses once it has rendered the entry: read through
    // Chromium's accessibility tree, as acceptance-tray does, and turned off again so the tree's cost is not measured.
    const playId = recordingCardOpenId(file);
    await ax.enableWebAccessibility(appPid);
    try {
      await tray.until(`${path.basename(file)}'s Play button focused`, async () => ((await ax.windows(appPid)).focused?.domId === playId ? true : undefined), 10_000);
      if (!await settingsInFront()) fail("RecordStuff with Settings focused left the front before Return");
      await ax.key(KEY.return);
    } finally {
      await ax.enableWebAccessibility(appPid, false);
    }
    note(`P. Return on ${path.basename(file)}'s Play button; settling 5 s`);
    await sleep(5000);
    const pFrom = Date.now();
    await sleep(PLAYBACK_SECONDS * 1000);
    const summary = window(pFrom, Date.now());
    const container = finalizedAs(file);
    scenarios.push({ name: "P. Playback in the Settings player", key: "playback", summary, roles: readRoles(appPid), note: `Played ${file}.`,
      verdicts: [judgeCoverage(summary, PLAYBACK_SECONDS, sampler!.failure), ...judgePlayback(summary, readRoleTree(appPid)),
        { check: "The file played", limit: "saved as a plain MP4", actual: container ?? "no finalize timing in the log", verdict: container === "to plain MP4" ? "pass" : "fail" }] });
    note(`P: average ${summary.cpuPercent.average.toFixed(1)}%`);
    // Escape closes the player and ⌘W the window, each only while Settings is focused in front; the quit closes it otherwise.
    if (await settingsInFront()) {
      await ax.key(KEY.escape);
      await sleep(800);
      if (await settingsInFront()) { await ax.key(KEY.w, FLAG.command); await sleep(1000); }
    } else note("P: RecordStuff with Settings focused is not frontmost; the quit closes the player");
  };

  try {
    // Launch 1: idle, the 30 fps recordings, idle after them, Settings open and playback.
    seed(30);
    const first = await launch();
    recordingKey = first.recordingKey;
    appPid = first.pid;
    note(`RecordStuff pid ${first.pid}, run ${first.run}; sampling its process tree and ${ENCODER_SERVICE}`);
    sampler = new CpuSampler(binary, first.pid);
    note("A. warming up for 60 s after launch");
    await sleep(60_000);
    const aFrom = Date.now();
    await sleep(minutes * 60_000);
    const idleAfterLaunch = window(aFrom, Date.now());
    const launchRoles = readRoles(appPid);
    scenarios.push({ name: "A. Idle after launch, Settings closed", key: "idleAfterLaunch", summary: idleAfterLaunch, roles: launchRoles,
      verdicts: [judgeCoverage(idleAfterLaunch, minutes * 60, sampler.failure), ...judgeIdle(idleAfterLaunch), judgeRoles(launchRoles, roles.launch)] });
    note(`A: average ${idleAfterLaunch.cpuPercent.average.toFixed(3)}%, wake-ups ${idleAfterLaunch.wakeupsPerSecond.average.toFixed(2)}/s`);
    if (!skipRecording) {
      if (studio) await studioScenarios(30);
      await openMaterial();
      for (let i = 0; i < repeat; i += 1) await record(30);
      medianRecording(30);
      if (studio) medianStudio(30);
      await closeMaterialOrFail();
    }
    if (!skipRecording && camera !== undefined) note("B: left out with --camera (the preview page stays open)");
    if (!skipRecording && camera === undefined) {
      note("B. waiting 30 s after the last save");
      await sleep(30_000);
      const bFrom = Date.now();
      await sleep(minutes * 60_000);
      const idleAfter = window(bFrom, Date.now());
      const afterRoles = readRoles(appPid);
      const encoderQuiet = idleAfter.followed.cpuPercent.average < 0.1;
      const rolesVerdict = judgeRoles(afterRoles, afterRecordingRoles);
      // R's recordings only: S's were taken with the Studio's window open, whose renderer B no longer has.
      const steady = judgeSteadyState([...recordings.filter((r) => r.fps === 30 && !r.studio).map((r) => r.roles), afterRoles]);
      scenarios.push({ name: "B. Idle after the recording", key: "idleAfterRecording", summary: idleAfter, roles: afterRoles, verdicts: [
        judgeCoverage(idleAfter, minutes * 60, sampler.failure), ...judgeIdle(idleAfter),
        rolesVerdict, { ...steady, check: "Same roles after every recording and at the end of B" },
        { check: `${ENCODER_SERVICE} idle`, limit: "< 0.1% (the service is shared by the system)", actual: `${idleAfter.followed.cpuPercent.average.toFixed(3)}%`, verdict: encoderQuiet ? "pass" : "warn" }] });
      note(`B: average ${idleAfter.cpuPercent.average.toFixed(3)}%, roles ${roleText(afterRoles)} (${rolesVerdict.verdict}), steady state ${steady.verdict}`);
    }
    if (!skipSettings) {
      const beforeSettings = log.end();
      await sendKeys(SETTINGS_SHORTCUT);
      // Delivery is the app's own log line; the Settings renderer is the evidence that the window exists.
      await waitForLog(log, beforeSettings, /\] settings shortcut: .* pressed/, "the Settings shortcut's delivery", AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]));
      await sleep(2000);
      // A second renderer is the full-screen page loading hidden beside Settings on macOS (video-fullscreen.ts).
      if (!(readRoles(appPid)["renderer"] ?? 0)) fail("Settings did not open: the shortcut was delivered but no Settings renderer is running");
      // The pre-warmed renderer of a launch without recordings counts as one too, so the window itself is the evidence.
      const { windows } = await osascriptAx(controller.signal).windows(appPid);
      if (!windows.some((window) => window.title === "RecordStuff")) fail(`Settings did not open: RecordStuff shows no Settings window (${JSON.stringify(windows.map((window) => window.title))})`);
      await command("osascript", ["-e", 'tell application "Finder" to activate'], AbortSignal.timeout(5000));
      note("C. Settings open behind Finder; settling 10 s");
      await sleep(10_000);
      // What C measures depends on what Settings shows: a card's hover preview plays while the pointer rests on it, which
      // the scenario never arranges. Where the pointer and the window are, and a screenshot with the pointer, at both ends.
      // The pointer is parked on the menu bar, over no window, so the scenario measures Settings at rest wherever the
      // steps before it left the pointer; `--hover-card` rests it on the first card's picture instead, where a preview
      // played behind Finder until Settings stopped previewing without the focus (2026-10-15): it checks that it stays so.
      const settingsFrame = (await osascriptAx(controller.signal).windows(appPid)).windows.find((window) => window.title === "RecordStuff")?.frame;
      const park = hoverCard && settingsFrame
        ? { x: settingsFrame.x + Math.round(settingsFrame.width * 0.32), y: settingsFrame.y + Math.round(settingsFrame.height * 0.3) }
        : { x: 400, y: 10 };
      await command("osascript", ["-l", "JavaScript", "-e",
        `ObjC.import("CoreGraphics"); const e = $.CGEventCreateMouseEvent($(), 5, $.CGPointMake(${park.x}, ${park.y}), 0); $.CGEventPost(0, e); "moved"`],
      AbortSignal.timeout(5000)).catch(() => "");
      note(`C: pointer ${hoverCard ? "rested on the first card" : "parked on the menu bar"} at ${park.x},${park.y}`);
      await sleep(1000);
      const observeScene = async (when: string): Promise<void> => {
        const pointer = await command("osascript", ["-l", "JavaScript", "-e",
          'ObjC.import("AppKit"); const p = $.NSEvent.mouseLocation; const h = $.NSScreen.screens.objectAtIndex(0).frame.size.height; `${Math.round(p.x)},${Math.round(h - p.y)}`'],
        AbortSignal.timeout(5000)).then((output) => output.trim(), () => "unknown");
        const frame = (await osascriptAx(controller.signal).windows(appPid)).windows.find((window) => window.title === "RecordStuff")?.frame;
        const shot = path.join(dir, `settings-open-${when}.png`);
        const taken = await command("screencapture", ["-x", "-C", shot], AbortSignal.timeout(10_000)).then(() => true, () => false);
        note(`C ${when}: pointer at ${pointer}; Settings at ${frame ? `${frame.x},${frame.y} ${frame.width}x${frame.height}` : "unknown"}; ` +
          `${taken ? `screenshot ${path.relative(dir, shot)}` : "no screenshot"}`);
      };
      await observeScene("start");
      const cFrom = Date.now();
      await sleep(SETTINGS_MINUTES * 60_000);
      await observeScene("end");
      const settingsOpen = window(cFrom, Date.now());
      const settingsRoles = readRoles(appPid);
      scenarios.push({ name: "C. Settings open behind another app", key: "settingsOpen", summary: settingsOpen, roles: settingsRoles,
        verdicts: [judgeCoverage(settingsOpen, SETTINGS_MINUTES * 60, sampler.failure), ...judgeSettingsOpen(settingsOpen), judgeRoles(settingsRoles, roles.settingsOpen)] });
      note(`C: average ${settingsOpen.cpuPercent.average.toFixed(3)}%`);
      await sendKeys(SETTINGS_SHORTCUT);
      await sleep(800);
      // ⌘W goes to the frontmost app, which was Finder a moment ago: never send it unless RecordStuff is frontmost
      // with Settings focused (as acceptance-tray does). Otherwise the window stays open until the quit below.
      const front = await osascriptAx(controller.signal).windows(appPid);
      if (front.frontmostPid === appPid && front.focusedWindow === "RecordStuff") {
        await command("osascript", ["-e", 'tell application "System Events" to keystroke "w" using {command down}'], AbortSignal.timeout(5000));
        await sleep(1000);
      } else note(`C: RecordStuff with Settings focused is not frontmost (pid ${front.frontmostPid ?? "none"}); ⌘W not sent, the quit closes it`);
    }
    if (!skipPlayback) {
      const saved = recordings.filter((r) => r.fps === 30).at(-1)?.file;
      if (saved) await playback(saved);
      else note("P. skipped: this launch saved no recording to play");
    }
    await sampler.stop();
    await quitApp();
    // Launch 2: the 60 fps recordings.
    if (with60 && !skipRecording) {
      seed(60);
      const second = await launch();
      recordingKey = second.recordingKey;
      appPid = second.pid;
      sampler = new CpuSampler(binary, second.pid);
      note(`relaunched at 60 fps (pid ${second.pid}); warming up 20 s`);
      await sleep(20_000);
      if (studio) await studioScenarios(60);
      await openMaterial();
      for (let i = 0; i < repeat; i += 1) await record(60);
      medianRecording(60);
      if (studio) medianStudio(60);
      await closeMaterialOrFail();
      await sampler.stop();
      await quitApp();
    }
  } catch (error) {
    runError = error;
  } finally {
    try {
      if (active) {
        // Session-aware: toggles only while this recording is counting down or recording and no stop went out.
        const outcome = await settleRecording({ log, from: active.from, stop: () => sendKeys(recordingKey), stopSent: active.stopSent, signal: AbortSignal.timeout(60_000) });
        cleanup.push(outcome.neverStarted ? "the interrupted recording never started" : outcome.saved ? `stopped the interrupted recording: saved ${outcome.saved}` : "stopped the interrupted recording: it failed");
      }
    } catch (error) { cleanup.push(`could not stop the recording: ${String(error)}`); }
    // Nothing here may throw past the settings restore below.
    const materialProblem = await closeMaterial().catch((error: unknown) => `the material browser: ${String(error)}`);
    if (materialProblem) cleanup.push(`could not close ${materialProblem}`);
    else {
      const problem = await removeMaterialProfile(profile);
      // Worded for the exit code's cleanup check below: a profile left behind is incomplete cleanup.
      if (problem) cleanup.push(`could not remove the material profile: ${problem}`);
    }
    await sampler?.stop();
    try { await quitApp(); } catch (error) { cleanup.push(String(error)); }
    // The backup first, since the recovery message below points at it; a failed write must not skip the restore.
    try { if (originalSettings?.length) fs.writeFileSync(path.join(dir, "settings-before.json"), originalSettings); }
    catch (error) { cleanup.push(`could not write settings-before.json: ${String(error)}`); }
    let problem: string | undefined;
    try { problem = restoreSettings(); } catch (error) { problem = String(error); }
    if (problem) cleanup.push(`settings NOT restored: ${problem}; quit RecordStuff and restore ${SETTINGS_PATH} from the report folder's settings-before.json`);
    desktop.end();
  }

  const lines = log.all();
  const environment = {
    machine: model,
    chip: spawnSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).stdout.trim(),
    cores: os.cpus().length,
    macOS: spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout.trim(),
    electron: /electron (\S+);/.exec(lines[lastStartIndex(lines)] ?? "")?.[1] ?? "?",
    power: spawnSync("pmset", ["-g", "batt"], { encoding: "utf8" }).stdout.split("\n")[0]?.replace(/^Now drawing from /, "").replace(/'/g, "") ?? "?",
    displays: spawnSync("system_profiler", ["SPDisplaysDataType"], { encoding: "utf8" }).stdout.split("\n").filter((line) => /Resolution:|Main Display: Yes/.test(line)).map((line) => line.trim()),
    bundle: { path: BUNDLE, modified: fs.statSync(EXECUTABLE).mtime.toISOString() },
  };
  const failed = scenarios.flatMap((s) => s.verdicts).some((v) => v.verdict === "fail");
  // The same test as the exit code below: a report must not read PASS while the run exits 1 for its cleanup.
  const cleanupIncomplete = cleanup.some((line) => /NOT restored|could not|did not exit|still running/.test(line));
  // A missing Accessibility grant blocks what is left of the run; a budget already failed still fails it (round-exit.mts).
  const accessibility = runError instanceof AccessibilityBlockedError ? runError : undefined;
  const errored = Boolean(runError) && !accessibility;
  const locked = desktop.lockedAt !== undefined;
  const { outcome, code } = roundExit({ cleanupIncomplete, interrupted: interruptedBy, locked, failed: failed || errored, blocked: accessibility !== undefined });
  const result = cleanupIncomplete ? "INCOMPLETE CLEANUP (see Cleanup); the run exits 1"
    : outcome === "interrupted" ? `INTERRUPTED (${interruptedBy}); partial results only`
    : locked ? "BLOCKED (the screen locked)"
    : errored ? `ERROR: ${runError instanceof Error ? runError.message : String(runError)}`
    : outcome === "fail" ? `FAIL${accessibility ? `; later blocked (${accessibility.message})` : ""}`
    : accessibility ? `BLOCKED (${accessibility.message})` : "PASS";
  fs.writeFileSync(path.join(dir, "report.json"), `${JSON.stringify({ result, options: { minutes, repeat, fps60: with60, skipRecording, skipSettings, skipPlayback, camera: camera ?? null, studio, studioActive, studioRate: studio ? shownRate : null, material: materialKind, audio: audioOff ? "off" : "on", captureInterval: frameInterval ? "frame" : "quarter", diagnostics, profile: profileProcesses }, environment, scenarios, recordings, cleanup, events }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "report.md"), renderReport(result, environment, scenarios, recordings, cleanup));
  console.log(`Report ${path.relative(REPO_ROOT, dir)}/report.md`);
  console.log(result);
  return code;
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
function renderReport(result: string, environment: Record<string, unknown>, scenarios: Scenario[], recordings: Recording[], cleanup: string[]): string {
  const lines = [
    "# CPU budget (`pnpm measure:cpu`)", "",
    `Result: **${result}**. CPU is a percentage of one core (the machine has ${String(environment["cores"])} cores); wake-ups are idle plus interrupt wake-ups per second; the app is its main process and every descendant, with ${ENCODER_SERVICE} reported apart.`, "",
    ...(audioOff || frameInterval ? [`Development switches (plan 091): ${[audioOff ? "sound off" : "", frameInterval ? "capture asked for the frame interval" : ""].filter(Boolean).join(", ")}; not a baseline.`, ""] : []),
    "## Environment", "", "```json", JSON.stringify(environment, null, 2), "```", "",
  ];
  for (const scenario of scenarios) {
    const s = scenario.summary;
    lines.push(`## ${scenario.name}`, "", `${scenario.roles ? `Process roles at the end: ${roleText(scenario.roles)}. ` : ""}${s.judged} one-second intervals judged (${s.seconds.toFixed(0)} s); ${s.discarded.length} discarded because the app's processes changed${s.discarded.length ? `: ${s.discarded.map((d) => `+${d.added.join("+") || "—"} −${d.removed.join("−") || "—"}`).join("; ")}` : ""}. ${scenario.note ?? ""}`, "",
      "| Check | Limit | Actual | Verdict |", "| --- | --- | --- | --- |",
      ...scenario.verdicts.map((v) => `| ${v.check} | ${v.limit} | ${v.actual} | ${v.verdict} |`), "",
      `CPU average ${s.cpuPercent.average.toFixed(3)}%, 95th ${s.cpuPercent.p95.toFixed(3)}%, max ${s.cpuPercent.max.toFixed(3)}%; wake-ups ${s.wakeupsPerSecond.average.toFixed(2)}/s (95th ${s.wakeupsPerSecond.p95.toFixed(2)}); energy ${(s.energyWatts.average * 1000).toFixed(1)} mW; memory up to ${mb(s.maxResidentBytes)}; ${ENCODER_SERVICE} ${s.followed.cpuPercent.average.toFixed(3)}%.`, "",
      "| Process | PID | CPU average | 95th | Wake-ups/s | Memory |", "| --- | --- | --- | --- | --- | --- |",
      ...s.processes.slice(0, 10).map((p) => `| ${p.name}${p.followed ? " (followed)" : ""} | ${p.pid} | ${p.cpuPercent.average.toFixed(3)}% | ${p.cpuPercent.p95.toFixed(3)}% | ${p.wakeupsPerSecond.toFixed(2)} | ${mb(p.maxResidentBytes)} |`), "");
  }
  if (recordings.length) {
    lines.push("## Recordings", "", "| fps | CPU average | 95th | Encoder | Roles 5 s after the save | App memory then | File |", "| --- | --- | --- | --- | --- | --- | --- |",
      ...recordings.map((r) => `| ${r.fps} | ${r.summary.cpuPercent.average.toFixed(1)}% | ${r.summary.cpuPercent.p95.toFixed(1)}% | ${r.summary.followed.cpuPercent.average.toFixed(1)}% | ${roleText(r.roles)} | ${mb(r.residentBytes)} | ${r.file ?? "—"} |`), "");
  }
  const figures = scenarios.filter((scenario) => scenario.pipeline);
  if (figures.length) {
    lines.push("## Pipeline figures (`--diagnostics`)", "",
      "Per scenario, its sessions merged (plan 083): each stage in milliseconds on one clock in its process; the page's port delay on both processes' wall clock in whole milliseconds; drawn is into the canvas, not yet on the screen. Each recording's own are in report.json.", "",
      ...figures.map((scenario) => formatSession({ ...scenario.pipeline!, session: scenario.name })));
  }
  lines.push("## Cleanup", "", cleanup.length ? cleanup.map((line) => `- ${line}`).join("\n") : "Complete: RecordStuff exited, the seeded settings were restored and the material closed.", "",
    "## Events", "", ...events.map((event) => `- ${event}`), "");
  return lines.join("\n");
}

main().then((code) => process.exit(code), (error: unknown) => {
  console.error(error instanceof Failure ? `✗ ${error.message}` : error);
  process.exit(1);
});
