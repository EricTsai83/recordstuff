#!/usr/bin/env node
/**
 * `pnpm bench:export -- --dir <absolute folder> [--sizes 64m,2g,2h60] [--repeat 3] [--cancels 20] [--label name] [--keep]`
 *
 * Plan 085's export gates, without recording: synthetic sources in the engine's own file layout (64 MiB and 2 GiB of
 * 1080p30 at about 12 Mbps, and two hours at 60 fps, the most samples; made by the engine's encoders through
 * `cargo test … bench_sources`, so Rust and VideoToolbox are needed), then, in the production export worker forked by
 * Electron as the app forks it, for each size: a plain streaming copy by that worker (8 MiB reads and writes and a
 * sync; no clone or link, unlike `pnpm bench:publication`), a remux with cuts on key frames, and a remux with joins
 * inside groups of pictures; the worker's peak memory; and the time a cancelled export of the largest source takes to
 * end. The gates: the key-frame remux at least half the copy's rate, the worker's peak at most 64 MiB, cancel within
 * 1 s at p95. Evidence goes to `docs/verification/measurements/<timestamp>-export-<label>/`.
 *
 * Needs `pnpm build`'s out/ (the worker and the engine). Refuses to start unless the folder's volume has the sources,
 * one copy of the largest and 1 GiB to spare. Sources are made once per folder and kept with `--keep`; outputs are
 * always removed. Exit 1 when a gate failed or a step errored, 2 when blocked or given bad arguments.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { runnerArgs, scrubbedEnv } from "./lib/runner/runner-env.mts";
import { buildFixture } from "./lib/runner/build-fixture.mts";
import { MEASUREMENTS_DIR, REPO_ROOT } from "./lib/verification/verify-recording.mts";
import { distribution, formatDistribution } from "./lib/verification/finalization-timing.mts";
import { freeBytes, volumeOf } from "./lib/verification/volume.mts";
import { mp4Duration } from "../src/main/library/mp4-duration.ts";

const SIZES = ["64m", "2g", "2h60"] as const;
type Size = (typeof SIZES)[number];
/** About how many bytes each source takes, for the space check. */
const EXPECTED_BYTES: Record<Size, number> = { "64m": 64 * 1024 ** 2, "2g": 2 * 1024 ** 3, "2h60": 1.2 * 1024 ** 3 };
const MEMORY_GATE_KB = 64 * 1024;
const CANCEL_GATE_MS = 1000;

interface Options { dir: string; sizes: Size[]; repeat: number; cancels: number; label: string; keep: boolean }
interface Line { kind: string; size?: string; round?: number; sourceBytes?: number; bytes?: number | null; ms?: number; restKb?: number; peakKb?: number; error?: string;
  reencodedFrames?: number; reencodedPackets?: number; outcome?: string; workingSetKb?: number | null; peakWorkingSetKb?: number | null; detail?: string }

function usage(message?: string): never {
  if (message) console.error(message);
  console.error("usage: pnpm bench:export -- --dir <absolute folder> [--sizes 64m,2g,2h60] [--repeat 3] [--cancels 20] [--label name] [--keep]");
  process.exit(2);
}

function parseOptions(argv: string[]): Options {
  const options: Options = { dir: "", sizes: [...SIZES], repeat: 3, cancels: 20, label: "", keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (): string => { const next = argv[++i]; if (next === undefined || next.startsWith("--")) usage(`${arg} needs a value`); return next; };
    if (arg === "--dir") options.dir = value();
    else if (arg === "--sizes") {
      const sizes = value().split(",");
      if (!sizes.every((size): size is Size => (SIZES as readonly string[]).includes(size))) usage("--sizes takes 64m, 2g and 2h60");
      options.sizes = sizes as Size[];
    } else if (arg === "--repeat") options.repeat = Number(value());
    else if (arg === "--cancels") options.cancels = Number(value());
    else if (arg === "--label") options.label = value();
    else if (arg === "--keep") options.keep = true;
    else usage(`unknown argument ${arg}`);
  }
  if (!path.isAbsolute(options.dir)) usage("--dir must be an absolute folder");
  if (!(Number.isInteger(options.repeat) && options.repeat >= 1 && options.repeat <= 10)) usage("--repeat must be 1–10");
  if (!(Number.isInteger(options.cancels) && options.cancels >= 0 && options.cancels <= 100)) usage("--cancels must be 0–100");
  if (!/^[\w.-]*$/.test(options.label)) usage("--label may use letters, digits, dot, dash and underscore");
  return options;
}

const mib = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
const median = (values: number[]): number => distribution(values)?.p50 ?? NaN;

