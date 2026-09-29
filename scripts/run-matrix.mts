#!/usr/bin/env node
/**
 * `pnpm matrix -- <name>[,<name>…] [--repeat N] [--no-open-material] [--screen WxH] [--dry-run]`
 *
 * Defaults do the right thing: the test material page is opened full screen
 * on the main display by Chrome (kiosk, private profile) and the main
 * display's size is detected for the aspect check. `--no-open-material`
 * when you are showing the material yourself; `--screen` to override.
 *
 * One invocation is one desktop round (plan 042): build the app once, open
 * the material once, then run every case of the named matrices in order,
 * the whole list `--repeat` times so repeats interleave. Each case launches
 * Electron.app with `RECORDSTUFF_AUTORECORD` so it records unattended and
 * quits; the runner samples the app's process tree meanwhile with the shared
 * CPU sampler (plan 049), judged over the recording from its third second,
 * verifies the new file (with the flash / beep sync markers), times every
 * phase, and appends everything to `docs/verification/measurements/<date>.md`.
 * macOS only (`open`, `pgrep`, `clang`); nothing here ships with the app. The
 * next case starts as soon as the previous one is verified: that verification
 * is the rest, and dropping the former extra 10 seconds moved no judged metric
 * beyond the run-to-run spread (plan 042).
 *
 * Channel energy and the sync markers are required evidence (plan 030): a
 * case passes only when every check passes or does not apply, and a repeated
 * case only when every run of it did. Exit 1 when a case failed, is
 * incomplete (too few markers) or could not be recorded or verified, or when
 * cleanup left a process running; 2 when ffmpeg/ffprobe or the Command Line
 * Tools' clang is missing (checked before any recording) or the desktop
 * locked; 130/143 after SIGINT/SIGTERM,
 * which stop the round's own app (through its normal quit, which saves a
 * recording in progress) and material browser and write no measurements;
 * 0 otherwise.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { APP_LOG_PATH, APP_SETTINGS_PATH, scrubbedEnv } from "./lib/runner-env.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMaterialProfile, materialOpenArgs, removeMaterialProfile } from "./lib/acceptance.mts";
import { CPU_BUDGET, CpuSampler, MIN_COVERAGE, SamplerBlockedError, compileSampler, cpuBaseline, intervals, summarize } from "./lib/cpu-sampler.mts";
import { DESKTOP_BLOCKED_EXIT, DesktopBlockedError, beginDesktopRound, type DesktopRound } from "./lib/desktop-session.mts";
import { LogGapError, LogReader, type LogCursor } from "./lib/log-reader.mts";
import {
  MATRICES,
  casePhases,
  cpuWindow,
  formatCaseTiming,
  formatRepeatSummary,
  formatRoundTiming,
  parseMatrixArgs,
  planCases,
  runVerdict,
  summarizeRuns,
  withUnreached,
  type CasePhases,
  type CaseTiming,
  type MatrixEntry,
  type MatrixRun,
} from "./lib/matrix.mts";
import { electronPattern, escapeRegExp, groupAlive, interruptExitCode, pgrepPids, signalPids, startBuild, stopGroup } from "./lib/processes.mts";
import { ToolMissingError, hasTool, timeTools, type ToolTiming } from "./lib/media-tools.mts";
import { REPO_ROOT, appendMeasurements, measurementsPath, readLogPairs, verifyRecording, type VerifyResult } from "./lib/verify-recording.mts";
import { pairRecordingsWithLog } from "./lib/verify.mts";
import { BLOCKED_EXIT, blocksSuccess, formatText, parseAutorecordOutcome, verdictExitCode, type CpuFigures } from "./lib/verify.mts";

const ELECTRON_APP = path.join(REPO_ROOT, "node_modules/electron/dist/Electron.app");
/** pnpm symlinks `node_modules/electron`; process command lines show the resolved `.pnpm/…` path. */
const ELECTRON_APP_REAL = fs.existsSync(ELECTRON_APP) ? fs.realpathSync(ELECTRON_APP) : ELECTRON_APP;
const LOG_PATH = APP_LOG_PATH;
const SETTINGS_PATH = APP_SETTINGS_PATH;
const MATERIAL = path.join(REPO_ROOT, "scripts/test-material.html");
/** How long an interrupted case's app may take to stop, save and quit before it is forced. */
const QUIT_GRACE_MS = 30_000;
/**
 * How long after a case's launch its app may still appear: `open` hands the
 * request to Launch Services, and stopping the launcher does not withdraw it,
 * so a first empty look is not yet "no app" (review).
 */
