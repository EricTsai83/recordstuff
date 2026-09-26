#!/usr/bin/env node
/**
 * `pnpm bench:publication -- --dir <absolute folder> [--sizes 64m,2g] [--repeat 3]
 *   [--label name] [--keep]`
 *
 * How a save's publication cost grows with file size on one volume, without
 * recording: each size is written through the production FileWriter (bundled
 * from `scripts/fixtures/publication-bench.ts`) under Electron's own Node, then
 * published by `finish`, which links where the volume allows and copies
 * otherwise. Needs no screen permission, desktop, material or `out/`. Files
 * are deleted after each size unless `--keep`. Evidence goes to
 * `docs/verification/measurements/<timestamp>-publication-<label>/`.
 *
 * It refuses to start unless the volume has twice the largest size plus
 * 1 GiB free, since a copy briefly holds two copies; it never fills a disk.
 * Exit 1 when a publication failed, 2 on bad arguments or too little space,
 * 130/143 after SIGINT/SIGTERM (the benchmark's own files are removed).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { buildFixture } from "./lib/build-fixture.mts";
import { distribution, formatDistribution, parseByteSize } from "./lib/finalization-timing.mts";
import { freeBytes, volumeOf } from "./lib/volume.mts";
import { REPO_ROOT } from "./lib/verify-recording.mts";

const MEASUREMENTS_DIR = path.join(REPO_ROOT, "docs/verification/measurements");
const HEADROOM_BYTES = 1024 ** 3;
const CHUNK_BYTES = 4 * 1024 ** 2;

interface Options { dir: string; sizes: number[]; repeat: number; label: string; keep: boolean }
interface Result {
  round: number;
  bytes: number;
  writeMs?: number;
  finishMs?: number;
  flushMs?: number;
  closeMs?: number;
  publishMs?: number;
  cleanupMs?: number;
  method?: "link" | "copy";
  linkError?: string;
  error?: string;
}

function usage(message?: string): never {
  if (message) console.error(message);
  console.error("usage: pnpm bench:publication -- --dir <absolute folder> [--sizes 64m,2g] [--repeat 3] [--label name] [--keep]");
  process.exit(2);
}

function parseOptions(argv: string[]): Options {
  const options: Options = { dir: "", sizes: [64 * 1024 ** 2, 2 * 1024 ** 3], repeat: 3, label: "", keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (): string => { const next = argv[++i]; if (next === undefined) usage(`${arg} needs a value`); return next; };
    if (arg === "--dir") options.dir = value();
    else if (arg === "--sizes") {
      const sizes = value().split(",").map(parseByteSize);
      if (sizes.length === 0 || sizes.some((size) => size === undefined)) usage("--sizes takes sizes such as 64m,2g");
      options.sizes = sizes as number[];
    } else if (arg === "--repeat") options.repeat = Number(value());
    else if (arg === "--label") options.label = value();
    else if (arg === "--keep") options.keep = true;
    else usage(`unknown argument ${arg}`);
  }
  if (!path.isAbsolute(options.dir)) usage("--dir must be an absolute folder");
  if (!(Number.isInteger(options.repeat) && options.repeat >= 1 && options.repeat <= 20)) usage("--repeat must be 1–20");
  if (!/^[\w.-]*$/.test(options.label)) usage("--label may use letters, digits, dot, dash and underscore");
  return options;
}

const mib = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(bytes < 1024 ** 2 ? 2 : 0)} MiB`;
const rounded = (values: Array<number | undefined>): number[] => values.flatMap((v) => v === undefined ? [] : [Math.round(v)]);

function describe(result: Result): string {
  if (result.error) return `${mib(result.bytes)} round ${result.round}: FAILED ${result.error}`;
  const mbps = result.writeMs ? (result.bytes / 1024 ** 2) / (result.writeMs / 1000) : undefined;
  return `${mib(result.bytes)} round ${result.round}: publish ${Math.round(result.publishMs ?? NaN)} ms by ${result.method ?? "?"}` +
    `${result.linkError ? ` (link ${result.linkError})` : ""}; flush ${Math.round(result.flushMs ?? NaN)}, close ${Math.round(result.closeMs ?? NaN)}, ` +
    `cleanup ${Math.round(result.cleanupMs ?? NaN)}, finish ${Math.round(result.finishMs ?? NaN)} ms; written at ${mbps?.toFixed(0) ?? "?"} MiB/s`;
}

function summary(options: Options, volume: { mount: string; type: string }, results: Result[]): string {
  const rows = options.sizes.map((bytes) => {
    const ok = results.filter((r) => r.bytes === bytes && !r.error);
    const methods = [...new Set(ok.map((r) => `${r.method}${r.linkError ? ` (link ${r.linkError})` : ""}`))].join(", ") || "—";
    const failed = results.filter((r) => r.bytes === bytes && r.error).length;
    return `| ${mib(bytes)} | ${methods} | ${formatDistribution(distribution(rounded(ok.map((r) => r.publishMs))))} | ${formatDistribution(distribution(rounded(ok.map((r) => r.finishMs))))} | ${failed} |`;
  });
  return [
    `# Publication benchmark — ${options.label || "unlabelled"}`,
    "",
    `- Run: ${new Date().toISOString()}; sizes ${options.sizes.map(mib).join(", ")}; ${options.repeat} round(s); ${mib(CHUNK_BYTES)} chunks through the production FileWriter under Electron's Node`,
    `- Folder: \`${options.dir}\` on ${volume.type} (${volume.mount})`,
    "",
    "| Size | Method | Publish | Finish (flush + close + publish + cleanup) | Failed |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## Files",
    "",
    ...results.map((result, i) => `${i + 1}. ${describe(result)}`),
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--")));
  fs.mkdirSync(options.dir, { recursive: true });
  const needed = 2 * Math.max(...options.sizes) + HEADROOM_BYTES;
  const free = freeBytes(options.dir);
  if (free < needed) {
    console.error(`BLOCKED: ${options.dir} has ${mib(free)} free; the largest size needs ${mib(needed)} (two copies plus 1 GiB), and this benchmark never fills a disk`);
    process.exit(2);
  }
  const volume = volumeOf(options.dir);
  const report = path.join(MEASUREMENTS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-publication${options.label ? `-${options.label}` : ""}`);
  fs.mkdirSync(report, { recursive: true });
  const fixture = await buildFixture("publication-bench", report);
  const configPath = path.join(report, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ dir: options.dir, sizes: options.sizes, repeat: options.repeat, keep: options.keep, chunkBytes: CHUNK_BYTES }));
  console.log(`Publication benchmark: ${options.sizes.map(mib).join(", ")} × ${options.repeat} into ${options.dir} (${volume.type}); evidence ${report}`);

  const electron = createRequire(import.meta.url)("electron") as string;
  const child = spawn(electron, [fixture, configPath], { cwd: REPO_ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "inherit"] });
  const results: Result[] = [];
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text: string) => {
    buffered += text;
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      if (!line) continue;
      const result = JSON.parse(line) as Result;
      results.push(result);
      console.log(`  ${describe(result)}`);
    }
  });
  const removeOwnFiles = (): void => {
    if (options.keep || child.pid === undefined) return;
    for (const name of fs.readdirSync(options.dir)) {
      if (name.startsWith(`bench-${child.pid}-`)) fs.rmSync(path.join(options.dir, name), { force: true });
    }
  };
  let interrupted: number | undefined;
  const interrupt = (code: number): void => {
    if (interrupted !== undefined) return;
    interrupted = code;
    console.error("interrupted: stopping the benchmark and removing its files; no report is written");
    child.kill("SIGTERM");
  };
  process.on("SIGINT", () => interrupt(130));
  process.on("SIGTERM", () => interrupt(143));
  const code = await new Promise<number | null>((resolve) => child.on("exit", (exit) => resolve(exit)));
  if (interrupted !== undefined) {
    removeOwnFiles();
    process.exit(interrupted);
  }
  const text = summary(options, volume, results);
  fs.writeFileSync(path.join(report, "summary.md"), text);
  fs.writeFileSync(path.join(report, "summary.json"), JSON.stringify({ options, volume, results }, null, 2));
  console.log(`\n${text}\nSummary: ${path.join(report, "summary.md")}`);
  const expected = options.sizes.length * options.repeat;
  process.exit(code === 0 && results.length === expected && results.every((r) => !r.error) ? 0 : 1);
}

void main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.stack ?? cause.message : String(cause));
  process.exit(1);
});