/** Makes the sources not already in `folder`, through the engine's own encoders; each with its length. */
async function makeSources(folder: string, sizes: Size[]): Promise<Map<Size, { path: string; seconds: number }>> {
  const missing = sizes.filter((size) => !fs.existsSync(path.join(folder, `bench-${size}.mp4`)));
  if (missing.length) {
    console.log(`Making ${missing.join(", ")} with the engine's encoders…`);
    const made = spawnSync("cargo", ["test", "--release", "--manifest-path", path.join(REPO_ROOT, "native/capture/Cargo.toml"), "--lib", "bench_sources", "--", "--ignored", "--nocapture"], {
      cwd: REPO_ROOT, env: { ...scrubbedEnv(), EXPORT_BENCH_SOURCES: folder, EXPORT_BENCH_SIZES: missing.join(",") }, stdio: ["ignore", "inherit", "inherit"],
    });
    if (made.status !== 0) { console.error("FAILED: the sources could not be made"); process.exit(1); }
  }
  const made = new Map<Size, { path: string; seconds: number }>();
  for (const size of sizes) {
    const file = path.join(folder, `bench-${size}.mp4`);
    const seconds = await mp4Duration(file);
    if (!seconds) { console.error(`FAILED: ${file} has no length`); process.exit(1); }
    made.set(size, { path: file, seconds: Math.floor(seconds) });
  }
  return made;
}

