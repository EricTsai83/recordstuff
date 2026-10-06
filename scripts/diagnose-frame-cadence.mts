#!/usr/bin/env node
/**
 * `pnpm diagnose:cadence -- [--rates 30,60] [--runs 2] [--seconds 30]
 *   [--request 30:30.6,60:62.4] [--ideal-only] [--load N] [--label text]
 *   [--no-open-material]`
 *
 * Plan 041's frame-cadence diagnostic; macOS developer tooling, never shipped.
 * Each run records the test material on the primary display through the
 * isolated `scripts/fixtures/frame-cadence.ts` (the production capture host
 * with renderer instrumentation) and compares three views of the same frames:
 * the timestamps the video track delivered before MediaRecorder, the track's
 * delivered/discarded counters and the file's pts. The runs alternate rates;
 * `--load N` keeps N busy processes running during each recording;
 * `--request` replaces the frame-rate constraint with `{ ideal, max }` (or
 * `{ ideal }` with `--ideal-only`) for the listed settings. Evidence goes to
 * `docs/verification/measurements/<timestamp>-frame-cadence/`. Media checks,
 * sync and bitrate stay with `pnpm matrix`; this tool only locates cadence.
 *
 * Exit 0 when every run produced its evidence and a classification, 1 when a
 * run did not or cleanup left a process behind, 2 when ffprobe is missing or
 * the desktop was locked, 130/143 after SIGINT/SIGTERM (its cleanup still
 * runs), also during the build, which runs in its own process group so the
 * handler can stop it.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { scrubbedEnv } from "./lib/runner/runner-env.mts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMaterialProfile, materialOpenArgs, removeMaterialProfile } from "./lib/acceptance/acceptance.mts";
import { buildFixture } from "./lib/runner/build-fixture.mts";
import { LAUNCHER_EXIT_MS, QUIT_GRACE_MS, stopDevApp } from "./lib/runner/dev-app.mts";
import { DESKTOP_BLOCKED_EXIT, DesktopBlockedError, beginDesktopRound, type DesktopRound } from "./lib/runner/desktop-session.mts";
import { CpuSampler, MIN_COVERAGE, SamplerBlockedError, SamplerInterruptedError, compileSampler, intervals, summarize } from "./lib/verification/cpu-sampler.mts";
import { cadenceStats, classifyCadence, counterDelta, type CadenceLayer, type CadenceStats, type CounterDelta } from "./lib/verification/frame-cadence.mts";
import { frameTimes, hasTool, probe, requireMediaTimeout } from "./lib/verification/media-tools.mts";
import { electronPattern, escapeRegExp, groupAlive, interruptExitCode, pgrepPids, recordStuffPids, signalPids, startBuild, stopGroup } from "./lib/runner/processes.mts";
import { MEASUREMENTS_DIR, REPO_ROOT } from "./lib/verification/verify-recording.mts";
import { FRAME_RATES, type FrameRate, type QualitySettings } from "../src/shared/quality.ts";

const ELECTRON_APP = path.join(REPO_ROOT, "node_modules/electron/dist/Electron.app");
const ELECTRON_APP_REAL = fs.existsSync(ELECTRON_APP) ? fs.realpathSync(ELECTRON_APP) : ELECTRON_APP;
const MATERIAL = path.join(REPO_ROOT, "scripts/test-material.html");
const REST_SECONDS = 5;

type Request = { ideal: number; max?: number };

interface Options {
  rates: FrameRate[];
  runs: number;
  seconds: number;
  requests: Partial<Record<FrameRate, number>>;
  idealOnly: boolean;
  load: number;
  label: string | undefined;
  openMaterial: boolean;
}

function usage(message?: string): never {
  if (message) console.error(message);
  console.error("usage: pnpm diagnose:cadence -- [--rates 30,60] [--runs 2] [--seconds 30] [--request 30:30.6,60:62.4] [--ideal-only] [--load N] [--label text] [--no-open-material]");
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const options: Options = { rates: [30, 60], runs: 2, seconds: 30, requests: {}, idealOnly: false, load: 0, label: undefined, openMaterial: true };
  // A missing value must not take the next option as one (`--label --no-open-material`).
  const value = (i: number): string => {
    const next = argv[i + 1];
    return next === undefined || next.startsWith("--") ? usage(`${argv[i]} needs a value`) : next;
  };
  const rate = (text: string): FrameRate => {
    const n = Number(text);
    if (!(FRAME_RATES as readonly number[]).includes(n)) usage(`unsupported frame rate ${text}`);
    return n as FrameRate;
  };
  const positive = (text: string, max: number): number => {
    const n = Number(text);
    if (!Number.isFinite(n) || n <= 0 || n > max) usage(`expected a number in (0, ${max}], got ${text}`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--rates") { options.rates = value(i).split(",").map(rate); i += 1; }
    else if (arg === "--runs") {
      // A fraction rounding to 0 would record nothing and still report complete.
      options.runs = positive(value(i), 10);
      if (!Number.isInteger(options.runs)) usage(`--runs expects a whole number, got ${value(i)}`);
      i += 1;
    }
    else if (arg === "--seconds") { options.seconds = positive(value(i), 600); i += 1; }
    else if (arg === "--request") {
      for (const pair of value(i).split(",")) {
        const [setting, requested] = pair.split(":");
        options.requests[rate(setting ?? "")] = positive(requested ?? "", 120);
      }
      i += 1;
    } else if (arg === "--ideal-only") options.idealOnly = true;
    else if (arg === "--load") { options.load = Number(value(i)); if (!/^\d+$/.test(value(i)) || options.load > 64) usage("--load takes a whole number of busy processes, 0–64"); i += 1; }
    else if (arg === "--label") { options.label = value(i); i += 1; }
    else if (arg === "--no-open-material") options.openMaterial = false;
    else usage(`unknown argument ${arg}`);
  }
  return options;
}

/** The constraint a run uses instead of the product's; null keeps the product request. */
function requestFor(options: Options, setting: FrameRate): Request | null {
  const requested = options.requests[setting];
  if (requested === undefined && !options.idealOnly) return null;
  const rate = requested ?? setting;
  return options.idealOnly ? { ideal: rate } : { ideal: rate, max: rate };
}