const LAUNCH_SETTLE_MS = 5_000;

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(`usage: pnpm matrix -- <${Object.keys(MATRICES).join("|")}>[,<name>…] [--repeat N] [--no-open-material] [--screen 1920x1080] [--dry-run]`);
  process.exit(2);
}

const roundStarted = Date.now();
const argv = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--"));
const parsed = parseMatrixArgs(argv, Object.keys(MATRICES));
if (!parsed.ok) usage(parsed.error);
const { names, repeat, openMaterial, dryRun } = parsed.options;
const cases = planCases(names, repeat);
const runLabel = `pnpm matrix -- ${names.join(",")}${repeat > 1 ? ` --repeat ${repeat}` : ""}`;
const screen = parsed.options.screen ?? mainDisplaySize();
if (!screen) console.error("Primary display size unavailable; aspect checks may be unavailable (use --screen WxH)");
if (process.platform !== "darwin") {
  console.error("pnpm matrix currently requires macOS (open/ps/pgrep); other platforms are unverified");
  process.exit(2);
}

/**
 * Logical size of the main display (the one the app records) from
 * `system_profiler`: the block marked `Main Display: Yes`, using `UI Looks
 * like` when present (HiDPI) and `Resolution` otherwise.
 */
function mainDisplaySize(): { width: number; height: number } | undefined {
  const text = spawnSync("system_profiler", ["SPDisplaysDataType"], { encoding: "utf8" }).stdout ?? "";
  const blocks = text.split(/\n(?=\s{8}\S)/);
  const main = blocks.find((block) => /Main Display: Yes/.test(block));
  if (!main) return undefined;
  const ui = /UI Looks like:\s*(\d+) x (\d+)/.exec(main) ?? /Resolution:\s*(\d+) x (\d+)/.exec(main);
  return ui ? { width: Number(ui[1]), height: Number(ui[2]) } : undefined;
}

function outputDir(): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as { outputDir?: string };
    if (parsed.outputDir) return parsed.outputDir;
  } catch {
    // no settings yet: the app uses the default
  }
  return path.join(os.homedir(), "Movies/RecordStuff");
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Lets a signal that arrived during synchronous work (ffprobe, ffmpeg, pgrep)
 * reach its handler before the round goes on: Node reads signals in the event
 * loop's poll phase, and a nested setImmediate resolves only after a full one
 * (review).
 */
const signalsDelivered = (): Promise<void> => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

/** PIDs of every process inside this repo's Electron.app bundle (main + helpers), not the `open` launcher. */
const electronPids = (): number[] => pgrepPids(electronPattern(ELECTRON_APP_REAL, "bundle"));
/** The main process, the root of the tree the CPU sampler follows; its helpers are its descendants. */
const electronMainPid = (): number | undefined => pgrepPids(electronPattern(ELECTRON_APP_REAL, "main"))[0];

/**
 * What this round started, so an interruption stops exactly its own work
 * (plan 042): the build (its own process group), the current case's `open -W`
 * launcher, the app it launched and the material browser (matched by its
 * private profile, created for this round and removed by cleanup). The round refuses to start while any process of this
 * checkout's Electron.app runs and launches one app at a time, so every such
 * process seen during the round is its own; another RecordStuff (the
 * installed app, another checkout) never matches that path.
 */
const owned: {
  desktop?: DesktopRound;
  build?: ChildProcess;
  launcher?: ChildProcess;
  caseLaunchedAt?: number;
  materialLauncher?: ChildProcess;
  /** The round's private Chrome profile while the material may run. */
  materialProfile?: string;
  caseLog?: LogCursor;
  sampler?: CpuSampler;
} = {};

