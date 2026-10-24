#!/usr/bin/env node
/**
 * `pnpm bench:editable [-- --seconds 60] [--repeat 3] [--label name] [--app-r 12.2]`
 *
 * Plan 087's step 1: what the editable recording costs over today's, without a desktop. Each recording runs the
 * engine's own core, VideoToolbox encoders, AAC encoders and writer on synthetic capture at real time
 * (native/capture/src/mac/editable_bench.rs): a moving 1080p screen handed over at 60 Hz, a 720p camera at 30 fps and
 * two inputs' sound, recorded at 30 fps. `direct` is today's recording with the camera composed and the sound mixed;
 * `editable` keeps the screen, the camera and each input on tracks of their own. The modes alternate, `--repeat`
 * recordings each (odd, medians judged), and the shared CPU sampler follows each recording's process and
 * VideoToolbox's encoder service once a second, judged from its fifth second to five before its end.
 *
 * Judged against 087's provisional budgets: the app's CPU at most 1.5 times the direct mode's, estimated as the app's
 * recorded R with the camera (`--app-r`, plan 090's 12.2% at 30 fps) plus the engine's increase, and at most 256 MiB
 * more resident memory. Disk use a minute and the encoder service are reported. Needs Rust, macOS and the Command
 * Line Tools; no screen, camera or microphone permission, and it never records the screen. Evidence goes to
 * `docs/verification/measurements/<timestamp>-editable-<label>/`. Exit 1 when a budget failed or a recording's
 * evidence is unusable, 2 when blocked or given bad arguments.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runnerArgs, scrubbedEnv } from "./lib/runner/runner-env.mts";
import { ENCODER_SERVICE, CpuSampler, SamplerBlockedError, compileSampler, intervals, summarize } from "./lib/verification/cpu-sampler.mts";
import { APP_CAMERA_R_30, figures, judge, problems, type BenchLine, type Mode, type Run } from "./lib/verification/editable-bench.mts";
import { MEASUREMENTS_DIR, REPO_ROOT } from "./lib/verification/verify-recording.mts";

interface Options { seconds: number; repeat: number; label: string; appR: number }

function usage(message?: string): never {
  if (message) console.error(message);
  console.error("usage: pnpm bench:editable -- [--seconds 60] [--repeat 3] [--label name] [--app-r 12.2]");
  process.exit(2);
}

function parseOptions(argv: string[]): Options {
  const options: Options = { seconds: 60, repeat: 3, label: "", appR: APP_CAMERA_R_30 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (): string => { const next = argv[++i]; if (next === undefined || next.startsWith("--")) usage(`${arg} needs a value`); return next; };
    if (arg === "--seconds") options.seconds = Number(value());
    else if (arg === "--repeat") options.repeat = Number(value());
    else if (arg === "--label") options.label = value();
    else if (arg === "--app-r") options.appR = Number(value());
    else usage(`unknown argument ${arg}`);
  }
  if (!(Number.isInteger(options.seconds) && options.seconds >= 20 && options.seconds <= 600)) usage("--seconds must be 20–600");
  if (!(Number.isInteger(options.repeat) && options.repeat >= 1 && options.repeat <= 9 && options.repeat % 2 === 1)) usage("--repeat must be odd, 1–9");
  if (!/^[\w.-]*$/.test(options.label)) usage("--label may use letters, digits, dot, dash and underscore");
  if (!(Number.isFinite(options.appR) && options.appR > 0)) usage("--app-r must be a positive percentage");
  return options;
}

const MANIFEST = path.join(REPO_ROOT, "native/capture/Cargo.toml");

/** Builds the engine's test binary once, so no recording includes compiling; returns its path. */
function buildBench(): string {
  console.log("Building the engine's bench (cargo test --release --no-run)…");
  const built = spawnSync("cargo", ["test", "--release", "--manifest-path", MANIFEST, "--lib", "--no-run", "--message-format=json"], {
    cwd: REPO_ROOT, env: scrubbedEnv(), encoding: "utf8", maxBuffer: 256 * 1024 ** 2, stdio: ["ignore", "pipe", "inherit"],
  });
  if (built.error || built.status !== 0) { console.error(`BLOCKED: the engine's bench did not build${built.error ? `: ${built.error.message}` : ""}`); process.exit(2); }
  for (const text of built.stdout.split("\n").reverse()) {
    if (!text.startsWith("{")) continue;
    const message = JSON.parse(text) as { reason?: string; executable?: string | null; target?: { kind?: string[] } };
    if (message.reason === "compiler-artifact" && message.executable && message.target?.kind?.some((kind) => kind === "lib" || kind === "rlib")) return message.executable;
  }
  console.error("BLOCKED: cargo named no test executable for the engine's library");
  process.exit(2);
}