/** Every process inside this checkout's Electron.app bundle (main + helpers), not the `open` launcher. */
const electronPids = (): number[] => pgrepPids(electronPattern(ELECTRON_APP_REAL, "bundle"));

/** The fixture's Electron main process, the root of the tree the CPU sampler follows. */
const electronMainPid = (): number | undefined => pgrepPids(electronPattern(ELECTRON_APP_REAL, "main"))[0];
/**
 * The shared sampler (cpu-sampler.mts), as `matrix` and `measure:cpu` measure: usage per second of the fixture's
 * process tree. `ps %cpu`, used before, is a decaying average over up to a minute on macOS, so its figure could not be
 * compared with theirs. Compiled once per round, into its evidence directory.
 */
let samplerBinary = "";

function environment(): Record<string, string | undefined> {
  const displays = spawnSync("system_profiler", ["SPDisplaysDataType"], { encoding: "utf8" }).stdout ?? "";
  const main = displays.split(/\n(?=\s{8}\S)/).find((block) => /Main Display: Yes/.test(block));
  const electron = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "node_modules/electron/package.json"), "utf8")) as { version: string };
  return {
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    macos: spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout.trim() || undefined,
    cpu: spawnSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).stdout.trim() || undefined,
    cores: String(os.cpus().length),
    electron: electron.version,
    primaryDisplay: main ? /UI Looks like:\s*(.+)/.exec(main)?.[1]?.trim() ?? /Resolution:\s*(.+)/.exec(main)?.[1]?.trim() : undefined,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Everything this round started, so an interruption or a timeout stops
 * exactly its own processes (review F2): the build (its own process group),
 * the busy workers, the fixture
 * (matched by its path inside this round's directory, because `open` does not
 * make it a child), the material browser with the private profile created for
 * it, which cleanup removes, and the display assertion.
 */