async function main(): Promise<void> {
  const options = parseOptions(runnerArgs());
  const worker = path.join(REPO_ROOT, "out/main/export-process.js");
  const addon = path.join(REPO_ROOT, "out/native/recordstuff-capture.node");
  if (!fs.existsSync(worker) || !fs.existsSync(addon)) {
    console.error("BLOCKED: out/ has no export worker or engine; run `pnpm build` first");
    process.exit(2);
  }
  const sources = path.join(options.dir, "sources");
  fs.mkdirSync(sources, { recursive: true });
  const present = options.sizes.filter((size) => fs.existsSync(path.join(sources, `bench-${size}.mp4`)));
  const needed = options.sizes.filter((size) => !present.includes(size)).reduce((sum, size) => sum + EXPECTED_BYTES[size], 0)
    + Math.max(...options.sizes.map((size) => EXPECTED_BYTES[size])) + 1024 ** 3;
  if (freeBytes(options.dir) < needed) {
    console.error(`BLOCKED: ${options.dir} has ${mib(freeBytes(options.dir))} free; this run needs ${mib(needed)}, and this benchmark never fills a disk`);
    process.exit(2);
  }
  const made = await makeSources(sources, options.sizes);
  const volume = volumeOf(options.dir);
  const report = path.join(MEASUREMENTS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-export${options.label ? `-${options.label}` : ""}`);
  fs.mkdirSync(report, { recursive: true });
  const fixture = await buildFixture("export-bench", report);
  const configPath = path.join(report, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ worker, addon, outDir: options.dir, repeat: options.repeat, cancels: options.cancels,
    sources: [...made].map(([size, source]) => ({ size, ...source })) }));
  console.log(`Export benchmark: ${options.sizes.join(", ")} × ${options.repeat}, ${options.cancels} cancels, in ${options.dir} (${volume.type}); evidence ${report}`);

  const electron = createRequire(import.meta.url)("electron") as string;
  const child = spawn(electron, [fixture, configPath], { cwd: REPO_ROOT, env: scrubbedEnv(), stdio: ["ignore", "pipe", "inherit"] });
  const lines: Line[] = [];
  let buffered = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    let at;
    while ((at = buffered.indexOf("\n")) >= 0) {
      const text = buffered.slice(0, at).trim();
      buffered = buffered.slice(at + 1);
      if (!text.startsWith("{")) continue;
      const line = JSON.parse(text) as Line;
      lines.push(line);
      if (line.kind === "copy" || line.kind === "remux" || line.kind === "joins") {
        console.log(`${line.size} ${line.kind} round ${line.round}: ${line.error ? `FAILED ${line.error}` : `${Math.round(line.ms!)} ms, ${((line.sourceBytes! / 1024 ** 2) / (line.ms! / 1000)).toFixed(0)} MiB/s of source, worker ${(line.restKb! / 1024).toFixed(1)} MiB at rest, peak ${(line.peakKb! / 1024).toFixed(1)} MiB (+${((line.peakKb! - line.restKb!) / 1024).toFixed(1)})`}`);
      } else if (line.kind === "cancel") console.log(`cancel round ${line.round}: ${Math.round(line.ms!)} ms (${line.outcome})`);
      else if (line.kind === "fatal") console.error(`FAILED: ${line.detail}`);
    }
  });
  const code = await new Promise<number>((resolve) => child.on("exit", (exit) => resolve(exit ?? 1)));
  fs.rmSync(path.join(options.dir, "bench-output.mp4"), { force: true });
  if (!options.keep) fs.rmSync(sources, { recursive: true, force: true });

  let failed = code !== 0 || !lines.some((line) => line.kind === "done") || lines.some((line) => line.error);
  const rows: string[] = [];
  const memoryNotes: string[] = [];
  for (const size of options.sizes) {
    const of = (kind: string): Line[] => lines.filter((line) => line.kind === kind && line.size === size && !line.error);
    const copy = median(of("copy").map((line) => line.ms!)), remux = median(of("remux").map((line) => line.ms!)), joins = median(of("joins").map((line) => line.ms!));
    const bytes = of("copy")[0]?.sourceBytes ?? 0;
    const ratio = copy / remux;
    const exports = [...of("remux"), ...of("joins")];
    const peak = Math.max(...exports.map((line) => line.peakKb!));
    const own = Math.max(...exports.map((line) => line.peakKb! - line.restKb!));
    const rest = Math.max(...exports.map((line) => line.restKb!));
    const rate = (ms: number): string => `${((bytes / 1024 ** 2) / (ms / 1000)).toFixed(0)} MiB/s`;
    const speedPass = ratio >= 0.5, memoryPass = peak <= MEMORY_GATE_KB, ownPass = own <= MEMORY_GATE_KB;
    if (!speedPass) failed = true;
    rows.push(`| ${size} | ${mib(bytes)} | ${Math.round(copy)} ms (${rate(copy)}) | ${Math.round(remux)} ms (${rate(remux)}) | ${ratio.toFixed(2)} ${speedPass ? "PASS" : "FAIL"} | ${Math.round(joins)} ms (+${Math.round(joins - remux)} ms for ${of("joins")[0]?.reencodedFrames ?? "?"} pictures, ${of("joins")[0]?.reencodedPackets ?? "?"} sound packets) | ${(peak / 1024).toFixed(1)} MiB ${memoryPass ? "PASS" : "FAIL"} (at rest ${(rest / 1024).toFixed(1)}) | +${(own / 1024).toFixed(1)} MiB ${ownPass ? "PASS" : "FAIL"} |`);
    if (!memoryPass) memoryNotes.push(size);
  }
  const cancels = distribution(lines.filter((line) => line.kind === "cancel").map((line) => Math.round(line.ms!)));
  const cancelPass = !cancels || cancels.p95 <= CANCEL_GATE_MS;
  if (!cancelPass || lines.some((line) => line.kind === "cancel" && line.outcome !== "cancelled")) failed = true;
  const summary = [
    `# Export benchmark — ${options.label || "unlabelled"}`,
    "",
    `- Run: ${new Date().toISOString()}; ${options.repeat} round(s) a size (medians below); production export worker (out/main/export-process.js) under Electron`,
    `- Folder: \`${options.dir}\` on ${volume.type} (${volume.mount}); sources just written, so copy and remux both read from the page cache`,
    "- Each request in a fresh worker, settled a second after loading the engine; memory is its working set (Electron's process metrics, every 20 ms)",
    "",
    "| Source | Size | Streaming copy | Remux, cuts on key frames | Remux ÷ copy rate (gate ≥ 0.5) | Remux with 2 joins inside groups | Worker peak (gate ≤ 64 MiB) | Export's own, over the worker at rest |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    ...(memoryNotes.length ? [`The worker's absolute peak is over 64 MiB for ${memoryNotes.join(", ")}: an Electron utilityProcess at rest with the engine loaded already holds about that much; the export's own memory is the last column. Which the gate means is the maintainer's decision; the speed and cancel gates decide this run's result.`, ""] : []),
    `Cancel (${cancels?.n ?? 0} runs of the largest source's remux, cancelled at a random moment): ${cancels ? formatDistribution(cancels) : "—"}; gate p95 ≤ ${CANCEL_GATE_MS} ms: ${cancelPass ? "PASS" : "FAIL"}`,
    "",
    "## Every result",
    "",
    "```",
    ...lines.map((line) => JSON.stringify(line)),
    "```",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(report, "summary.md"), summary);
  console.log(`\n${summary.split("## Every result")[0]}`);
  console.log(failed ? "Result: FAIL" : "Result: PASS");
  process.exit(failed ? 1 : 0);
}

await main();
