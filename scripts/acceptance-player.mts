/**
 * `pnpm acceptance:player [-- --out <dir>]`
 *
 * The player cases that need the desktop (2026-10-05; reduced by plan 066): a checked-in decodable clip
 * (tests/ui/media) plays from its card in the app's own Settings window and full screen in the app's own
 * `VideoFullScreen`, shown on the display, with real input events sent to the pages: full screen covers the display,
 * F and Escape leave it, and the Settings window has its focus back. The player's controls, keys, drag, rest and
 * wake, the time handed both ways and the 16:9 stage run in the background suite (tests/ui/player.spec.ts).
 *
 * Full screen covers the display it runs on, so this is a desktop round: it needs an awake, unlocked session and
 * the readiness handoff in docs/testing.md. Exit 0 when every case passed, 1 when one failed or cleanup was
 * incomplete (even when the session also locked), 2 (blocked) for a missing prerequisite (`pnpm build` output,
 * Electron, the clips) or a locked session, and 130/143 after an interruption that left nothing running
 * (round-exit.mts). A report, the cases and screenshots go to docs/verification/measurements/<timestamp>-player-acceptance/.
 * Nothing here ships with the app.
 */
import { scrubbedEnv, runnerArgs } from "./lib/runner/runner-env.mts";
import { buildFixture } from "./lib/runner/build-fixture.mts";
import { runIsolatedProcess } from "./lib/runner/isolated-process.mts";
import { DesktopBlockedError, beginDesktopRound } from "./lib/runner/desktop-session.mts";
import { roundExit } from "./lib/runner/round-exit.mts";
import { recordStuffPids } from "./lib/runner/processes.mts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { staleOutReason } from "./lib/runner/runtime-inputs.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = path.join(REPO_ROOT, "node_modules/.bin/electron");
const TIMEOUT_MS = 120_000;
/** The checked-in clips (tests/ui/media/README.md): decodable, with moving frames, and the landscape one with a tone. */
const MEDIA = path.join(REPO_ROOT, "tests/ui/media");

const argv = runnerArgs();
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

for (const required of ["out/preload/settings.js", "out/preload/video.js", "out/renderer/settings.html", "out/renderer/video.html"]) {
  if (!fs.existsSync(path.join(REPO_ROOT, required))) fail(`BLOCKED: ${required} is missing; run \`pnpm build\` first.`);
}
// Built from older sources, `out/` would be tested in place of the code in front of you.
const staleBuild = staleOutReason(REPO_ROOT);
if (staleBuild) fail(`BLOCKED: ${staleBuild}`);
if (!fs.existsSync(ELECTRON)) fail("BLOCKED: node_modules/.bin/electron is missing; run `pnpm install` first.");
for (const clip of ["landscape-8s.mp4", "portrait-4s.mp4"]) if (!fs.existsSync(path.join(MEDIA, clip))) fail(`BLOCKED: tests/ui/media/${clip} is missing.`);
// A running RecordStuff takes focus and windows from the full-screen cases (2026-10-05: its rest case failed in every
// round run beside the app, in none without it), so the round would judge the desktop's sharing, not the player.
if (recordStuffPids().length) fail("BLOCKED: RecordStuff is running; quit it first, as its windows and focus interfere with the full-screen cases.");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = outDir ? path.resolve(outDir) : path.join(REPO_ROOT, "docs/verification/measurements", `${stamp}-player-acceptance`);
if (outDir && fs.existsSync(dir)) fail(`${dir} already exists; choose a new directory so no earlier evidence is overwritten.`);
fs.mkdirSync(dir, { recursive: true });