const owned: { busy: Set<ChildProcess>; build?: ChildProcess; fixture?: string; material?: ChildProcess; materialProfile?: string; desktop?: DesktopRound; sampler?: CpuSampler } = { busy: new Set() };
const materialPids = (): number[] => owned.materialProfile ? pgrepPids(escapeRegExp(owned.materialProfile)) : [];

function stopBusy(): void {
  for (const busy of owned.busy) busy.kill("SIGKILL");
  owned.busy.clear();
}

function stopFixture(): void {
  if (owned.fixture) signalPids(pgrepPids(escapeRegExp(owned.fixture)), "SIGTERM");
}

function stillRunning(): string[] {
  const left: string[] = [];
  if (groupAlive(owned.build?.pid)) left.push("the build");
  const electron = electronPids();
  if (electron.length > 0) left.push(`Electron.app processes ${electron.join(", ")}`);
  if (materialPids().length > 0) left.push("the material browser");
  return left;
}

let cleaning: Promise<string[]> | undefined;
/**
 * Idempotent; waits up to 10 s for the material launch to settle and up to
 * 5 s for the owned processes to exit, removes the material profile once its
 * browser is gone and returns anything still running. Rejects when `pgrep` fails, because nothing then proves the
 * round's processes exited.
 */
function cleanup(): Promise<string[]> {
  // A signal during the round's own cleanup joins it instead of starting a second one.
  cleaning ??= cleanupOnce();
  return cleaning;
}
async function cleanupOnce(): Promise<string[]> {
  await owned.sampler?.stop();
  await stopGroup(owned.build?.pid);
  stopBusy();
  stopFixture();
  // `open` returns once Launch Services started Chrome; before that, nothing matches the profile yet.
  const material = owned.material;
  if (material && material.exitCode === null && material.signalCode === null) {
    await Promise.race([new Promise((resolve) => material.once("exit", resolve)), sleep(10_000)]);
  }
  owned.desktop?.end();
  for (let i = 0; i < 10; i += 1) {
    signalPids(materialPids(), "SIGTERM");
    if (stillRunning().length === 0) break;
    await sleep(500);
  }
  const left = stillRunning();
  if (material && material.exitCode === null && material.signalCode === null) left.push("the material launch (`open`), which may still start Chrome");
  else if (owned.materialProfile && materialPids().length === 0) {
    const problem = await removeMaterialProfile(owned.materialProfile);
    if (problem) left.push(problem);
    else delete owned.materialProfile;
  }
  return left;
}

let interrupted = false;
/**
 * After a signal the handler owns cleanup and the exit code; stopping the
 * fixture also releases `open -W`, so the round must not go on to write a
 * summary or exit first.
 */
const halt = (): Promise<never> => new Promise<never>(() => undefined);
function interrupt(signal: "SIGINT" | "SIGTERM"): void {
  if (interrupted) return;
  interrupted = true;
  console.error(`${signal}: stopping this round's build, fixture, load and material; no summary is written`);
  void interruptExitCode(signal, cleanup).then((exit) => process.exit(exit));
}
process.on("SIGINT", () => interrupt("SIGINT"));
process.on("SIGTERM", () => interrupt("SIGTERM"));

interface FixtureResult {
  outcome: string;
  /** The host's messages as the fixture received them, `at` an ISO time. */
  messages?: { at: string; type: string; detail?: unknown }[];
  bytes: number;
  capture?: { frameRate?: number; width?: number; height?: number; videoBitsPerSecond: number; warnings: string[] };
  versions?: Record<string, string>;
  display?: { displayFrequency?: number };
  probe: {
    requests: { call: string; asked: unknown; used: unknown }[];
    frames: { timestamp: number | null; at: number }[];
    samples: { at: number; delivered?: number; discarded?: number; total?: number; frameRate?: number }[];
    recorderStart?: number;
    recorderStop?: number;
    processor: string;
    errors: string[];
  } | null;
}

