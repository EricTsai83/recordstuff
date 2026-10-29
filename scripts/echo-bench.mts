#!/usr/bin/env node
/**
 * `pnpm echo:bench -- material <new-directory> [--seed <n>] [--voices say|synthetic]`
 * `pnpm echo:bench -- analyze <condition-directory> <output.wav>`
 * `pnpm echo:bench -- baseline <material-directory>`
 *
 * Plan 096's echo-removal bench (docs/system-design/tooling.md#echo-removal-bench). `material` writes stage A's
 * simulated takes, one directory per condition: `mic.wav` (mono), `reference.wav` (stereo, what the system track would
 * hold), `ideal.wav` (the microphone without the echo), `echo.wav` and `take.json` (condition, seed, script, events,
 * sources and environment). `analyze` measures a canceller's output for one condition and prints the JSON report; exit
 * 0 when every applicable proposed gate passed, 1 when one failed, 2 for invalid input or a usage error. `baseline`
 * analyzes the raw microphone (no canceller) and the ideal output (a perfect one) for every condition and writes
 * `baseline.json`: the analyzer's floor and ceiling on that material. Nothing here ships with the app.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runnerArgs } from "./lib/runner/runner-env.mts";
import { RATE, readWav, writeWav } from "./lib/audio/echo-dsp.mts";
import { FAR_SENTENCES, FAR_VOICES, NEAR_SENTENCES, NEAR_VOICES, SCRIPT_SECONDS, buildTake, music, sayVoice, stageAConditions, syntheticVoice, tones, type Condition, type Segment, type VolumeEvent } from "./lib/audio/echo-material.mts";
import { analyzeEcho, type EchoReport } from "./lib/audio/echo-analyze.mts";

const usage = "usage: pnpm echo:bench -- material <new-directory> [--seed <n>] [--voices say|synthetic] | analyze <condition-directory> <output.wav> | baseline <material-directory>";
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
} else fail(`Unknown mode ${mode}.`);
