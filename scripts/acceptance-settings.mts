/**
 * `pnpm acceptance:settings [-- --out <dir>]`
 *
 * Acceptance of the settings panel against the *built* artifacts: it runs
 * Electron on the compiled `scripts/fixtures/settings-panel.ts`, which loads
 * `out/preload/settings.js` and `out/renderer/settings.html` in a real
 * window, drives it, and reports each case. This is the only check that
 * exercises the shipped CSP, the sandboxed preload boundary and a real IPC
 * round trip; `settings-model` and `SettingsWindow` are covered by unit
 * tests, so the fixture supplies its own view and handlers.
 *
 * It does not click the tray, open the window through Settings, or claim
 * anything about macOS window focus — a windowless app's tray is not
 * automatable (see .agents/skills/native-acceptance).
 *
 * Exit 0 when every case passed, 1 when one failed, and 2 (blocked) when the
 * desktop was not available: a locked session, or a window another app kept
 * inactive for a case that needs an active window (plan 057), which is
 * reported as not run. A report and screenshots are written to
 * docs/verification/measurements/<timestamp>-settings-acceptance/.
 * Requires `pnpm build` output. Nothing here ships with the app.
 */
import { scrubbedEnv } from "./lib/runner-env.mts";
import { buildFixture } from "./lib/build-fixture.mts";
import { runIsolatedProcess } from "./lib/isolated-process.mts";
import { DESKTOP_BLOCKED_EXIT, DesktopBlockedError, beginDesktopRound } from "./lib/desktop-session.mts";
import { failureBlocked, settingsOutcome, type FixtureFailure, type SettingsCase } from "./lib/settings-activation.mts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = path.join(REPO_ROOT, "node_modules/.bin/electron");
const TIMEOUT_MS = 90_000;

const argv = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--"));
let outDir: string | undefined;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--out" && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) outDir = argv[++i];
  else fail(argv[i] === "--out" ? "--out needs a directory" : `Unknown argument ${argv[i]}`);
}

/** Exit 2 means blocked (a missing prerequisite or a locked desktop); 1 means the round ran and failed. */
function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

for (const required of ["out/preload/settings.js", "out/renderer/settings.html"]) {
  if (!fs.existsSync(path.join(REPO_ROOT, required))) fail(`${required} is missing; run \`pnpm build\` first.`);
}
if (!fs.existsSync(ELECTRON)) fail("node_modules/.bin/electron is missing; run `pnpm install` first.");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = outDir ? path.resolve(outDir) : path.join(REPO_ROOT, "docs/verification/measurements", `${stamp}-settings-acceptance`);
// Never overwrite another run's evidence.
fs.mkdirSync(dir, { recursive: !outDir });
const fixture = await buildFixture("settings-panel", dir);

/** Electron needs a real app launch: no ELECTRON_RUN_AS_NODE, no inherited signing env. */
const env = scrubbedEnv();