interface RunReport {
  index: number;
  setting: FrameRate;
  request: Request | null;
  load: number;
  outcome: string;
  dir: string;
  error?: string;
  requests?: { call: string; asked: unknown; used: unknown }[];
  versions?: Record<string, string>;
  captureFrameRate?: number;
  displayFrequency?: number;
  settingsFrameRates?: number[];
  delivered?: CadenceStats;
  arrival?: CadenceStats;
  file?: CadenceStats;
  fileAverageFps?: number;
  trackCounters?: CounterDelta;
  /** Absent when the sampler could not cover the recording (`error` says why): never a 0% that was not measured. */
  cpu?: { averagePercent: number; peakPercent: number };
  layer?: CadenceLayer;
  reason?: string;
}

function analyse(run: RunReport, result: FixtureResult, recording: string): void {
  const p = result.probe;
  run.outcome = result.outcome;
  if (result.capture?.frameRate !== undefined) run.captureFrameRate = result.capture.frameRate;
  if (result.display?.displayFrequency !== undefined) run.displayFrequency = result.display.displayFrequency;
  if (result.versions) run.versions = result.versions;
  if (!p) { run.error = "renderer probe missing"; return; }
  run.requests = p.requests;
  const begin = p.recorderStart ?? 0;
  const end = p.recorderStop ?? Number.POSITIVE_INFINITY;
  const during = p.frames.filter((frame) => frame.at >= begin && frame.at <= end);
  const stamped = during.map((frame) => frame.timestamp).filter((t): t is number => typeof t === "number").map((t) => t / 1e6);
  const delivered = cadenceStats(stamped, run.setting);
  if (delivered) run.delivered = delivered;
  const arrival = cadenceStats(during.map((frame) => frame.at / 1000), run.setting);
  if (arrival) run.arrival = arrival;
  const rates = [...new Set(p.samples.filter((s) => s.at >= begin).map((s) => s.frameRate).filter((r): r is number => r !== undefined).map((r) => Math.round(r * 100) / 100))];
  run.settingsFrameRates = rates;
  const counters = counterDelta(p.samples, begin, end);
  if (counters) run.trackCounters = counters;
  if (p.errors.length > 0) run.error = p.errors.join("; ");
  if (fs.existsSync(recording) && fs.statSync(recording).size > 0) {
    // A torn or unreadable file fails this run only; the summary still keeps the runs before it.
    try {
      const [times] = frameTimes(recording, undefined);
      const file = cadenceStats(times ?? [], run.setting);
      if (file) run.file = file;
      const video = probe(recording).info.streams.find((s) => s.codec_type === "video");
      const frames = Number(video?.nb_read_frames);
      const duration = Number(video?.duration);
      if (Number.isFinite(frames) && Number.isFinite(duration) && duration > 0) run.fileAverageFps = frames / duration;
    } catch (cause) {
      const problem = `recording.mp4 not analysed: ${cause instanceof Error ? cause.message : String(cause)}`;
      run.error = run.error ? `${run.error}; ${problem}` : problem;
    }
  }
  const classified = classifyCadence({
    nominalFps: run.setting, delivered: run.delivered, file: run.file,
    discardedFrames: run.trackCounters?.discarded, totalFrames: run.trackCounters?.total,
  });
  run.layer = classified.layer;
  run.reason = classified.reason;
}

