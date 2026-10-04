/**
 * `pnpm acceptance:player [-- --out <dir>]`
 *
 * Acceptance of the recordings player and its full-screen window against the *built* artifacts (2026-10-05): it
 * makes a short decodable clip with FFmpeg, then runs Electron on the compiled `scripts/fixtures/player-panel.ts`,
 * which opens `out/renderer/settings.html` in the app's own window, plays the clip from its card and drives the
 * player and `out/renderer/video.html` full screen with real mouse and key input: the player's own controls, their
 * resting and waking, Space, K, → and M, a seek-bar drag, the volume slider, the window controls' corner, full
 * screen from its button and a double-click with the title and the time handed both ways, F and Escape, and Close.
 *
 * Full screen covers the display it runs on, so this is a desktop round: it needs an awake, unlocked session and
 * the readiness handoff in docs/testing.md. Exit 0 when every case passed, 1 when one failed or cleanup was
 * incomplete, and 2 (blocked) for a missing prerequisite (`pnpm build` output, Electron, FFmpeg) or a locked
 * session. A report, the cases and screenshots go to docs/verification/measurements/<timestamp>-player-acceptance/.
 * Nothing here ships with the app.
 */
import { scrubbedEnv } from "./lib/runner-env.mts";
import { buildFixture } from "./lib/build-fixture.mts";
import { runIsolatedProcess } from "./lib/isolated-process.mts";
import { DESKTOP_BLOCKED_EXIT, DesktopBlockedError, beginDesktopRound } from "./lib/desktop-session.mts";
import { hasTool } from "./lib/media-tools.mts";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = path.join(REPO_ROOT, "node_modules/.bin/electron");
const TIMEOUT_MS = 120_000;
/** Long enough to rest, seek and skip 5 s within it; FFmpeg's test pattern and a tone, so frames and sound both move. */
const CLIP_SECONDS = 8;

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

for (const required of ["out/preload/settings.js", "out/preload/video.js", "out/renderer/settings.html", "out/renderer/video.html"]) {
  if (!fs.existsSync(path.join(REPO_ROOT, required))) fail(`BLOCKED: ${required} is missing; run \`pnpm build\` first.`);
}
if (!fs.existsSync(ELECTRON)) fail("BLOCKED: node_modules/.bin/electron is missing; run `pnpm install` first.");
if (!hasTool("ffmpeg")) fail("BLOCKED: ffmpeg is missing; install it with `brew install ffmpeg` (it makes the clip the player plays).");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = outDir ? path.resolve(outDir) : path.join(REPO_ROOT, "docs/verification/measurements", `${stamp}-player-acceptance`);
fs.mkdirSync(dir, { recursive: !outDir });

// The clip, named as the app names its recordings a minute ago, so its card reads "Today" and its time.
const clips = path.join(dir, "recordings");
fs.mkdirSync(clips);
const at = new Date(Date.now() - 60_000);
const two = (value: number): string => String(value).padStart(2, "0");
const clip = path.join(clips, `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}-${two(at.getMinutes())}-${two(at.getSeconds())}.mp4`);
const made = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=30:duration=${CLIP_SECONDS}`,
  "-f", "lavfi", "-i", `sine=frequency=440:duration=${CLIP_SECONDS}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
  "-movflags", "+faststart", clip], { encoding: "utf8", timeout: 60_000 });
if (made.status !== 0 || !fs.existsSync(clip)) fail(`BLOCKED: ffmpeg could not make the clip: ${(made.stderr || made.error?.message || "").trim().slice(-400)}`);
fs.utimesSync(clip, at, at);
// A portrait clip, older, so the stage is seen to keep its 16:9 shape and leave black beside a narrower recording.
const portraitAt = new Date(at.getTime() - 60_000);
const portrait = path.join(clips, `${portraitAt.getFullYear()}-${two(portraitAt.getMonth() + 1)}-${two(portraitAt.getDate())} ${two(portraitAt.getHours())}-${two(portraitAt.getMinutes())}-${two(portraitAt.getSeconds())}.mp4`);
const madePortrait = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=30:duration=4",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", portrait], { encoding: "utf8", timeout: 60_000 });
if (madePortrait.status !== 0 || !fs.existsSync(portrait)) fail(`BLOCKED: ffmpeg could not make the portrait clip: ${(madePortrait.stderr || "").trim().slice(-400)}`);
fs.utimesSync(portrait, portraitAt, portraitAt);

const fixture = await buildFixture("player-panel", dir);
const env = scrubbedEnv();
// Real input, full screen and screenshots need an awake, unlocked display.
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
  execution = await runIsolatedProcess({ executable: ELECTRON, args: [fixture, dir, REPO_ROOT, clips], cwd: REPO_ROOT,
    env, logFd: log, timeoutMs: TIMEOUT_MS, signal: controller.signal });
} finally {
  desktop.end();
  fs.closeSync(log);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
fs.writeFileSync(path.join(dir, "cleanup.json"), JSON.stringify(execution, null, 2));
const processClean = !execution.error && !execution.stopped && execution.groupGone;

const resultsPath = path.join(dir, "results.json");
const cases = fs.existsSync(resultsPath) ? JSON.parse(fs.readFileSync(resultsPath, "utf8")) as Array<{ name: string; ok: boolean; detail: string }> : [];
const stoppedEarly = fs.existsSync(path.join(dir, "error.txt")) ? fs.readFileSync(path.join(dir, "error.txt"), "utf8") : "";
const failed = cases.filter(result => !result.ok);
const outcome = desktop.lockedAt ? "blocked" : !cases.length || failed.length || stoppedEarly || !processClean || execution.code !== 0 ? "fail" : "pass";
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
  `Clips: \`${path.relative(dir, clip)}\`, ${CLIP_SECONDS} s 1280×720 H.264 with AAC, and \`${path.relative(dir, portrait)}\`, 4 s 720×1280, made by FFmpeg for this round.`,
  "Built artifacts under test: `out/renderer/settings.html`, `out/renderer/video.html` and their preloads, in the app's own",
  "Settings window frame and the app's own `VideoFullScreen`. Input is sent to the pages (`sendInputEvent`); the IPC",
  "handlers are the fixture's, answering as `SettingsWindow.playFullScreen` does. Whether the sound is heard is not judged.",
  "",
  ...cases.map(result => `- ${result.ok ? "PASS" : "FAIL"} — ${result.name}\n  - ${result.detail}`),
  "",
  "Screenshots: `player-playing-light.png`, `player-resting-light.png`, `player-paused-light.png`, `player-paused-dark.png`,",
  "`fullscreen-playing.png`, `player-portrait-light.png`. Raw cases: `results.json`. Electron output: `electron.log`.",
  "",
].join("\n");
fs.writeFileSync(path.join(dir, "report.md"), report);
console.log(`\n${cases.length - failed.length}/${cases.length} cases passed. Evidence: ${dir}`);
if (outcome !== "pass") console.error(`${outcome === "blocked" ? `BLOCKED: ${desktop.summary}` : "FAILED"}`);
process.exit(outcome === "blocked" ? DESKTOP_BLOCKED_EXIT : outcome === "pass" ? 0 : 1);
