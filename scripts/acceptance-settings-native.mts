/**
 * `pnpm acceptance:settings-native [-- --out <dir>]`
 *
 * The Settings cases that need the desktop (plan 066): the built preload and page in the app's own window with the
 * frame macOS draws, shown and activated, with real Electron input events: the window's frame (N-S001), and the
 * focus border and a day rollover while another window is in front (N-S103, N-S105). Every other former
 * `acceptance:settings` case runs in the background Playwright suite (`pnpm test:ui`), which needs no desktop.
 *
 * A desktop round: it shows and focuses a window, so it needs an awake, unlocked session and the readiness handoff
 * in docs/testing.md. Exit 0 when every case passed, 1 when one failed, and 2 (blocked) when the desktop was not
 * available: a locked session, or a window another app kept inactive for a case that needs an active window
 * (plan 057), reported as not run. A report and screenshots go to
 * docs/verification/measurements/<timestamp>-settings-native/. Requires `pnpm build` output. Nothing here ships.
 */
import { scrubbedEnv } from "./lib/runner/runner-env.mts";
import { buildFixture } from "./lib/runner/build-fixture.mts";
import { runIsolatedProcess } from "./lib/runner/isolated-process.mts";
import { DesktopBlockedError, beginDesktopRound } from "./lib/runner/desktop-session.mts";
import { failureBlocked, settingsOutcome, type FixtureFailure, type SettingsCase } from "./lib/acceptance/settings-activation.mts";
import { roundExit } from "./lib/runner/round-exit.mts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = path.join(REPO_ROOT, "node_modules/.bin/electron");
const TIMEOUT_MS = 60_000;

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
const dir = outDir ? path.resolve(outDir) : path.join(REPO_ROOT, "docs/verification/measurements", `${stamp}-settings-native`);
// Never overwrite another run's evidence.
if (outDir && fs.existsSync(dir)) fail(`${dir} already exists; choose a new directory so no earlier evidence is overwritten.`);
fs.mkdirSync(dir, { recursive: true });
const fixture = await buildFixture("settings-native", dir);

/** Electron needs a real app launch: no ELECTRON_RUN_AS_NODE, no inherited signing env. */
const env = scrubbedEnv();

// Real input, focus and screenshots need an awake, unlocked display.
const desktop = await beginDesktopRound().catch((cause: unknown) => {
  if (cause instanceof DesktopBlockedError) fail(`BLOCKED: ${cause.message}`);
  throw cause;
});
const controller = new AbortController();
/** The first signal names the exit code (round-exit.mts). */
let interruptedBy: "SIGINT" | "SIGTERM" | undefined;
const interrupt = (name: "SIGINT" | "SIGTERM") => (): void => { interruptedBy ??= name; controller.abort(); };
const onSigint = interrupt("SIGINT"), onSigterm = interrupt("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
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
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
}
fs.writeFileSync(path.join(dir, "cleanup.json"), JSON.stringify(execution, null, 2));
const processClean = !execution.error && !execution.stopped && execution.groupGone;
/** The fixture's process group may still exist, or its end could not be confirmed: that alone fails the round. */
const cleanupIncomplete = Boolean(execution.error) || !execution.groupGone;

const resultsPath = path.join(dir, "results.json");
if (!fs.existsSync(resultsPath)) {
  const detail = fs.existsSync(path.join(dir, "error.txt")) ? fs.readFileSync(path.join(dir, "error.txt"), "utf8") : "";
  const early = roundExit({ cleanupIncomplete, interrupted: interruptedBy, locked: Boolean(desktop.lockedAt), failed: true });
  fail(`${early.outcome === "interrupted" ? `INTERRUPTED (${interruptedBy}) before any case was recorded; the fixture exited.\n` : desktop.lockedAt ? `${desktop.summary}\n` : ""}`
    + `The fixture produced no results (exit ${execution.code ?? "by signal"}). ${detail}\nEvidence: ${dir}`, early.code);
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
const end = roundExit({ cleanupIncomplete, interrupted: interruptedBy, locked: Boolean(desktop.lockedAt),
  blocked: verdict.outcome === "blocked", failed: verdict.outcome === "fail" });
const passed = cases.filter((result) => result.ok).length;
const notRun = cases.filter((result) => result.notRun).length;
const report = [
  `# Settings native acceptance — ${stamp}`,
  "",
  `Result: **${end.outcome}**${end.outcome === "interrupted" ? ` (${interruptedBy}; nothing was left running)` : ""}${verdict.reasons.length ? ` — ${verdict.reasons.join("; ")}` : ""}.`,
  `Fixture exit code ${execution.code ?? "none (signal)"}; ${passed}/${cases.length} cases passed, ${notRun} not run.`,
  ...(stopped ? [stopped] : []),
  `Cleanup: process group gone=${execution.groupGone}; stopped=${execution.stopped ?? "no"}; error=${execution.error ?? "none"}. See cleanup.json.`,
  desktop.summary,
  "",
  "Built artifacts under test: `out/preload/settings.js`, `out/renderer/settings.html`, in the app's own window",
  "(`settingsWindowOptions`) with the frame the OS draws, shown and activated. Input is Electron's `sendInputEvent`",
  "to the page; the window activation and the frame are the desktop's. The failures view is the real `settingsView`",
  "over the production `RecordingResults`; the IPC handlers are the fixture's. Every other Settings case is in",
  "`pnpm test:ui` (tests/ui), in the background. No tray click and no Settings entry was exercised.",
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
if (end.outcome === "interrupted") console.error(`INTERRUPTED (${interruptedBy}); the fixture exited and nothing was left running.`);
else if (end.outcome === "blocked" && desktop.lockedAt) console.error(`${desktop.summary}${verdict.reasons.length > 1 ? ` Also: ${verdict.reasons.slice(1).join("; ")}.` : ""}`);
else if (end.outcome !== "pass") console.error(`${end.outcome === "blocked" ? "BLOCKED" : "FAILED"}: ${cleanupIncomplete ? "cleanup incomplete; " : ""}${verdict.reasons.join("; ")}.`);
process.exit(end.code);