// The clips, named as the app names its recordings a minute and two minutes ago, so their cards read "Today".
const clips = path.join(dir, "recordings");
fs.mkdirSync(clips);
const two = (value: number): string => String(value).padStart(2, "0");
const nameAt = (at: Date): string => `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}-${two(at.getMinutes())}-${two(at.getSeconds())}.mp4`;
const at = new Date(Date.now() - 60_000), portraitAt = new Date(at.getTime() - 60_000);
const clip = path.join(clips, nameAt(at)), portrait = path.join(clips, nameAt(portraitAt));
fs.copyFileSync(path.join(MEDIA, "landscape-8s.mp4"), clip);
fs.copyFileSync(path.join(MEDIA, "portrait-4s.mp4"), portrait);
fs.utimesSync(clip, at, at);
fs.utimesSync(portrait, portraitAt, portraitAt);

const fixture = await buildFixture("player-panel", dir);
const env = scrubbedEnv();
// Real input, full screen and screenshots need an awake, unlocked display.
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
  execution = await runIsolatedProcess({ executable: ELECTRON, args: [fixture, dir, REPO_ROOT, clips], cwd: REPO_ROOT,
    env, logFd: log, timeoutMs: TIMEOUT_MS, signal: controller.signal });
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
const cases = fs.existsSync(resultsPath) ? JSON.parse(fs.readFileSync(resultsPath, "utf8")) as Array<{ name: string; ok: boolean; detail: string }> : [];
const stoppedEarly = fs.existsSync(path.join(dir, "error.txt")) ? fs.readFileSync(path.join(dir, "error.txt"), "utf8") : "";
const failed = cases.filter(result => !result.ok);
const { outcome, code } = roundExit({ cleanupIncomplete, interrupted: interruptedBy, locked: Boolean(desktop.lockedAt),
  failed: !cases.length || failed.length > 0 || Boolean(stoppedEarly) || !processClean || execution.code !== 0 });
for (const result of cases) console.log(`${result.ok ? "PASS" : "FAIL"}: ${result.name} — ${result.detail}`);
if (stoppedEarly) console.error(`The fixture stopped: ${stoppedEarly.split("\n")[0]}`);
const report = [
  `# Player acceptance — ${stamp}`,
  "",
  `Result: **${outcome}**. ${cases.length - failed.length}/${cases.length} cases passed; fixture exit ${execution.code ?? "none (signal)"}.`,
  ...(stoppedEarly ? [`The fixture stopped early: ${stoppedEarly.split("\n")[0]} (see error.txt).`] : []),
  `Cleanup: process group gone=${execution.groupGone}; stopped=${execution.stopped ?? "no"}; error=${execution.error ?? "none"}. See cleanup.json.`,
  desktop.summary,
  "",
  `Clips: \`${path.relative(dir, clip)}\` and \`${path.relative(dir, portrait)}\`, copies of tests/ui/media (8 s 480×270 H.264 with AAC; 4 s 270×480).`,
  "Built artifacts under test: `out/renderer/settings.html`, `out/renderer/video.html` and their preloads, in the app's own",
  "Settings window frame and the app's own `VideoFullScreen`, shown on the display. Input is sent to the pages (`sendInputEvent`);",
  "the IPC handlers are the fixture's, answering as `SettingsWindow.playFullScreen` does. Whether the sound is heard is not judged.",
  "The player's controls, keys, drag, rest and wake, the time handed both ways and the stage: `pnpm test:ui` (tests/ui/player.spec.ts).",
  "",
  ...cases.map(result => `- ${result.ok ? "PASS" : "FAIL"} — ${result.name}\n  - ${result.detail}`),
  "",
  "Screenshot: `fullscreen-playing.png`. Raw cases: `results.json`. Electron output: `electron.log`.",
  "",
].join("\n");
fs.writeFileSync(path.join(dir, "report.md"), report);
console.log(`\n${cases.length - failed.length}/${cases.length} cases passed. Evidence: ${dir}`);
if (outcome !== "pass") console.error(outcome === "blocked" ? `BLOCKED: ${desktop.summary}`
  : outcome === "interrupted" ? `INTERRUPTED (${interruptedBy}); the fixture exited and nothing was left running.`
  : `FAILED${cleanupIncomplete ? ": cleanup incomplete (see cleanup.json)" : ""}`);
process.exit(code);