async function recordOnce(run: RunReport, fixture: string, config: object, seconds: number): Promise<void> {
  fs.mkdirSync(run.dir, { recursive: true });
  fs.writeFileSync(path.join(run.dir, "config.json"), JSON.stringify(config, null, 2));
  for (let i = 0; i < run.load; i += 1) owned.busy.add(spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }));
  const env = scrubbedEnv();
  const started = Date.now();
  const child = spawn("open", ["-W", "-n", "-a", ELECTRON_APP, "--args", fixture, run.dir], { env, stdio: "ignore" });
  let exited = false;
  const launcherExited = new Promise<void>((resolve) => child.on("exit", () => { exited = true; resolve(); }));
  let sampler: CpuSampler | undefined;
  const deadline = (seconds + 60) * 1000;
  try {
    while (!exited) {
      await sleep(1000);
      const main = sampler ? undefined : electronMainPid();
      if (main !== undefined) owned.sampler = sampler = new CpuSampler(samplerBinary, main);
      if (Date.now() - started > deadline) {
        // As matrix and finalization stop a take (dev-app.mts): SIGTERM, a grace, then SIGKILL. A stuck fixture left
        // running would add its CPU to every later run's average without an error to show for it.
        const stop = await stopDevApp(ELECTRON_APP_REAL, { launchedAt: started });
        run.error = `fixture still running after ${deadline / 1000} s; ${stop === "forced" ? `killed after ${QUIT_GRACE_MS / 1000} s` : "terminated"}`;
        // The next run's `open` must launch a new fixture, not bring this one forward.
        await Promise.race([launcherExited, sleep(LAUNCHER_EXIT_MS)]);
        const left = electronPids();
        if (left.length > 0) throw new Error(`fixture processes ${left.join(", ")} survived SIGKILL; stopping the round`);
        break;
      }
    }
  } finally {
    stopBusy();
    await sampler?.stop();
    delete owned.sampler;
  }
  const resultPath = path.join(run.dir, "result.json");
  if (!fs.existsSync(resultPath)) {
    run.error ??= "fixture wrote no result.json (see fixture.log)";
    return;
  }
  // Like a torn recording, a torn result (a fixture stopped mid-write) fails this run only.
  let result: FixtureResult;
  try { result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as FixtureResult; }
  catch (cause) {
    const problem = `result.json unreadable: ${cause instanceof Error ? cause.message : String(cause)}`;
    run.error = run.error ? `${run.error}; ${problem}` : problem;
    return;
  }
  analyse(run, result, path.join(run.dir, "recording.mp4"));
  // Judged over the recording itself, from the host's started to its stopped: not the launch, the save or the quit.
  const at = (type: string): number | undefined => {
    const message = result.messages?.find((entry) => entry.type === type);
    return message ? Date.parse(message.at) : undefined;
  };
  const from = at("started"), to = at("stopped");
  // As matrix accepts a case's CPU: only over a recording with both ends, nearly all of it sampled, by a sampler that
  // ran to the end. A run that never reported stopped would otherwise average in its stop timeout.
  const bounded = from !== undefined && to !== undefined && Number.isFinite(from) && Number.isFinite(to) && to > from;
  const summary = sampler && bounded ? summarize(intervals(sampler.samples), from, to) : undefined;
  const windowSeconds = bounded ? (to - from) / 1000 : 0;
  const cpuProblem = !sampler ? "the sampler never found the fixture's main process"
    : sampler.failure ? sampler.failure
      : !bounded ? "the recording's start or stop was not reported"
        : !summary?.judged ? "no one-second interval fell inside the recording"
          : summary.seconds < windowSeconds * MIN_COVERAGE
            ? `only ${summary.seconds.toFixed(0)} s of the ${windowSeconds.toFixed(0)} s recording was sampled` : undefined;
  if (summary && !cpuProblem) run.cpu = { averagePercent: summary.cpuPercent.average, peakPercent: summary.cpuPercent.max };
  else run.error = run.error ? `${run.error}; CPU not measured: ${cpuProblem}` : `CPU not measured: ${cpuProblem}`;
}

const f = (value: number | undefined, digits = 2): string => (value === undefined ? "—" : value.toFixed(digits));

