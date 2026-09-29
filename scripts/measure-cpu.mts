/**
 * `pnpm measure:cpu [-- --minutes 5] [--fps 60] [--repeat N] [--skip-recording] [--skip-settings] [--out <dir>]`
 *
 * The CPU budget on the packaged app (plan 049, docs/system-design/tooling.md#cpu-budget).
 * Build and quit the bundle first (`pnpm start:app`, then Quit); this runner refuses to start
 * while any RecordStuff runs, launches dist/mac-arm64/RecordStuff.app itself and samples its
 * process tree once a second with the shared sampler (scripts/lib/cpu-sampler.mts):
 *
 * - A. Idle after launch, Settings closed: `--minutes` (5) after a 60-second warm-up.
 * - R. Recording: a 60-second recording started and stopped with the recording shortcut over
 *   the moving test material, judged over seconds 5 to 55, VTEncoderXPCService followed. The
 *   countdown is seeded Off, the recorded display to the primary one (where the material opens)
 *   and the quality to Standard, Source, 30 fps; `--fps 60` relaunches at 60 fps for a second
 *   set; `--repeat N` (odd) records each set N times and judges the median run.
 * - B. Idle after the recording: from 30 seconds after the last save, `--minutes`, with the encoder
 *   back to nothing.
 * - C. Settings open behind another app: 3 minutes.
 *
 * Each idle scenario also checks the app's processes by Chromium role against the idle contract
 * (`IDLE_ROLES`): after launch one pre-warmed renderer may exist, after a recording Chromium's audio
 * service may, and with Settings closed no renderer may remain after a recording. Five seconds after
 * every save the roles are snapshotted, and every snapshot of a launch must match the first: what
 * a recording starts once is expected, what it adds each time is a leak.
 *
 * It writes report.md and report.json under docs/verification/measurements/<time>-cpu/
 * (gitignored). Like the other runners it declares user activity and holds a display and
 * idle-sleep assertion for its lifetime, sets the seeded settings only while the app is quit and
 * restores the file once no RecordStuff process remains, quits the app normally and confirms that
 * it exited. Exit 0 when every judged check passed, 1 when one failed, 2 when blocked (no Command
 * Line Tools, a locked screen) and 130/143 when interrupted. macOS only; never shipped.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { APP_LOG_PATH, APP_SETTINGS_PATH, readAppSettings, writeAppSettings } from "./lib/runner-env.mts";
import { recordStuffPids } from "./lib/processes.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { command, confirmedIdle, settleRecording, waitForLog } from "./lib/acceptance-runtime.mts";
import { acceleratorToKeystroke, currentRunId, keystrokeScript, materialOpenArgs, registeredAccelerator } from "./lib/acceptance.mts";
import {
  CpuSampler, ENCODER_SERVICE, IDLE_ROLES, SamplerBlockedError, compileSampler, cpuBaseline, intervals, judgeCoverage, judgeIdle, judgeRecording, judgeRoles, judgeSettingsOpen,
  judgeSteadyState, machineModel, percentile, readRoles, roleText, summarize, type RoleCounts, type Summary, type Verdict,
} from "./lib/cpu-sampler.mts";
import { DESKTOP_BLOCKED_EXIT, DesktopBlockedError, beginDesktopRound } from "./lib/desktop-session.mts";
import { LogReader, type LogCursor } from "./lib/log-reader.mts";
import { parseSessionRecord } from "./lib/session-records.mts";
import { SETTINGS_SHORTCUT } from "../src/shared/hotkey.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(REPO_ROOT, "dist/mac-arm64/RecordStuff.app");
const EXECUTABLE = path.join(BUNDLE, "Contents/MacOS/RecordStuff");
const LOG_PATH = APP_LOG_PATH;
const SETTINGS_PATH = APP_SETTINGS_PATH;
const MATERIAL = path.join(REPO_ROOT, "scripts/test-material.html");
const RECORDING_SECONDS = 60;
const SETTINGS_MINUTES = 3;

const usage = "usage: pnpm measure:cpu [-- --minutes N] [--fps 60] [--repeat N (odd, 1-9)] [--skip-recording] [--skip-settings] [--out <dir>]";
let minutes = 5, repeat = 1, with60 = false, skipRecording = false, skipSettings = false;
let outDir: string | undefined;
const argv = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--"));
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--minutes") minutes = Number(argv[++i]);
  else if (arg === "--repeat") repeat = Number(argv[++i]);
  else if (arg === "--fps" && argv[i + 1] === "60") { with60 = true; i += 1; }
  else if (arg === "--skip-recording") skipRecording = true;
  else if (arg === "--skip-settings") skipSettings = true;
  else if (arg === "--out") outDir = argv[++i];
  else { console.error(usage); process.exit(2); }
}
// An odd count, so the median is one run's own figure and its breakdown.
if (!(minutes > 0 && minutes <= 60) || !Number.isInteger(repeat) || repeat < 1 || repeat > 9 || repeat % 2 === 0) { console.error(usage); process.exit(2); }

const controller = new AbortController();
let interruptedBy: NodeJS.Signals | undefined;
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
  await command("open", ["-a", BUNDLE], AbortSignal.timeout(15_000));
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
  const start = await waitForLog(log, from, /\] start: /, "`start:`", signal);
  await waitForLog(log, start.at, /\] ready;/, "`ready;`", signal);
  await waitForLog(log, start.at, /recording history: (loaded|load failed)/, "the history load", signal);
  await waitForLog(log, start.at, /\] updates: (?!cannot persist)/, "the launch update check or its skip", signal);
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
const SEEDED_KEYS = ["countdown", "display", "quality"] as const;
let originalSettings: Buffer | undefined;
let seeded = false;
const readSettings = (): Record<string, unknown> => readAppSettings(SETTINGS_PATH) ?? {};
const writeSettings = (next: Record<string, unknown>): void => writeAppSettings(next, SETTINGS_PATH);
function seed(frameRate: 30 | 60): void {
  if (running() !== undefined) fail("refusing to change settings.json while RecordStuff runs");
  originalSettings ??= fs.existsSync(SETTINGS_PATH) ? fs.readFileSync(SETTINGS_PATH) : Buffer.alloc(0);
  const current = readSettings();
  if (!Object.keys(current).length) fail(`no ${SETTINGS_PATH}: launch RecordStuff once and choose an output folder first`);
  const quality = { ...(current["quality"] as Record<string, unknown> | undefined), videoQuality: "standard", resolutionCap: "source", frameRate };
  writeSettings({ ...current, countdown: 0, display: { kind: "primary" }, quality });
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

interface Scenario { name: string; key: string; summary: Summary; verdicts: Verdict[]; roles?: RoleCounts; note?: string }
/** `roles` and `residentBytes` (the app's memory in total) five seconds after the save. */
interface Recording { fps: 30 | 60; file?: string; summary: Summary; roles: RoleCounts; residentBytes: number; samplerFailure: string | undefined }

