/**
 * `pnpm test:scope -- <scope|test file>… [--dry-run] [--no-typecheck]`, `-- --list`
 *
 * The focused local check (plan 070, docs/testing.md#select-tests-from-behavior): the unit files and background UI cases
 * of the named scopes (scripts/lib/runner/test-scopes.mts) and of any test files named directly, deduplicated, in one
 * pass each. Phases, stopping at the first that does not pass: `pnpm typecheck` (all three projects, since a file's
 * imports reach past it; `--no-typecheck` leaves it out and says so), Vitest on the selected files, a production
 * build only when UI cases are selected and `out/` is not the current sources' build, then the background suite on
 * the selected files and tags. Prints each phase's time and the wall time.
 *
 * `--dry-run` lists the exact files and cases, the checks and whether a build would run, and runs nothing: Vitest and
 * Playwright only list, no build, no Electron. Unknown scopes, missing files and selections that match nothing exit 2
 * (a usage error) rather than falling back to anything broader. A focused pass is not a full regression: the broad
 * composites (`pnpm check`, `pnpm acceptance:regression`, the recipes) and CI are unchanged.
 *
 * Exit 0 when every phase passed, 1 when one failed, 2 for a usage error or a blocked suite (its global setup's exit
 * 2), 130/143 after an interrupt. Nothing here ships with the app.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runnerArgs, scrubbedEnv } from "./lib/runner/runner-env.mts";
import { TEST_SCOPES, resolveSelection, type Selection } from "./lib/runner/test-scopes.mts";
import { displayCommand, runPhases, type PhaseSpec } from "./lib/runner/verification-timing.mts";
import { staleOutReason } from "./lib/runner/runtime-inputs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const usage = "Usage: pnpm test:scope -- <scope|test file>… [--dry-run] [--no-typecheck] | --list";
const args = runnerArgs();
const names: string[] = [];
let dryRun = false, typecheck = true, list = false;
for (const arg of args) {
  if (arg === "--dry-run") dryRun = true;
  else if (arg === "--no-typecheck") typecheck = false;
  else if (arg === "--list") list = true;
  else if (arg.startsWith("--")) usageError(`Unknown option ${arg}.`);
  else names.push(arg);
}
function usageError(message: string): never {
  console.error(`${message}\n${usage}`);
  process.exit(2);
}

if (list) {
  for (const scope of TEST_SCOPES) {
    const ui = scope.ui.map(({ file, tags }) => tags ? `${file} ${tags.join(" ")}` : file);
    console.log(`${scope.name}: ${scope.covers}\n  unit: ${scope.unit.join(", ")}\n  ui: ${ui.length ? ui.join(", ") : "none"}`);
  }
  process.exit(0);
}

let selection: Selection;
try {
  selection = resolveSelection(names, TEST_SCOPES, file => fs.existsSync(path.join(root, file)));
} catch (error) {
  usageError(error instanceof Error ? error.message : String(error));
}

const PLAYWRIGHT = ["exec", "playwright", "test", "--project=background"];
const uiArgs = selection.ui.length ? [...selection.ui.map(({ file }) => `tests/ui/${file}`), "--grep", selection.grep!] : [];
const quiet = (executable: string, commandArgs: string[]): { code: number | null; out: string } => {
  const result = spawnSync(executable, commandArgs, { cwd: root, env: scrubbedEnv(), encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
};

// What would run, listed by the runners themselves without executing a test: an empty or failing list is an error here.
const unitFiles = selection.unit.length ? quiet("pnpm", ["exec", "vitest", "list", "--filesOnly", ...selection.unit]) : { code: 0, out: "" };
const files = unitFiles.out.split("\n").map(line => line.trim()).filter(line => /\.test\.m?ts$/.test(line));
if (selection.unit.length && (unitFiles.code !== 0 || !files.length)) usageError(`The unit filters ${selection.unit.join(", ")} match no test file.\n${unitFiles.out.trim()}`);
const uiList = selection.ui.length ? quiet("pnpm", [...PLAYWRIGHT, "--list", ...uiArgs]) : { code: 0, out: "" };
const cases = uiList.out.split("\n").filter(line => line.includes("[background] ›")).map(line => line.trim());
if (selection.ui.length && (uiList.code !== 0 || !cases.length)) usageError(`The UI selection matches no background case.\n${uiList.out.trim()}`);
const stale = selection.ui.length ? staleOutReason(root) : undefined;

const phases: PhaseSpec[] = [
  ...(typecheck ? [{ name: "typecheck", executable: "pnpm", args: ["typecheck"] }] : []),
  ...(files.length ? [{ name: `unit (${files.length} files)`, executable: "pnpm", args: ["exec", "vitest", "run", ...selection.unit] }] : []),
  ...(stale ? [{ name: "build", executable: "pnpm", args: ["build"] }] : []),
  // Its global setup exits 2 when `out/` or the clips are missing: blocked, not failed.
  ...(cases.length ? [{ name: `background UI (${cases.length} cases)`, executable: "pnpm", args: [...PLAYWRIGHT, ...uiArgs], blockedExit: true }] : []),
];

console.log(`Scopes: ${selection.scopes.length ? selection.scopes.join(", ") : "none"}${names.length > selection.scopes.length ? `; files: ${names.filter(name => !selection.scopes.includes(name)).join(", ")}` : ""}`);
console.log(`Unit files (${files.length}):${files.length ? `\n${files.map(file => `  ${file}`).join("\n")}` : " none"}`);
console.log(`Background UI cases (${cases.length}):${cases.length ? `\n${cases.map(line => `  ${line}`).join("\n")}` : " none"}`);
console.log(`Build: ${!selection.ui.length ? "not needed (no UI case)" : stale ? `yes: ${stale}` : "no: out/ is the current sources' build"}`);
if (!typecheck) console.log("Typecheck: left out (--no-typecheck); say so in the result.");
console.log(`Checks:\n${phases.map(phase => `  ${phase.name}: ${displayCommand(phase)}`).join("\n")}`);
if (dryRun) process.exit(0);

const controller = new AbortController();
let interruptedBy: NodeJS.Signals | undefined;
const interrupt = (signal: NodeJS.Signals): void => { interruptedBy ??= signal; controller.abort(); };
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-scope-"));
const started = performance.now();
const records = await runPhases(phases, { cwd: root, env: scrubbedEnv(), scratchDir: scratch, signal: controller.signal, graceMs: 30_000 });
const wallMs = performance.now() - started;
fs.rmSync(scratch, { recursive: true, force: true });

const seconds = (ms: number | undefined): string => ms === undefined ? "-" : `${(ms / 1000).toFixed(1)} s`;
console.log(`\n${records.map(record => `${record.outcome.padEnd(11)} ${seconds(record.durationMs).padStart(8)}  ${record.name}${record.detail ? ` (${record.detail})` : ""}`).join("\n")}`);
const failed = records.find(record => record.outcome !== "pass");
console.log(`${failed ? `Stopped at ${failed.name}: ${failed.outcome}` : "Focused checks passed"} in ${seconds(wallMs)}. This is the named scopes' evidence, not a full regression.`);
process.exit(interruptedBy ? (interruptedBy === "SIGINT" ? 130 : 143)
  : !failed ? 0 : failed.outcome === "blocked" ? 2 : 1);