const materialPids = (): number[] => owned.materialProfile ? pgrepPids(escapeRegExp(owned.materialProfile)) : [];

function stillRunning(): string[] {
  const left: string[] = [];
  if (groupAlive(owned.build?.pid)) left.push("the build");
  const electron = electronPids();
  if (electron.length > 0) left.push(`Electron.app processes ${electron.join(", ")}`);
  if (materialPids().length > 0) left.push("the material browser");
  return left;
}

/**
 * Stops a case's app through its normal quit: SIGTERM reaches Electron's
 * before-quit, where the app stops and saves a recording in progress first.
 * Whatever still runs after the grace period is killed.
 */
async function stopApp(): Promise<"none" | "quit" | "forced"> {
  const settled = (owned.caseLaunchedAt ?? 0) + LAUNCH_SETTLE_MS;
  while (electronPids().length === 0) {
    if (Date.now() >= settled) return "none";
    await sleep(250);
  }
  signalPids(pgrepPids(electronPattern(ELECTRON_APP_REAL, "main")), "SIGTERM");
  for (const deadline = Date.now() + QUIT_GRACE_MS; Date.now() < deadline;) {
    if (electronPids().length === 0) return "quit";
    await sleep(250);
  }
  signalPids(electronPids(), "SIGKILL");
  return "forced";
}

const running = (child: ChildProcess | undefined): child is ChildProcess => child !== undefined && child.exitCode === null && child.signalCode === null;

let cleaning: Promise<{ left: string[]; app: "none" | "quit" | "forced" }> | undefined;
/**
 * Idempotent; returns what is still running after waiting up to 5 s for the
 * material browser, whose profile is then removed. Rejects when `pgrep`
 * fails, because nothing then proves the round's processes exited.
 */
function cleanup(): Promise<{ left: string[]; app: "none" | "quit" | "forced" }> {
  cleaning ??= (async () => {
    await stopGroup(owned.build?.pid);
    const app = await stopApp();
    await owned.sampler?.stop();
    if (running(owned.launcher)) owned.launcher.kill("SIGTERM");
    // `open` returns once Launch Services started Chrome; before that, pkill could find nothing (review).
    const materialLauncher = owned.materialLauncher;
    if (running(materialLauncher)) await Promise.race([new Promise((resolve) => materialLauncher.once("exit", resolve)), sleep(10_000)]);
    for (let i = 0; i < 10; i += 1) {
      signalPids(materialPids(), "SIGTERM");
      if (stillRunning().length === 0) break;
      await sleep(500);
    }
    owned.desktop?.end();
    cleanupSampler();
    const left = stillRunning();
    // A launch that never settled may still start Chrome and recreate the profile.
    if (running(materialLauncher)) left.push("the material launch (`open`), which may still start Chrome");
    else if (owned.materialProfile && materialPids().length === 0) {
      const problem = await removeMaterialProfile(owned.materialProfile);
      if (problem) left.push(problem);
      else delete owned.materialProfile;
    }
    return { left, app };
  })();
  return cleaning;
}

let interrupted = false;
/**
 * After a signal the handler owns cleanup and the exit code; stopping the app
 * also releases `open -W`, so the round must not go on to verify, write
 * measurements or exit first.
 */
const halt = (): Promise<never> => new Promise<never>(() => undefined);
function interrupt(name: "SIGINT" | "SIGTERM"): void {
  if (interrupted) return;
  interrupted = true;
  console.error(`${name}: stopping this round's app and material; no measurements or summary are written`);
  void interruptExitCode(name, async () => {
    const { left, app } = await cleanup();
    if (app === "quit") console.error("cleanup: the case's app quit normally (a recording in progress is stopped and saved first)");
    if (app === "forced") console.error(`cleanup: the case's app did not quit within ${QUIT_GRACE_MS / 1000} s and was killed; a recording may remain as .recording.mp4`);
    if (owned.caseLog) {
      const outcome = parseAutorecordOutcome(logSince(owned.caseLog).lines.join("\n"));
      if (outcome.saved) console.error(`cleanup: the interrupted case saved ${outcome.saved} (not verified)`);
      if (outcome.failed) console.error(`cleanup: the interrupted case reported autorecord: failed: ${outcome.failed}`);
    }
    return left;
  }).then((exit) => process.exit(exit));
}

