/**
 * `pnpm acceptance:recipe -- <recipe> [--dry-run] [--out <new dir>]`, `-- --list`
 *
 * Runs a verification recipe (docs/testing.md#select-once-validate-once): the leaf checks of
 * the composite commands a change needs, in order, each in its own process group, with one
 * build of identical inputs. Stops at the first phase that does not pass. Writes
 * `report.json`/`report.md` with each phase's monotonic duration, outcome and cleanup, the
 * durations a child reports inside it, and the revision, runtime-input and artifact identity
 * before and after (scripts/lib/runner/verification-timing.mts).
 *
 * Exit 0 when every phase passed on unchanged inputs; 1 for a failure, or for sources that
 * changed during the run; 2 when a desktop runner was blocked; 130/143 after SIGINT/SIGTERM,
 * which stop the running phase through its own cleanup first. A recipe that opens the development
 * bundle quits it normally when its last runner did not, and fails when it cannot confirm the exit.
 * Otherwise the recipe adds no desktop interaction: each runner keeps its handoff, lock and cleanup rules.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { escapeRegExp, pgrepPids, recordStuffPids } from "./lib/runner/processes.mts";
import { scrubbedEnv, runnerArgs } from "./lib/runner/runner-env.mts";
import {
  RECIPES, developmentAppPath, displayCommand, exitCode, findRecipe, identity, inputsChanged, quitOwnedApp, recipeOutcome, renderMarkdown,
  runPhases, summarize, type AppCleanup, type RecipeReport,
} from "./lib/runner/verification-timing.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const usage = `Usage: pnpm acceptance:recipe -- <${RECIPES.map(recipe => recipe.name).join("|")}> [--dry-run] [--out <new directory>] | --list`;
const args = runnerArgs();

let name: string | undefined;
let dryRun = false;
let list = false;
let outDir: string | undefined;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]!;
  if (arg === "--dry-run") dryRun = true;
  else if (arg === "--list") list = true;
  else if (arg === "--out" && args[i + 1] && !args[i + 1]!.startsWith("--") && !outDir) outDir = path.resolve(args[++i]!);
  else if (!arg.startsWith("--") && !name) name = arg;
  else { console.error(usage); process.exit(2); }
}

if (list) {
  for (const recipe of RECIPES) {
    console.log(`${recipe.name}: ${recipe.purpose}\n  replaces ${recipe.replaces}\n${recipe.phases.map(phase => `  - ${phase.name}: ${displayCommand(phase)}`).join("\n")}`);
  }
  process.exit(0);
}
const recipe = name ? findRecipe(name) : undefined;
if (!recipe) { console.error(name ? `Unknown recipe ${name}. ${usage}` : usage); process.exit(2); }
if (dryRun) {
  console.log(`${recipe.name} replaces ${recipe.replaces}:`);
  for (const phase of recipe.phases) console.log(`  ${phase.name}: ${displayCommand(phase)}`);
  process.exit(0);
}

const startedAt = new Date().toISOString();
const dir = outDir ?? path.join(root, "docs/verification/measurements", `${startedAt.replace(/[:.]/g, "-")}-recipe-${recipe.name}`);
if (outDir && fs.existsSync(outDir)) { console.error(`${outDir} already exists; choose a new directory.`); process.exit(2); }
fs.mkdirSync(dir, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-recipe-"));

const controller = new AbortController();
let interruptedBy: NodeJS.Signals | undefined;
// Stays installed until the report is written, so a second signal cannot skip a phase's cleanup.
const interrupt = (signal: NodeJS.Signals): void => {
  interruptedBy ??= signal;
  console.error(`${signal}: stopping ${recipe.name} after the running phase cleans up.`);
  controller.abort();
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

// An app already running is not this recipe's to quit; start:app then refuses to rebuild under it.
const appPath = developmentAppPath(root);
// Main executable and Chromium helpers alike: every process inside this bundle.
const bundlePids = (): number[] => pgrepPids(`^${escapeRegExp(appPath)}/Contents/`);
let ownsApp = Boolean(recipe.ownsApp);
if (ownsApp) {
  try { ownsApp = bundlePids().length === 0; } catch { ownsApp = false; }
}

const wallStart = performance.now();
const before = identity(root);
const phases = await runPhases(recipe.phases, { cwd: root, env: scrubbedEnv(), scratchDir: scratch, signal: controller.signal });
// The runner that owns the app's shutdown may have failed or been skipped after start:app opened it.
let appCleanup: AppCleanup | undefined;
if (ownsApp) {
  appCleanup = await quitOwnedApp({
    pids: bundlePids, main: () => recordStuffPids(appPath),
    quit: async () => {
      const result = spawnSync("osascript", ["-e", `tell application ${JSON.stringify(appPath)} to quit`], { encoding: "utf8", timeout: 15_000 });
      if (result.error || result.status !== 0) throw new Error(result.error?.message ?? (result.stderr.trim() || `osascript exit ${result.status}`));
    },
  });
  console.log(`App cleanup: ${appCleanup.outcome} — ${appCleanup.detail}`);
}
const after = identity(root);
const wallMs = performance.now() - wallStart;
fs.rmSync(scratch, { recursive: true, force: true });

const electron = path.join(root, "node_modules/electron/package.json");
const report: RecipeReport = {
  recipe: recipe.name, purpose: recipe.purpose, replaces: recipe.replaces, startedAt,
  // Incomplete cleanup, of a phase or of the app the recipe opened, fails the run, interrupted or not.
  outcome: appCleanup?.outcome === "failed" || phases.some(phase => phase.outcome === "fail") ? "fail"
    : interruptedBy ? "interrupted" : recipeOutcome(phases, inputsChanged(before, after)),
  ...(interruptedBy ? { interruptedBy } : {}),
  ...(appCleanup ? { appCleanup } : {}),
  summary: summarize(phases, wallMs), phases, before, after,
  versions: {
    node: process.versions.node,
    pnpm: /pnpm\/(\S+)/.exec(process.env.npm_config_user_agent ?? "")?.[1] ?? "unknown",
    electron: fs.existsSync(electron) ? String((JSON.parse(fs.readFileSync(electron, "utf8")) as { version: unknown }).version) : "missing",
    os: `${os.type()} ${os.release()} ${process.arch}`,
  },
};
fs.writeFileSync(path.join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(path.join(dir, "report.md"), renderMarkdown(report));
process.removeListener("SIGINT", interrupt);
process.removeListener("SIGTERM", interrupt);

console.log(`\n${recipe.name}: ${report.outcome}. Wall ${(wallMs / 1000).toFixed(2)} s; ${phases.map(phase => `${phase.name} ${phase.durationMs === undefined ? phase.outcome : `${(phase.durationMs / 1000).toFixed(2)} s`}`).join(", ")}.`);
if (report.outcome === "invalid") console.error("Sources, tests or configuration changed during the run; rerun it on one revision.");
console.log(`Report: ${path.join(dir, "report.md")}`);
process.exit(exitCode(report.outcome, interruptedBy));