/** One recording in `mode`: the bench's line and the sampler's figures over its judged window. */
async function record(binary: string, sampler: string, mode: Mode, round: number, options: Options, out: string): Promise<Run | string> {
  const file = path.join(out, `bench-${mode}-${round}.mp4`);
  const child = spawn(binary, ["--ignored", "--exact", "mac::session::editable_bench::editable_bench", "--nocapture", "--test-threads", "1"], {
    cwd: REPO_ROOT,
    env: { ...scrubbedEnv(), EDITABLE_BENCH_MODE: mode, EDITABLE_BENCH_SECONDS: String(options.seconds), EDITABLE_BENCH_OUT: file },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const cpu = new CpuSampler(sampler, child.pid!, [ENCODER_SERVICE]);
  let stdout = "", stderr = "";
  let recordingStart: number | undefined;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (recordingStart === undefined && stdout.includes("EDITABLE_BENCH_RECORDING")) recordingStart = Date.now();
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const code = await new Promise<number>((resolve) => child.on("exit", (exit) => resolve(exit ?? 1)));
  await cpu.stop();
  fs.writeFileSync(path.join(out, `bench-${mode}-${round}.log`), `${stdout}\n--- stderr ---\n${stderr}`);
  fs.rmSync(file, { force: true });
  const text = stdout.split("\n").find((entry) => entry.startsWith("EDITABLE_BENCH "));
  if (code !== 0 || !text || recordingStart === undefined) return `${mode} round ${round}: the recording failed (exit ${code}); see bench-${mode}-${round}.log`;
  if (cpu.failure) return `${mode} round ${round}: ${cpu.failure}`;
  const line = JSON.parse(text.slice("EDITABLE_BENCH ".length)) as BenchLine;
  // Building the frames and preparing come before the recording; its last seconds include stopping and the file's end.
  const from = recordingStart + 5000, to = recordingStart + (options.seconds - 5) * 1000;
  const summary = summarize(intervals(cpu.samples), from, to);
  if (summary.judged < (options.seconds - 10) * 0.8) return `${mode} round ${round}: the sampler covered ${summary.judged} s of the ${options.seconds - 10} judged`;
  return { mode, round, line, engineCpu: summary.cpuPercent.average, encoderCpu: summary.followed.cpuPercent.average, residentBytes: summary.maxResidentBytes };
}

async function main(): Promise<void> {
  const options = parseOptions(runnerArgs());
  if (process.platform !== "darwin") { console.error("BLOCKED: the editable recording is a macOS prototype"); process.exit(2); }
  const out = path.join(MEASUREMENTS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-editable${options.label ? `-${options.label}` : ""}`);
  fs.mkdirSync(out, { recursive: true });
  let sampler: string;
  try { sampler = compileSampler(out); } catch (error) {
    if (error instanceof SamplerBlockedError) { console.error(`BLOCKED: ${error.message}`); process.exit(2); }
    throw error;
  }
  const binary = buildBench();
  console.log(`Editable recording benchmark: ${options.repeat} recording(s) a mode of ${options.seconds} s, alternating; evidence ${out}`);
  const runs: Run[] = [];
  const failures: string[] = [];
  for (let round = 1; round <= options.repeat; round += 1) {
    // Alternated, so neither mode always runs on a warmer machine.
    for (const mode of (round % 2 ? ["direct", "editable"] : ["editable", "direct"]) as Mode[]) {
      const run = await record(binary, sampler, mode, round, options, out);
      if (typeof run === "string") { failures.push(run); console.error(`FAILED: ${run}`); continue; }
      const found = problems(run);
      if (found.length) failures.push(...found.map((problem) => `${mode} round ${round}: ${problem}`));
      runs.push(run);
      console.log(`${mode} round ${round}: engine ${run.engineCpu.toFixed(2)}%, encoder service ${run.encoderCpu.toFixed(2)}%, resident ${(run.residentBytes / 1024 ** 2).toFixed(0)} MiB, ${run.line.tracks.length} tracks, ${(run.line.fileBytes / 1024 ** 2).toFixed(1)} MiB${found.length ? ` — ${found.join("; ")}` : ""}`);
    }
  }
  const direct = figures(runs, "direct"), editable = figures(runs, "editable");
  const verdicts = direct && editable ? judge(direct, editable, options.appR) : [];
  const failed = failures.length > 0 || !direct || !editable || verdicts.some((verdict) => verdict.verdict === "fail");
  const mib = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  const trackNames = ["screen", "system sound", "microphone", "camera"];
  const summary = [
    `# Editable recording benchmark — ${options.label || "unlabelled"}`,
    "",
    `- Run: ${new Date().toISOString()} on ${os.cpus()[0]?.model ?? "?"}, macOS ${os.release()}; ${options.repeat} recording(s) a mode of ${options.seconds} s, alternating, medians below`,
    "- Synthetic capture through the engine's own core, encoders and writer at real time: 1920×1080 at 60 Hz, a 1280×720 camera at 30 fps, two inputs' sound; recorded at 30 fps, 12 Mbps",
    `- CPU is percent of one core, the bench process judged from its fifth second to five before its end; the app's is estimated as R ${options.appR}% (with the camera, 30 fps) plus the engine's increase`,
    "",
    "| Check | Limit | Actual | Verdict |",
    "| --- | --- | --- | --- |",
    ...verdicts.map((verdict) => `| ${verdict.check} | ${verdict.limit} | ${verdict.actual} | ${verdict.verdict.toUpperCase()} |`),
    "",
    "| Mode | Engine CPU | Encoder service | Resident peak | File a minute | Tracks a minute |",
    "| --- | --- | --- | --- | --- | --- |",
    ...([["direct", direct], ["editable", editable]] as const).map(([mode, f]) => (f
      ? `| ${mode} | ${f.engineCpu.toFixed(2)}% | ${f.encoderCpu.toFixed(2)}% | ${mib(f.residentBytes)} | ${mib(f.fileBytesPerMinute)} | ${f.trackBytesPerMinute.map((bytes, index) => `${mode === "direct" ? ["screen with camera", "mixed sound"][index] : trackNames[index]} ${mib(bytes)}`).join(", ")} |`
      : `| ${mode} | — | — | — | — | — |`)),
    "",
    ...(failures.length ? ["## Problems", "", ...failures.map((failure) => `- ${failure}`), ""] : []),
    "## Every recording",
    "",
    "```",
    ...runs.map((run) => JSON.stringify(run)),
    "```",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(out, "summary.md"), summary);
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify({ options, runs, direct, editable, verdicts, failures }, null, 2));
  console.log(`\n${summary.split("## Every recording")[0]}`);
  console.log(failed ? "Result: FAIL" : "Result: PASS");
  process.exit(failed ? 1 : 0);
}

await main();