interface RunOutcome {
  /** The path from the app's `autorecord: saved` line; undefined unless the run completed. */
  file: string | undefined;
  /** The `autorecord: failed: …` reason, when the app reported one. */
  failure: string | undefined;
  /** Undefined when the CPU evidence is missing, with `cpuProblem` saying why. */
  cpu: CpuFigures | undefined;
  /** No sampler, a sampler that exited early, or too little of the judged window sampled: the case cannot pass. */
  cpuProblem: string | undefined;
  elapsedSeconds: number;
  timedOut: boolean;
  launchedAt: number;
  phases: CasePhases;
}

/** Rotation-aware: a case's lines are read from its cursor, through any number of retained archives. */
const appLog = new LogReader(LOG_PATH);

/** Log lines written since `start`; a rotated-away history is an explicit failure, not "no outcome". */
function logSince(start: LogCursor): { lines: string[]; gap?: string } {
  try {
    return { lines: appLog.since(start).lines.map((line) => line.text) };
  } catch (cause) {
    if (cause instanceof LogGapError) return { lines: [], gap: cause.message };
    throw cause;
  }
}

/** Where the sampler's helper was compiled, before the round started. */
let samplerBinary = "";
/** The temporary folder the sampler was compiled into; removed by cleanup. */
let samplerDir: string | undefined;
function cleanupSampler(): void {
  if (!samplerDir) return;
  fs.rmSync(samplerDir, { recursive: true, force: true });
  samplerDir = undefined;
}
// Preflight can exit before the asynchronous desktop cleanup is entered.
process.once("exit", cleanupSampler);

async function recordOnce(entry: MatrixEntry, key: string): Promise<RunOutcome> {
  const logStart = appLog.end();
  owned.caseLog = logStart;
  const env: NodeJS.ProcessEnv = { ...scrubbedEnv(), RECORDSTUFF_AUTORECORD: JSON.stringify({ seconds: entry.seconds, quality: entry.quality }) };
  const launchedAt = Date.now();
  owned.caseLaunchedAt = launchedAt;
  const child = spawn("open", ["-W", "-a", ELECTRON_APP, "--args", REPO_ROOT], { env, stdio: "inherit" });
  owned.launcher = child;
  let exitedAt: number | undefined;
  const exited = new Promise<void>((resolve) => child.on("exit", () => {
    exitedAt = Date.now();
    resolve();
  }));
  let sampler: CpuSampler | undefined;
  const deadlineMs = (entry.seconds + 90) * 1000;
  let timedOut = false;
  while (exitedAt === undefined && !interrupted) {
    // Wakes on exit as well, so a finished case does not wait out the sampling second.
    await Promise.race([sleep(1000), exited]);
    if (exitedAt !== undefined || interrupted) break;
    const main = sampler ? undefined : electronMainPid();
    if (main !== undefined) owned.sampler = sampler = new CpuSampler(samplerBinary, main);
    if (Date.now() - launchedAt > deadlineMs) {
      timedOut = true;
      console.error(`  Still running after ${deadlineMs / 1000} s; terminating Electron`);
      signalPids(electronPids(), "SIGTERM");
      await sleep(2000);
      break;
    }
  }
  await sampler?.stop();
  delete owned.sampler;
  const since = logSince(logStart);
  const app = parseAutorecordOutcome(since.lines.join("\n"));
  const window = cpuWindow(since.lines, launchedAt, exitedAt);
  const summary = sampler ? summarize(intervals(sampler.samples), window.fromMs, window.toMs, window.expectChanges) : undefined;
  const windowSeconds = Number.isFinite(window.toMs) ? (window.toMs - window.fromMs) / 1000 : undefined;
  const cpuProblem = !sampler ? "the CPU sampler never found the app's main process"
    : sampler.failure ? sampler.failure
      : !summary?.judged ? "no one-second interval fell inside the judged window"
        : windowSeconds !== undefined && summary.seconds < windowSeconds * MIN_COVERAGE
          ? `only ${summary.seconds.toFixed(1)} of ${windowSeconds.toFixed(1)} s were sampled (at least ${MIN_COVERAGE * 100}% required)` : undefined;
  const baselinePercent = cpuBaseline(`matrix ${key}`);
  return {
    file: timedOut ? undefined : app.saved,
    failure: since.gap ? `log evidence gap: ${since.gap}` : app.failed,
    cpuProblem: cpuProblem === undefined ? undefined : `CPU evidence incomplete: ${cpuProblem}`,
    cpu: summary && !cpuProblem ? {
      averagePercent: summary.cpuPercent.average,
      p95Percent: summary.cpuPercent.p95,
      peakPercent: summary.cpuPercent.max,
      encoder: { present: summary.followed.present, averagePercent: summary.followed.cpuPercent.average },
      ...(baselinePercent === undefined ? {} : { baselinePercent }),
    } : undefined,
    elapsedSeconds: (Date.now() - launchedAt) / 1000,
    timedOut,
    launchedAt,
    phases: casePhases(since.lines, launchedAt, exitedAt),
  };
}