// Real input, focus and screenshots need an awake, unlocked display.
const desktop = await beginDesktopRound().catch((cause: unknown) => {
  if (cause instanceof DesktopBlockedError) fail(`BLOCKED: ${cause.message}`);
  throw cause;
});
const controller = new AbortController();
const interrupt = (): void => controller.abort();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const log = fs.openSync(path.join(dir, "electron.log"), "a");
let execution;
try {
  execution = await runIsolatedProcess({
    executable: ELECTRON, args: [fixture, dir, REPO_ROOT], cwd: REPO_ROOT,
    env, logFd: log, timeoutMs: TIMEOUT_MS, signal: controller.signal,
  });
} finally {
  desktop.end();
  fs.closeSync(log);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
fs.writeFileSync(path.join(dir, "cleanup.json"), JSON.stringify(execution, null, 2));
const processClean = !execution.error && !execution.stopped && execution.groupGone;

const resultsPath = path.join(dir, "results.json");
if (!fs.existsSync(resultsPath)) {
  const detail = fs.existsSync(path.join(dir, "error.txt")) ? fs.readFileSync(path.join(dir, "error.txt"), "utf8") : "";
  fail(`${desktop.lockedAt ? `${desktop.summary}\n` : ""}The fixture produced no results (exit ${execution.code ?? "by signal"}). ${detail}\nEvidence: ${dir}`,
    desktop.lockedAt ? DESKTOP_BLOCKED_EXIT : 1);
}
const cases = JSON.parse(fs.readFileSync(resultsPath, "utf8")) as SettingsCase[];
const failurePath = path.join(dir, "failure.json");
const failure = fs.existsSync(failurePath) ? JSON.parse(fs.readFileSync(failurePath, "utf8")) as FixtureFailure : undefined;
const status = (result: SettingsCase): string => result.notRun ? "NOT RUN" : result.ok ? "PASS" : "FAIL";
for (const result of cases) console.log(`${status(result)}: ${result.name} — ${result.notRun ? `${result.notRun}. ` : ""}${result.detail}`);
const stopped = failure && `The fixture stopped after ${cases.length} cases${failure.screenshot ? ` while capturing ${failure.screenshot}` : ""}: ${failure.error}`
  + (failure.window ? ` (window: focused ${failure.window.focused}, visible ${failure.window.visible}, data-window ${failure.window.page || "unset"}; frontmost app: ${failure.frontmost ?? "unknown"}; `
    + `${failureBlocked(failure) ? "blocked" : "failed"}).` : ".");
if (stopped) console.error(stopped);

const verdict = settingsOutcome({ cases, failure, exit: execution.code, processClean, locked: Boolean(desktop.lockedAt) });
const passed = cases.filter((result) => result.ok).length;
const notRun = cases.filter((result) => result.notRun).length;
const report = [
  `# Settings panel acceptance — ${stamp}`,
  "",
  `Result: **${verdict.outcome}**${verdict.reasons.length ? ` — ${verdict.reasons.join("; ")}` : ""}.`,
  `Fixture exit code ${execution.code ?? "none (signal)"}; ${passed}/${cases.length} cases passed, ${notRun} not run.`,
  ...(stopped ? [stopped] : []),
  `Cleanup: process group gone=${execution.groupGone}; stopped=${execution.stopped ?? "no"}; error=${execution.error ?? "none"}. See cleanup.json.`,
  desktop.summary,
  "",
  "Built artifacts under test: `out/preload/settings.js`, `out/renderer/settings.html`.",
  "The fixture supplies its own view and IPC handlers, so this run judges the page,",
  "the preload boundary and the IPC round trip — not `settings-model` or `SettingsWindow`.",
  "No tray click, no Settings item and no macOS window focus behaviour was exercised.",
  "",
  "A case marked NOT RUN needs an active window and its window was not active around it; its detail is what was read anyway.",
  "",
  ...cases.map((result) => `- ${status(result)} — ${result.name}\n  - ${result.notRun ? `${result.notRun}. ` : ""}${result.detail}`),
  "",
  "Screenshot: `panel.png`. Raw cases: `results.json`. Electron output: `electron.log`."
    + (failure ? " Where the fixture stopped: `failure.json`, `error.txt`." : ""),
  "",
].join("\n");
fs.writeFileSync(path.join(dir, "report.md"), report);

console.log(`\n${passed}/${cases.length} cases passed, ${notRun} not run. Evidence: ${dir}`);
if (desktop.lockedAt) console.error(`${desktop.summary}${verdict.reasons.length > 1 ? ` Also: ${verdict.reasons.slice(1).join("; ")}.` : ""}`);
else if (verdict.outcome !== "pass") console.error(`${verdict.outcome === "blocked" ? "BLOCKED" : "FAILED"}: ${verdict.reasons.join("; ")}.`);
process.exit(verdict.outcome === "blocked" ? DESKTOP_BLOCKED_EXIT : verdict.outcome === "pass" ? 0 : 1);