function describeStats(stats: CadenceStats | undefined): string {
  if (!stats) return "—";
  return `${f(stats.averageFps)} fps; median ${f(stats.medianIntervalMs)} ms (p05 ${f(stats.p05IntervalMs)}, p95 ${f(stats.p95IntervalMs)}, min ${f(stats.minIntervalMs)}, max ${f(stats.maxIntervalMs)}); short ${stats.short}, on-period ${stats.onPeriod}, doubled ${stats.doubled} of ${stats.frames - 1}`;
}

function markdown(runs: RunReport[], env: Record<string, string | undefined>, options: Options, desktop: string): string {
  const lines = [
    `# Frame-cadence diagnostic${options.label ? ` — ${options.label}` : ""}`,
    "",
    `Environment: ${Object.entries(env).map(([k, v]) => `${k} ${v ?? "unknown"}`).join("; ")}.`,
    `Material: scripts/test-material.html${options.openMaterial ? " (Chrome kiosk, primary display)" : " (opened manually)"}; ${options.seconds} s per run; load ${options.load} busy process(es).`,
    desktop,
    "",
    "| Run | Setting | Request | Layer | Delivered (track, before MediaRecorder) | File pts | Track counters | getSettings fps | CPU avg |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...runs.map((run) => `| ${run.index} | ${run.setting} | ${run.request ? JSON.stringify(run.request) : "product"} | ${run.layer ?? "—"} | ${describeStats(run.delivered)} | ${describeStats(run.file)}; container ${f(run.fileAverageFps)} fps | ${run.trackCounters ? `delivered ${run.trackCounters.delivered ?? "?"}, discarded ${run.trackCounters.discarded ?? "?"}, total ${run.trackCounters.total ?? "?"}` : "unavailable"} | ${run.settingsFrameRates?.join(", ") || "—"} | ${run.cpu ? `${f(run.cpu.averagePercent, 0)}%` : "—"} |`),
    "",
    ...runs.flatMap((run) => [
      `- Run ${run.index}: ${run.outcome}${run.error ? `; error: ${run.error}` : ""}. Arrival (performance.now): ${describeStats(run.arrival)}. ${run.reason ?? ""} Requests: ${JSON.stringify(run.requests ?? [])}. Evidence: ${path.basename(run.dir)}/`,
    ]),
    "",
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--")));
  if (process.platform !== "darwin") usage("the cadence diagnostic requires macOS");
  requireMediaTimeout();
  if (!hasTool("ffprobe")) { console.error("BLOCKED: ffprobe missing (brew install ffmpeg). Nothing was recorded."); process.exit(2); }
  if (electronPids().length > 0 || recordStuffPids().length > 0) {
    // A missing prerequisite, as the other runners say it (blocked, 2), not a failed round.
    console.error("BLOCKED: RecordStuff or this project's Electron.app is running; quit it first so only the diagnostic captures. Nothing was recorded.");
    process.exit(2);
  }
  const desktop = await beginDesktopRound().catch((cause: unknown) => {
    if (cause instanceof DesktopBlockedError) { console.error(`BLOCKED: ${cause.message} Nothing was recorded.`); process.exit(DESKTOP_BLOCKED_EXIT); }
    throw cause;
  });
  owned.desktop = desktop;
  const dir = path.join(MEASUREMENTS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-frame-cadence`);
  fs.mkdirSync(dir, { recursive: true });
  try { samplerBinary = compileSampler(path.join(dir, "cpu-sampler")); }
  catch (cause) {
    // The handler owns an interrupt's cleanup and exit (130/143); missing Command Line Tools block the round.
    if (cause instanceof SamplerInterruptedError) await halt();
    if (!(cause instanceof SamplerBlockedError)) throw cause;
    desktop.end();
    console.error(`BLOCKED: ${cause.message}; every run reports its CPU. Nothing was recorded.`);
    process.exit(2);
  }
  console.log(`Frame-cadence diagnostic: rates ${options.rates.join(", ")}; ${options.runs} run(s) each; ${options.seconds} s; load ${options.load}; evidence ${dir}`);
  if (interrupted) await halt();
  console.log("electron-vite build …");
  // Asynchronous and in its own process group: a signal meanwhile reaches the handler, which stops the build.
  const build = startBuild(REPO_ROOT);
  owned.build = build.child;
  const built = await build.done;
  if (interrupted) await halt();
  if (built !== 0) { desktop.end(); process.exit(built); }
  const fixture = await buildFixture("frame-cadence", dir);
  owned.fixture = fixture;
  const rendererScript = await buildFixture("frame-cadence-renderer", dir);
  const preloadPath = path.join(REPO_ROOT, "out/preload/index.js");

  const runs: RunReport[] = [];
  let left: string[] = [];
  const env = environment();
  try {
    if (options.openMaterial) {
      owned.materialProfile = createMaterialProfile("cadence");
      owned.material = spawn("open", materialOpenArgs(MATERIAL, owned.materialProfile), { stdio: "ignore" });
      console.log("Opened the test material in Chrome kiosk on the primary display; waiting 5 seconds");
    } else console.log(`Open ${path.relative(REPO_ROOT, MATERIAL)} full screen on the primary display; starting in 5 seconds`);
    await sleep(5000);
    // Rates interleave, one run of each per pass, so a drift over the round reaches every rate alike.
    const order = Array.from({ length: options.runs }, () => options.rates).flat();
    for (const [i, setting] of order.entries()) {
      if (i > 0) await sleep(REST_SECONDS * 1000);
      if (interrupted) await halt();
      const request = requestFor(options, setting);
      const quality: QualitySettings = { videoQuality: "standard", resolutionCap: "source", frameRate: setting };
      const run: RunReport = {
        index: i + 1, setting, request, load: options.load, outcome: "not run",
        dir: path.join(dir, `run-${i + 1}-${setting}fps`),
      };
      console.log(`▶ Run ${run.index}: ${setting} fps, request ${request ? JSON.stringify(request) : "product"}${options.load ? `, load ${options.load}` : ""}`);
      await recordOnce(run, fixture, { seconds: options.seconds, quality, request, preloadPath, rendererScript }, options.seconds);
      if (interrupted) await halt();
      runs.push(run);
      console.log(`  ${run.outcome}${run.error ? ` (${run.error})` : ""}; layer ${run.layer ?? "—"}`);
      console.log(`  delivered: ${describeStats(run.delivered)}`);
      console.log(`  file:      ${describeStats(run.file)}; container ${f(run.fileAverageFps)} fps`);
      console.log(`  counters:  ${JSON.stringify(run.trackCounters ?? "unavailable")}; getSettings ${run.settingsFrameRates?.join(", ") || "—"}; CPU ${run.cpu ? `${f(run.cpu.averagePercent, 0)}%` : "not measured"}`);
    }
  } finally {
    if (interrupted) await halt();
    left = await cleanup();
    // A signal during that wait belongs to the handler too (review pass 2).
    if (interrupted) await halt();
  }
  if (left.length > 0) console.error(`CLEANUP INCOMPLETE: ${left.join("; ")} still running`);
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ options, environment: env, desktop: desktop.summary, runs }, null, 2));
  fs.writeFileSync(path.join(dir, "summary.md"), markdown(runs, env, options, desktop.summary));
  console.log(`\nSummary: ${path.join(dir, "summary.md")}`);
  // Leftovers fail the round even when the screen locked, so the next round never starts over them (round-exit.mts).
  if (desktop.lockedAt && left.length === 0) process.exit(DESKTOP_BLOCKED_EXIT);
  const complete = runs.every((run) => run.outcome === "stopped" && !run.error && run.delivered && run.file && run.layer !== "undetermined");
  process.exit(complete && left.length === 0 ? 0 : 1);
}

void main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.stack ?? cause.message : String(cause));
  process.exit(1);
});