function build(): Promise<number> {
  // Its own process group, so cleanup can stop pnpm and every child it started.
  const { child, done } = startBuild(REPO_ROOT);
  owned.build = child;
  return done;
}

async function main(): Promise<void> {
  const dir = outputDir();
  console.log(`Matrix ${names.join(",")}${repeat > 1 ? ` × ${repeat}` : ""}: ${cases.length} cases; output ${dir}; log ${LOG_PATH}; primary display ${screen ? `${screen.width}x${screen.height}` : "unknown"}; material ${openMaterial ? "automatic (Chrome kiosk)" : "manual"}`);
  if (dryRun) {
    for (const [index, planned] of cases.entries()) console.log(`  ${index + 1}. ${planned.title}: ${JSON.stringify(planned.entry.quality)}`);
    return;
  }
  const missingTools = ["ffprobe", "ffmpeg"].filter((tool) => !hasTool(tool));
  if (missingTools.length > 0) {
    console.error(`BLOCKED: ${missingTools.join(" and ")} missing (brew install ffmpeg); every case requires channel energy and sync evidence. No case was recorded.`);
    process.exit(BLOCKED_EXIT);
  }
  if (electronPids().length > 0) {
    console.error("This project's Electron.app is running; quit it first (the single-instance lock would ignore automatic recording settings)");
    process.exit(1);
  }
  try {
    samplerDir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-matrix-cpu-"));
    samplerBinary = compileSampler(samplerDir);
  } catch (cause) {
    if (!(cause instanceof SamplerBlockedError)) throw cause;
    console.error(`BLOCKED: ${cause.message}; every case requires its CPU figure. No case was recorded.`);
    process.exit(BLOCKED_EXIT);
  }
  process.on("SIGINT", () => interrupt("SIGINT"));
  process.on("SIGTERM", () => interrupt("SIGTERM"));

  // Every case records the primary display; a slept or locked display would be recorded instead.
  const desktop = await beginDesktopRound().catch((cause: unknown) => {
    if (cause instanceof DesktopBlockedError) { console.error(`BLOCKED: ${cause.message} No case was recorded.`); process.exit(DESKTOP_BLOCKED_EXIT); }
    throw cause;
  });
  owned.desktop = desktop;
  if (interrupted) await halt();
  console.log("electron-vite build …");
  const buildStarted = Date.now();
  const preflightSeconds = (buildStarted - roundStarted) / 1000;
  const built = await build();
  if (interrupted) await halt();
  if (built !== 0) {
    desktop.end();
    process.exit(built);
  }
  const buildSeconds = (Date.now() - buildStarted) / 1000;

  const materialStarted = Date.now();
  if (openMaterial) {
    // A private profile makes Chrome start a new instance that honours the
    // flags even when the user's Chrome is already running. The window is
    // placed at the global origin, which is always on the main display — the
    // one the app records; without this, Chrome may pick another screen.
    owned.materialProfile = createMaterialProfile("matrix");
    owned.materialLauncher = spawn("open", materialOpenArgs(MATERIAL, owned.materialProfile), { stdio: "ignore" });
    console.log("Opened test material in Chrome kiosk on the primary display; waiting 5 seconds for fullscreen");
  } else {
    console.log(`Open ${path.relative(REPO_ROOT, MATERIAL)} fullscreen and click Start; keep volume fixed. Starting in 5 seconds.`);
  }
  await sleep(5000);
  if (interrupted) await halt();
  const materialSeconds = (Date.now() - materialStarted) / 1000;

  const runs: MatrixRun[] = [];
  const timings: CaseTiming[] = [];
  let left: string[] = [];
  try {
    for (const [index, planned] of cases.entries()) {
      await signalsDelivered();
      if (interrupted) await halt();
      const { entry } = planned;
      console.log(`▶ [${index + 1}/${cases.length}] ${planned.title}`);
      const outcome = await recordOnce(entry, planned.key);
      if (interrupted) await halt();
      const tools: ToolTiming[] = [];
      let stop = false;
      if (!outcome.file) {
        const error = outcome.timedOut
          ? `Timed out (${outcome.elapsedSeconds.toFixed(0)} s); terminated${outcome.failure ? `; app reported ${outcome.failure}` : ""}`
          : outcome.failure
            ? `app reported autorecord: failed: ${outcome.failure}`
            : "app exited without an autorecord: saved log entry";
        runs.push({ planned, result: undefined, error });
        console.error(`  ✗ ${error}`);
      } else {
        const cpu = outcome.cpu;
        console.log(`  File ${outcome.file}; ${cpu ? `CPU average ${cpu.averagePercent.toFixed(1)}%, 95th ${cpu.p95Percent?.toFixed(1)}%, peak ${cpu.peakPercent.toFixed(1)}%; VTEncoderXPCService ${cpu.encoder?.present ? `${cpu.encoder.averagePercent.toFixed(1)}%` : "absent"}` : "no CPU interval in the judged window"}`);
        if (cpu?.baselinePercent !== undefined && cpu.averagePercent > cpu.baselinePercent * (1 + CPU_BUDGET.regressionFraction)) {
          console.error(`  ⚠ CPU ${cpu.averagePercent.toFixed(1)}% is more than ${CPU_BUDGET.regressionFraction * 100}% above this machine's baseline of ${cpu.baselinePercent.toFixed(1)}%: investigate`);
        }
        try {
          const options: Parameters<typeof verifyRecording>[2] = {
            sync: true, expectedDurationSeconds: entry.seconds, required: { energy: true, sync: true },
          };
          if (outcome.cpu) options.cpu = outcome.cpu;
          if (screen) options.screen = screen;
          const file = outcome.file;
          // Only this case's lines: its own `start:`, capture and saved records all follow the cursor taken
          // before launch, so the retained history is not re-read and re-paired for every case.
          const caseLog = owned.caseLog;
          const pairs = caseLog ? pairRecordingsWithLog(logSince(caseLog).lines.join("\n")) : readLogPairs(LOG_PATH);
          const result = timeTools(tools, () => verifyRecording(file, pairs, options));
          // Media measurements stand; judging against the requested settings needs this session's own metadata.
          const metadata = result.pairing.status === "matched" ? undefined
            : `log metadata ${result.pairing.status}${result.pairing.note ? `: ${result.pairing.note}` : ""}; requested-settings checks not judged`;
          const error = [metadata, outcome.cpuProblem].filter(Boolean).join("; ");
          runs.push({ planned, result, ...(error ? { error } : {}) });
          console.log(formatText(outcome.file, result.entry, result.checks, result.pairing));
          if (metadata) console.error(`  ✗ ${metadata}`);
          if (outcome.cpuProblem) console.error(`  ✗ ${outcome.cpuProblem}`);
          if (blocksSuccess(result.verdict)) console.error(`  ✗ ${unmetChecks(result)}`);
        } catch (cause) {
          runs.push({ planned, result: undefined, error: cause instanceof Error ? cause.message : String(cause), blocked: cause instanceof ToolMissingError });
          console.error(`  ✗ verification failed: ${runs[runs.length - 1]?.error}`);
          stop = cause instanceof ToolMissingError;
        }
      }
      const timing: CaseTiming = { title: planned.title, phases: outcome.phases, tools, totalSeconds: (Date.now() - outcome.launchedAt) / 1000 };
      timings.push(timing);
      console.log(formatCaseTiming(timing));
      // Until here an interruption reports this case's saved file as not verified.
      delete owned.caseLog;
      if (stop) break;
    }
  } finally {
    await signalsDelivered();
    if (interrupted) await halt();
    left = (await cleanup()).left;
    // A signal during that wait belongs to the handler too.
    await signalsDelivered();
    if (interrupted) await halt();
  }
  if (left.length > 0) console.error(`CLEANUP INCOMPLETE: ${left.join("; ")} still running`);

  const judged = withUnreached(cases, runs, "not run: the round stopped early after a tool went missing");
  const verified = runs.filter((r) => r.result !== undefined);
  const target = measurementsPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (verified.length > 0) {
    appendMeasurements(
      target,
      verified.map((r) => r.result!),
      {
        title: (_result, i) => verified[i]?.planned.title ?? "",
        material: `scripts/test-material.html${openMaterial ? " (Chrome kiosk)" : ""}`,
        runLabel,
      },
    );
  } else {
    fs.appendFileSync(target, `\n## ${new Date().toISOString()} — ${runLabel}\n\n`, "utf8");
  }
  const sections = [formatRoundTiming({ preflightSeconds, buildSeconds, materialSeconds, totalSeconds: (Date.now() - roundStarted) / 1000, cases: timings })];
  const summaries = summarizeRuns(judged);
  if (summaries.some((s) => s.runs > 1)) sections.push(formatRepeatSummary(summaries));
  fs.appendFileSync(target, `\n${sections.join("\n")}`, "utf8");
  console.log(`\n${sections.join("\n")}`);
  console.log(`Appended to ${path.relative(process.cwd(), target)}${verified.length > 0 ? " (and matching .json)" : ""}`);
  // A case succeeds only with no error and a verdict that neither failed nor lacks required evidence.
  const unsuccessful = judged.flatMap((r) => {
    const reasons = [r.error, r.result && blocksSuccess(r.result.verdict) ? unmetChecks(r.result) : undefined].filter((s): s is string => s !== undefined);
    return reasons.length > 0 ? [`${r.planned.title}: ${reasons.join("; ")}`] : [];
  });
  if (left.length > 0) unsuccessful.push(`cleanup: ${left.join("; ")} still running`);
  if (unsuccessful.length > 0) {
    fs.appendFileSync(target, `\n## ${new Date().toISOString()} — ${runLabel} cases that did not pass\n\n${unsuccessful.map((line) => `- ${line}`).join("\n")}\n`, "utf8");
    for (const line of unsuccessful) console.error(`✗ ${line}`);
  }
  if (desktop.lockedAt) {
    fs.appendFileSync(target, `\n## ${new Date().toISOString()} — ${runLabel} blocked\n\n${desktop.summary}\n`, "utf8");
    console.error(desktop.summary);
    process.exit(DESKTOP_BLOCKED_EXIT);
  }
  process.exit(left.length > 0 ? 1 : verdictExitCode(judged.map(runVerdict)));
}

/** The case verdict and each check that kept it from passing, with its reason. */
function unmetChecks(result: VerifyResult): string {
  const checks = result.checks.filter((c) => blocksSuccess(c.verdict)).map((c) => `${c.metric} ${c.verdict}${c.note ? ` (${c.note})` : ""}`);
  return `verdict ${result.verdict}: ${checks.join("; ")}`;
}

void main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.stack ?? cause.message : String(cause));
  process.exit(1);
});
