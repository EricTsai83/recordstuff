#!/usr/bin/env node
/**
 * `pnpm echo:bench -- material <new-directory> [--seed <n>] [--voices say|synthetic]`
 * `pnpm echo:bench -- analyze <condition-directory> <output.wav>`
 * `pnpm echo:bench -- baseline <material-directory>`
 * `pnpm echo:bench -- aac <material-directory> <new-directory>`
 * `pnpm echo:bench -- run <material-directory> <c1|c2|c3|none> [--two-pass]`
 * `pnpm echo:bench -- compare <material-directory> <candidate> [<baseline>]`
 *
 * Plan 096's echo-removal bench (docs/system-design/tooling.md#echo-removal-bench). `material` writes stage A's
 * simulated takes, one directory per condition: `mic.wav` (mono), `reference.wav` (stereo, what the system track would
 * hold), `ideal.wav` (the microphone without the echo), `echo.wav` and `take.json` (condition, seed, script, events,
 * sources and environment). `analyze` measures a canceller's output for one condition and prints the JSON report; exit
 * 0 when every applicable gate passed, 1 when one failed, 2 for invalid input or a usage error. `baseline`
 * analyzes the raw microphone (no canceller) and the ideal output (a perfect one) for every condition and writes
 * `baseline.json`: the analyzer's floor and ceiling on that material. `aac` copies material with its microphone and
 * reference through macOS's AAC encoder at 256 kbps and back (the app's tracks, plan 096's D3), lined up again with the
 * originals; the ideal stays as it was. `run` builds the offline bench (`native/echo-bench`), processes every condition
 * with the candidate (`out-<candidate>.wav`, the analyzer's `report-<candidate>.json` beside it) and writes
 * `run-<candidate>.json` with each condition's verdict and failed checks, the slowest real-time factor and the largest
 * peak memory (`/usr/bin/time -l`). Exit 0 when every condition passed. `compare` reads two runs' reports (the baseline
 * `none` by default: the microphone unprocessed) and writes `compare-<candidate>.md` and `.json`: per condition and in
 * medians, how much echo each removed, how much each changed a voice with no echo and how much of the voice each kept
 * in double-talk, with the frozen gates' verdicts. Nothing here ships with the app.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runnerArgs } from "./lib/runner/runner-env.mts";
import { RATE, readWav, writeWav } from "./lib/audio/echo-dsp.mts";
import { FAR_SENTENCES, FAR_VOICES, NEAR_SENTENCES, NEAR_VOICES, SCRIPT_SECONDS, buildTake, music, sayVoice, stageAConditions, syntheticVoice, tones, type Condition, type Segment, type VolumeEvent } from "./lib/audio/echo-material.mts";
import { analyzeEcho, type EchoReport } from "./lib/audio/echo-analyze.mts";
import { findOffset } from "./lib/audio/echo-stage-b.mts";

const usage = "usage: pnpm echo:bench -- material <new-directory> [--seed <n>] [--voices say|synthetic] | analyze <condition-directory> <output.wav> | baseline <material-directory> | aac <material-directory> <new-directory> | run <material-directory> <c1|c2|c3|none> [--two-pass] | compare <material-directory> <candidate> [<baseline>]";
function fail(message: string): never {
  console.error(`${message}\n${usage}`);
  process.exit(2);
}
const [mode, given, ...rest] = runnerArgs();
const target = given ?? fail("Missing arguments.");

interface TakeFile { condition: Condition; seed: number; script: Segment[]; events: VolumeEvent[]; delaySamples: number }
const mono = (file: string): Float32Array => {
  const { rate, channels } = readWav(fs.readFileSync(file));
  if (rate !== RATE) throw new Error(`${file}: ${rate} Hz, expected ${RATE}`);
  if (channels.length === 1) return channels[0]!;
  // A stereo output is read as its mean: the microphone track is mono.
  return Float32Array.from(channels[0]!, (_, i) => channels.reduce((sum, c) => sum + c[i]!, 0) / channels.length);
};
const analyzeCondition = (directory: string, output: Float32Array): EchoReport => {
  const take = JSON.parse(fs.readFileSync(path.join(directory, "take.json"), "utf8")) as TakeFile;
  return analyzeEcho({ input: mono(path.join(directory, "mic.wav")), output, ideal: mono(path.join(directory, "ideal.wav")), script: take.script, events: take.events });
};

if (mode === "material") {
  let seed = 96, voices: "say" | "synthetic" = process.platform === "darwin" ? "say" : "synthetic";
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] === "--seed" && Number.isInteger(Number(rest[i + 1]))) seed = Number(rest[i + 1]);
    else if (rest[i] === "--voices" && (rest[i + 1] === "say" || rest[i + 1] === "synthetic")) voices = rest[i + 1] as typeof voices;
    else fail(`Unknown option ${rest[i]}.`);
  }
  const root = path.resolve(target);
  // A new directory only: earlier material and its reports are evidence and are never overwritten.
  fs.mkdirSync(root);
  const seconds = SCRIPT_SECONDS + 10;
  const near = voices === "say" ? sayVoice(NEAR_VOICES, NEAR_SENTENCES, seconds) : syntheticVoice(seconds, seed);
  const farSpeech = voices === "say" ? sayVoice(FAR_VOICES, FAR_SENTENCES, seconds) : syntheticVoice(seconds, seed + 1, 210);
  const sources = { speech: [farSpeech, farSpeech] as [Float32Array, Float32Array], music: music(seconds, seed + 2), tones: tones(seconds) };
  const environment = { date: new Date().toISOString(), platform: process.platform, release: os.release(), node: process.version, voices,
    ...(voices === "say" ? { nearVoices: NEAR_VOICES, farVoices: FAR_VOICES } : {}) };
  const conditions = stageAConditions();
  for (const [index, condition] of conditions.entries()) {
    const take = buildTake(condition, seed + index * 101, near, sources[condition.far]);
    const directory = path.join(root, condition.name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "mic.wav"), writeWav([take.mic]));
    fs.writeFileSync(path.join(directory, "reference.wav"), writeWav(take.reference));
    fs.writeFileSync(path.join(directory, "ideal.wav"), writeWav([take.ideal]));
    fs.writeFileSync(path.join(directory, "echo.wav"), writeWav([take.echo]));
    const file: TakeFile & { environment: typeof environment } = { condition, seed: take.seed, script: take.script, events: take.events, delaySamples: take.delaySamples, environment };
    fs.writeFileSync(path.join(directory, "take.json"), `${JSON.stringify(file, null, 2)}\n`);
    console.log(`${condition.name} → ${directory}`);
  }
  fs.writeFileSync(path.join(root, "material.json"), `${JSON.stringify({ seed, conditions: conditions.map(c => c.name), environment }, null, 2)}\n`);
} else if (mode === "analyze") {
  if (rest.length !== 1) fail("analyze takes a condition directory and an output WAV.");
  let report: EchoReport;
  try {
    report = analyzeCondition(path.resolve(target), mono(path.resolve(rest[0]!)));
  } catch (cause) {
    // A missing or unreadable file is an invalid input (2), never a measured failure (1).
    console.error(`Invalid input: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(2);
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.verdict === "pass" ? 0 : report.verdict === "invalid" ? 2 : 1;
} else if (mode === "baseline") {
  if (rest.length) fail("baseline takes only the material directory.");
  const root = path.resolve(target);
  let conditions: string[];
  try {
    ({ conditions } = JSON.parse(fs.readFileSync(path.join(root, "material.json"), "utf8")) as { conditions: string[] });
  } catch (cause) {
    console.error(`Invalid input: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(2);
  }
  const rows = conditions.map(name => {
    const directory = path.join(root, name);
    const raw = analyzeCondition(directory, mono(path.join(directory, "mic.wav")));
    const ideal = analyzeCondition(directory, mono(path.join(directory, "ideal.wav")));
    const row = { condition: name, echoToVoiceDb: raw.raw.echoToVoiceDb, raw: { verdict: raw.verdict, erleDb: raw.erle.full.median },
      ideal: { verdict: ideal.verdict, erleDb: ideal.erle.full.median, failed: ideal.checks.filter(c => c.pass === false).map(c => c.metric) } };
    console.log(`${name}: echo/voice ${row.echoToVoiceDb?.toFixed(1) ?? "n/a"} dB; raw ${raw.verdict} (ERLE ${raw.erle.full.median?.toFixed(1) ?? "n/a"} dB); ideal ${ideal.verdict} (ERLE ${ideal.erle.full.median?.toFixed(1) ?? "n/a"} dB)`);
    return row;
  });
  fs.writeFileSync(path.join(root, "baseline.json"), `${JSON.stringify({ date: new Date().toISOString(), rows }, null, 2)}\n`);
  // The analyzer itself is wrong if a perfect canceller fails or no canceller passes a condition with echo.
  process.exitCode = rows.every(r => r.ideal.verdict === "pass" && (r.echoToVoiceDb === null || r.raw.verdict === "fail")) ? 0 : 1;
} else if (mode === "aac") {
  if (rest.length !== 1) fail("aac takes a material directory and a new directory.");
  const from = path.resolve(target), to = path.resolve(rest[0]!);
  let conditions: string[];
  try { ({ conditions } = JSON.parse(fs.readFileSync(path.join(from, "material.json"), "utf8")) as { conditions: string[] }); }
  catch (cause) { console.error(`Invalid input: ${cause instanceof Error ? cause.message : String(cause)}`); process.exit(2); }
  fs.mkdirSync(to);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-echo-aac-"));
  try {
    for (const name of conditions) {
      const source = path.join(from, name), copy = path.join(to, name);
      fs.cpSync(source, copy, { recursive: true });
      for (const file of ["mic.wav", "reference.wav"]) {
        const original = readWav(fs.readFileSync(path.join(source, file)));
        const encoded = path.join(scratch, "track.m4a"), decoded = path.join(scratch, "track.wav");
        for (const argv of [["-i", path.join(source, file), "-c:a", "aac_at", "-b:a", "256k", encoded], ["-i", encoded, "-c:a", "pcm_f32le", "-ar", String(RATE), decoded]]) {
          const result = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-y", ...argv], { encoding: "utf8", timeout: 120_000 });
          if (result.status !== 0) { console.error(`ffmpeg failed on ${name}/${file}: ${result.stderr}`); process.exit(2); }
        }
        const back = readWav(fs.readFileSync(decoded));
        // The encoder's priming may shift the decoded track: line it up with the original by the first channel.
        const early = findOffset(back.channels[0]!, original.channels[0]!, 4096), late = findOffset(original.channels[0]!, back.channels[0]!, 4096);
        const shift = early.score >= late.score ? early.lag : -late.lag;
        const aligned = back.channels.map(c => { const out = new Float32Array(original.channels[0]!.length); for (let i = 0; i < out.length; i++) out[i] = c[i + shift] ?? 0; return out; });
        fs.writeFileSync(path.join(copy, file), writeWav(aligned));
        console.log(`${name}/${file}: AAC 256 kbps, shifted ${shift} samples (correlation ${Math.max(early.score, late.score).toFixed(4)})`);
      }
      for (const stale of fs.readdirSync(copy).filter(f => /^(out|report)-/.test(f))) fs.rmSync(path.join(copy, stale));
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(to, "material.json"), `${JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(from, "material.json"), "utf8")), aac: { from, encoder: "aac_at", bitrate: "256k" } }, null, 2)}\n`);
} else if (mode === "run") {
  const candidate = rest[0];
  if (!candidate || !["c1", "c2", "c3", "none"].includes(candidate) || rest.length > 2 || (rest[1] !== undefined && rest[1] !== "--two-pass")) fail("run takes a material directory, a candidate and optionally --two-pass.");
  const twoPass = rest[1] === "--two-pass", label = `${candidate}${twoPass ? "-two-pass" : ""}`;
  const root = path.resolve(target);
  let conditions: string[];
  try { ({ conditions } = JSON.parse(fs.readFileSync(path.join(root, "material.json"), "utf8")) as { conditions: string[] }); }
  catch (cause) { console.error(`Invalid input: ${cause instanceof Error ? cause.message : String(cause)}`); process.exit(2); }
  const crate = path.join(path.dirname(fileURLToPath(import.meta.url)), "../native/echo-bench");
  // The Command Line Tools' own libc++ directory can be a partial leftover that hides the SDK's (seen 2026-10-29):
  // the SDK's headers are named explicitly.
  const sdk = process.platform === "darwin" ? spawnSync("xcrun", ["--show-sdk-path"], { encoding: "utf8" }).stdout.trim() : "";
  const env = sdk ? { ...process.env, CXXFLAGS: `-nostdinc++ -isystem ${sdk}/usr/include/c++/v1`, BINDGEN_EXTRA_CLANG_ARGS: `-isystem ${sdk}/usr/include/c++/v1` } : process.env;
  // The target directory is named, so CARGO_TARGET_DIR or a configured one never leaves an older binary to be run.
  const build = spawnSync("cargo", ["build", "--release", "--manifest-path", path.join(crate, "Cargo.toml"), "--target-dir", path.join(crate, "target")], { stdio: "inherit", env, timeout: 30 * 60_000 });
  if (build.status !== 0) { console.error("the bench did not build"); process.exit(2); }
  const binary = path.join(crate, "target/release/recordstuff-echo-bench");
  const rows = conditions.map(name => {
    const directory = path.join(root, name), output = path.join(directory, `out-${label}.wav`);
    const result = spawnSync("/usr/bin/time", ["-l", binary, directory, candidate, output, ...(twoPass ? ["--two-pass"] : [])], { encoding: "utf8", timeout: 10 * 60_000 });
    if (result.status !== 0) { console.error(`${name}: the bench failed: ${result.stderr}`); process.exit(2); }
    const timing = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { realtime: number; seconds: number };
    const peakBytes = Number(/(\d+)\s+maximum resident set size/.exec(result.stderr)?.[1] ?? NaN);
    const report = analyzeCondition(directory, mono(output));
    fs.writeFileSync(path.join(directory, `report-${label}.json`), `${JSON.stringify(report, null, 2)}\n`);
    const failed = report.checks.filter(c => c.pass === false).map(c => `${c.gate} ${c.metric}: ${c.value === null ? "n/a" : c.value.toFixed(2)}`);
    console.log(`${name}: ${report.verdict}; ${timing.realtime.toFixed(0)}x real time${failed.length ? `; failed: ${failed.join("; ")}` : ""}`);
    return { condition: name, verdict: report.verdict, realtime: timing.realtime, peakBytes, lagSamples: report.lagSamples, failed,
      erleDb: report.erle.full.median, voiceLossDb: report.doubleTalk.full.medianLossDb, dropoutFraction: report.doubleTalk.full.dropoutFraction, changeDb: report.nearEnd.full.changeDb };
  });
  const summary = { date: new Date().toISOString(), candidate, twoPass, gates: "frozen 2026-10-29", passed: rows.filter(r => r.verdict === "pass").length, conditions: rows.length,
    slowestRealtime: Math.min(...rows.map(r => r.realtime)), largestPeakBytes: Math.max(...rows.map(r => r.peakBytes)), rows };
  fs.writeFileSync(path.join(root, `run-${label}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`${label}: ${summary.passed}/${summary.conditions} conditions pass; slowest ${summary.slowestRealtime.toFixed(0)}x real time; peak ${(summary.largestPeakBytes / 2 ** 20).toFixed(1)} MiB`);
  process.exitCode = summary.passed === summary.conditions ? 0 : 1;
} else if (mode === "compare") {
  const [candidate, baseline = "none"] = rest;
  if (!candidate || rest.length > 2) fail("compare takes a material directory, a candidate and optionally a baseline.");
  const root = path.resolve(target);
  let conditions: string[];
  try { ({ conditions } = JSON.parse(fs.readFileSync(path.join(root, "material.json"), "utf8")) as { conditions: string[] }); }
  catch (cause) { console.error(`Invalid input: ${cause instanceof Error ? cause.message : String(cause)}`); process.exit(2); }
  const read = (name: string, label: string): EchoReport => {
    const file = path.join(root, name, `report-${label}.json`);
    if (!fs.existsSync(file)) { console.error(`Invalid input: no ${file}: run \`pnpm echo:bench -- run ${root} ${label}\` first`); process.exit(2); }
    return JSON.parse(fs.readFileSync(file, "utf8")) as EchoReport;
  };
  const figures = (r: EchoReport) => ({ verdict: r.verdict, erleDb: r.erle.full.median, changeDb: r.nearEnd.full.changeDb,
    voiceLossDb: r.doubleTalk.full.medianLossDb, voiceLossP95Db: r.doubleTalk.full.p95LossDb, dropoutFraction: r.doubleTalk.full.dropoutFraction,
    failed: r.checks.filter(c => c.pass === false).length });
  const rows = conditions.map(name => ({ condition: name, [baseline]: figures(read(name, baseline)), [candidate]: figures(read(name, candidate)) }) as Record<string, unknown> & { condition: string });
  const median = (values: (number | null)[]): number | null => {
    const v = values.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
    return v.length ? v[Math.floor((v.length - 1) / 2)]! : null;
  };
  type Figures = ReturnType<typeof figures>;
  const of = (label: string, key: keyof Figures): (number | null)[] => rows.map(r => (r[label] as Figures)[key] as number | null);
  const f = (v: number | null, digits = 1): string => v === null ? "n/a" : v.toFixed(digits);
  const pct = (v: number | null): string => v === null ? "n/a" : `${(v * 100).toFixed(1)}%`;
  const summary = [baseline, candidate].map(label => ({ label, passed: rows.filter(r => (r[label] as Figures).verdict === "pass").length,
    erleDb: median(of(label, "erleDb")), changeDb: median(of(label, "changeDb")), voiceLossDb: median(of(label, "voiceLossDb")),
    voiceLossP95Db: median(of(label, "voiceLossP95Db")), dropoutFraction: median(of(label, "dropoutFraction")) }));
  const lines = [
    `# ${candidate} against ${baseline} on ${root}`, "",
    `Gates frozen 2026-10-29: echo removed (ERLE) at least 25 dB; without echo, change at most −40 dB; in double-talk, voice loss median at most 1 dB, 95th percentile at most 3 dB, frames down more than 10 dB at most 1%.`, "",
    "| | Conditions passed | Echo removed, median (dB) | Change without echo, median (dB) | Voice loss, median (dB) | Voice loss, 95th pct, median (dB) | Voice frames down >10 dB, median |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...summary.map(s => `| ${s.label} | ${s.passed}/${rows.length} | ${f(s.erleDb)} | ${f(s.changeDb)} | ${f(s.voiceLossDb, 2)} | ${f(s.voiceLossP95Db, 2)} | ${pct(s.dropoutFraction)} |`), "",
    "| Condition | Echo removed (dB) | Change without echo (dB) | Voice loss median / 95th (dB) | Voice frames down >10 dB | Verdict |", "| --- | --- | --- | --- | --- | --- |",
    ...rows.map(r => { const a = r[baseline] as Figures, b = r[candidate] as Figures;
      return `| ${r.condition} | ${f(a.erleDb)} → ${f(b.erleDb)} | ${f(a.changeDb)} → ${f(b.changeDb)} | ${f(a.voiceLossDb, 2)}/${f(a.voiceLossP95Db, 2)} → ${f(b.voiceLossDb, 2)}/${f(b.voiceLossP95Db, 2)} | ${pct(a.dropoutFraction)} → ${pct(b.dropoutFraction)} | ${a.verdict} → ${b.verdict} (${b.failed} failed) |`; }), "",
  ];
  fs.writeFileSync(path.join(root, `compare-${candidate}.md`), lines.join("\n"));
  fs.writeFileSync(path.join(root, `compare-${candidate}.json`), `${JSON.stringify({ baseline, candidate, summary, rows }, null, 2)}\n`);
  console.log(lines.slice(0, 8).join("\n"));
} else fail(`Unknown mode ${mode}.`);