async function main(): Promise<number> {
  if (process.platform !== "darwin") fail("macOS only");
  if (!fs.existsSync(EXECUTABLE)) fail(`no bundle at ${BUNDLE}: build it with \`pnpm start:app\`, then quit it`);
  if (running() !== undefined) fail("RecordStuff is running: quit it first; this runner launches the bundle itself and must own its process tree");
  const stamp = now().replace(/[:.]/g, "-");
  const dir = outDir ?? path.join(REPO_ROOT, "docs/verification/measurements", `${stamp}-cpu`);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) fail("output directory is not empty");
  fs.mkdirSync(dir, { recursive: true });
  let binary: string;
  try { binary = compileSampler(dir); }
  catch (error) {
    if (error instanceof SamplerBlockedError) { console.error(`BLOCKED: ${error.message}`); return 2; }
    throw error;
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-cpu-material-"));
  /** The recording in flight: its log cursor from before the start key and whether the stop key went out. */
  let active: { from: LogCursor; stopSent: boolean } | undefined;
  let recordingKey = "";
  let appPid = 0;
  const model = machineModel();
  const window = (fromMs: number, toMs: number, expectChanges = false): Summary => summarize(intervals(sampler!.samples), fromMs, toMs, expectChanges);

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
    for (let attempt = 0; attempt < 40; attempt += 1) {
      spawnSync("pkill", ["-f", profile]);
      await delay(250);
      if (spawnSync("pgrep", ["-f", profile]).status === 1) { material = undefined; return undefined; }
    }
    return `the material browser (private profile ${profile}) is still running`;
  };
  const closeMaterialOrFail = async (): Promise<void> => {
    const problem = await closeMaterial();
    if (problem) fail(problem);
  };
  const record = async (fps: 30 | 60): Promise<void> => {
    const from = log.end();
    // Set before the key goes out, so cleanup settles a recording that the key may have started.
    active = { from, stopSent: false };
    await sendKeys(recordingKey);
    await waitForLog(log, from, /\] state → recording/, "`state → recording`", AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
    const started = Date.now();
    await sleep(RECORDING_SECONDS * 1000);
    const beforeStop = log.end();
    // Marked first: a stop key possibly delivered is never followed by a second toggle.
    active.stopSent = true;
    await sendKeys(recordingKey);
    const settled = await waitForLog(log, beforeStop, terminal, "the session's saved or failed record", AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]));
    active = undefined;
    const record = parseSessionRecord(settled.line);
    const file = record?.kind === "saved" ? record.path : undefined;
    if (record?.kind === "failed") fail(`the ${fps} fps recording failed: ${settled.line}`);
    const summary = window(started + 5000, started + (RECORDING_SECONDS - 5) * 1000);
    // The capture host and overlay are destroyed as the state settles; give their processes time to exit.
    await sleep(5000);
    const roles = readRoles(appPid);
    const residentBytes = (sampler!.samples.at(-1)?.procs ?? []).filter((p) => !p.followed).reduce((total, p) => total + p.resident_bytes, 0);
    recordings.push({ fps, ...(file ? { file } : {}), summary, roles, residentBytes, samplerFailure: sampler!.failure });
    note(`recording at ${fps} fps: average ${summary.cpuPercent.average.toFixed(1)}%, 95th ${summary.cpuPercent.p95.toFixed(1)}%, encoder ${summary.followed.cpuPercent.average.toFixed(1)}%; ${file ?? "no file"}; then ${roleText(roles)}`);
  };
  const medianRecording = (fps: 30 | 60): void => {
    const set = recordings.filter((r) => r.fps === fps);
    if (!set.length) return;
    const averages = set.map((r) => r.summary.cpuPercent.average);
    const median = percentile(averages, 50);
    const chosen = set.find((r) => r.summary.cpuPercent.average === median) ?? set[0]!;
    scenarios.push({ name: `R. Recording at ${fps} fps (median of ${set.length})`, key: `recording${fps}`, summary: chosen.summary,
      verdicts: [...judgeRecording(chosen.summary, fps, cpuBaseline(`measure:cpu recording ${fps}`, model)),
        ...set.map((r, i) => ({ ...judgeCoverage(r.summary, RECORDING_SECONDS - 10, r.samplerFailure), check: `Sampled coverage, run ${i + 1}` })),
        { ...judgeRoles(set.at(-1)!.roles, IDLE_ROLES.afterRecording), check: "Process roles 5 s after the last save" },
        judgeSteadyState(set.map((r) => r.roles))],
      note: `Run averages: ${averages.map((a) => `${a.toFixed(1)}%`).join(", ")}; the median run's breakdown is shown. App memory 5 s after each save: ${set.map((r) => mb(r.residentBytes)).join(", ")}.` });
  };

  try {
    // Launch 1: idle, the 30 fps recordings, idle after them and Settings open.
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
      verdicts: [judgeCoverage(idleAfterLaunch, minutes * 60, sampler.failure), ...judgeIdle(idleAfterLaunch), judgeRoles(launchRoles, IDLE_ROLES.launch)] });
    note(`A: average ${idleAfterLaunch.cpuPercent.average.toFixed(3)}%, wake-ups ${idleAfterLaunch.wakeupsPerSecond.average.toFixed(2)}/s`);
    if (!skipRecording) {
      await openMaterial();
      for (let i = 0; i < repeat; i += 1) await record(30);
      await closeMaterialOrFail();
      medianRecording(30);
      note("B. waiting 30 s after the last save");
      await sleep(30_000);
      const bFrom = Date.now();
      await sleep(minutes * 60_000);
      const idleAfter = window(bFrom, Date.now());
      const afterRoles = readRoles(appPid);
      const encoderQuiet = idleAfter.followed.cpuPercent.average < 0.1;
      const rolesVerdict = judgeRoles(afterRoles, IDLE_ROLES.afterRecording);
      const steady = judgeSteadyState([...recordings.filter((r) => r.fps === 30).map((r) => r.roles), afterRoles]);
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
      if (readRoles(appPid)["renderer"] !== 1) fail("Settings did not open: the shortcut was delivered but no Settings renderer is running");
      await command("osascript", ["-e", 'tell application "Finder" to activate'], AbortSignal.timeout(5000));
      note("C. Settings open behind Finder; settling 10 s");
      await sleep(10_000);
      const cFrom = Date.now();
      await sleep(SETTINGS_MINUTES * 60_000);
      const settingsOpen = window(cFrom, Date.now());
      const settingsRoles = readRoles(appPid);
      scenarios.push({ name: "C. Settings open behind another app", key: "settingsOpen", summary: settingsOpen, roles: settingsRoles,
        verdicts: [judgeCoverage(settingsOpen, SETTINGS_MINUTES * 60, sampler.failure), ...judgeSettingsOpen(settingsOpen), judgeRoles(settingsRoles, IDLE_ROLES.settingsOpen)] });
      note(`C: average ${settingsOpen.cpuPercent.average.toFixed(3)}%`);
      await sendKeys(SETTINGS_SHORTCUT);
      await sleep(800);
      await command("osascript", ["-e", 'tell application "System Events" to keystroke "w" using {command down}'], AbortSignal.timeout(5000));
      await sleep(1000);
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
      await openMaterial();
      for (let i = 0; i < repeat; i += 1) await record(60);
      await closeMaterialOrFail();
      medianRecording(60);
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
    const materialProblem = await closeMaterial();
    if (materialProblem) cleanup.push(`could not close ${materialProblem}`);
    else fs.rmSync(profile, { recursive: true, force: true });
    await sampler?.stop();
    try { await quitApp(); } catch (error) { cleanup.push(String(error)); }
    const problem = restoreSettings();
    if (problem) cleanup.push(`settings NOT restored: ${problem}; quit RecordStuff and restore ${SETTINGS_PATH} from the report folder's settings-before.json`);
    if (originalSettings?.length) fs.writeFileSync(path.join(dir, "settings-before.json"), originalSettings);
    desktop.end();
  }

  const environment = {
    machine: model,
    chip: spawnSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).stdout.trim(),
    cores: os.cpus().length,
    macOS: spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout.trim(),
    electron: /electron (\S+);/.exec(log.all().filter((line) => line.includes("] start: ")).at(-1) ?? "")?.[1] ?? "?",
    power: spawnSync("pmset", ["-g", "batt"], { encoding: "utf8" }).stdout.split("\n")[0]?.replace(/^Now drawing from /, "").replace(/'/g, "") ?? "?",
    displays: spawnSync("system_profiler", ["SPDisplaysDataType"], { encoding: "utf8" }).stdout.split("\n").filter((line) => /Resolution:|Main Display: Yes/.test(line)).map((line) => line.trim()),
    bundle: { path: BUNDLE, modified: fs.statSync(EXECUTABLE).mtime.toISOString() },
  };
  const failed = scenarios.flatMap((s) => s.verdicts).some((v) => v.verdict === "fail");
  const result = interruptedBy ? `INTERRUPTED (${interruptedBy}); partial results only`
    : desktop.lockedAt ? "BLOCKED (the screen locked)"
      : runError ? `ERROR: ${runError instanceof Error ? runError.message : String(runError)}`
        : failed ? "FAIL" : "PASS";
  fs.writeFileSync(path.join(dir, "report.json"), `${JSON.stringify({ result, options: { minutes, repeat, fps60: with60, skipRecording, skipSettings }, environment, scenarios, recordings, cleanup, events }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "report.md"), renderReport(result, environment, scenarios, recordings, cleanup));
  console.log(`Report ${path.relative(REPO_ROOT, dir)}/report.md`);
  console.log(result);
  if (cleanup.some((line) => /NOT restored|could not|did not exit|still running/.test(line))) return 1;
  if (interruptedBy) return interruptedBy === "SIGINT" ? 130 : 143;
  if (desktop.lockedAt) return DESKTOP_BLOCKED_EXIT;
  return runError || failed ? 1 : 0;
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
function renderReport(result: string, environment: Record<string, unknown>, scenarios: Scenario[], recordings: Recording[], cleanup: string[]): string {
  const lines = [
    "# CPU budget (`pnpm measure:cpu`)", "",
    `Result: **${result}**. CPU is a percentage of one core (the machine has ${String(environment["cores"])} cores); wake-ups are idle plus interrupt wake-ups per second; the app is its main process and every descendant, with ${ENCODER_SERVICE} reported apart.`, "",
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
  lines.push("## Cleanup", "", cleanup.length ? cleanup.map((line) => `- ${line}`).join("\n") : "Complete: RecordStuff exited, the seeded settings were restored and the material closed.", "",
    "## Events", "", ...events.map((event) => `- ${event}`), "");
  return lines.join("\n");
}

main().then((code) => process.exit(code), (error: unknown) => {
  console.error(error instanceof Failure ? `✗ ${error.message}` : error);
  process.exit(1);
});
