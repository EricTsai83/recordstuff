/**
 * `pnpm preview:ui [-- --out <dir>]`
 *
 * A picture gallery of the built Settings window and full-screen page (2026-10-05), for looking at a design change
 * without a desktop round: Electron draws every page offscreen (no window appears, nothing takes focus or input) from
 * `out/`, with the real model over a demonstration folder: cards over three days, and, when FFmpeg is installed, one
 * decodable clip the player and the full-screen page play. Both languages and themes, the default and a narrow size,
 * every tab, a recording, a missing permission, the player and full screen. It judges nothing; behaviour is
 * `pnpm acceptance:settings` and `pnpm acceptance:player`. Writes PNGs and index.html to
 * docs/verification/measurements/<timestamp>-ui-preview/. Requires `pnpm build` output. Exit 2 when a prerequisite is
 * missing, 1 when the render failed. Nothing here ships with the app.
 */
import { scrubbedEnv } from "./lib/runner-env.mts";
import { buildFixture } from "./lib/build-fixture.mts";
import { runIsolatedProcess } from "./lib/isolated-process.mts";
import { hasTool } from "./lib/media-tools.mts";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = path.join(REPO_ROOT, "node_modules/.bin/electron");

const argv = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--"));
let outDir: string | undefined;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--out" && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) outDir = argv[++i];
  else fail(argv[i] === "--out" ? "--out needs a directory" : `Unknown argument ${argv[i]}`);
}
function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}
for (const required of ["out/preload/settings.js", "out/preload/video.js", "out/renderer/settings.html", "out/renderer/video.html"]) {
  if (!fs.existsSync(path.join(REPO_ROOT, required))) fail(`${required} is missing; run \`pnpm build\` first.`);
}
if (!fs.existsSync(ELECTRON)) fail("node_modules/.bin/electron is missing; run `pnpm install` first.");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = outDir ? path.resolve(outDir) : path.join(REPO_ROOT, "docs/verification/measurements", `${stamp}-ui-preview`);
fs.mkdirSync(dir, { recursive: !outDir });
const clips = path.join(dir, "recordings");
fs.mkdirSync(clips);

/** A movie header stating `seconds`, all the library reads for a length; the rest of the file stays sparse. */
const movieOf = (seconds: number): Buffer => {
  const u32 = (value: number): Buffer => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
  const mvhd = Buffer.concat([u32(108), Buffer.from("mvhd"), Buffer.alloc(12), u32(1000), u32(seconds * 1000), Buffer.alloc(80)]);
  return Buffer.concat([u32(32), Buffer.from("ftypisom"), Buffer.alloc(20), u32(8 + mvhd.length), Buffer.from("moov"), mvhd]);
};
const two = (value: number): string => String(value).padStart(2, "0");
const stamped = (at: Date): string => `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}-${two(at.getMinutes())}-${two(at.getSeconds())}.mp4`;
const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 3600_000);
// Cards over three days, as a folder fills: lengths and sizes vary, one file named by its user.
for (const [ago, seconds, size] of [[0.4, 83, 180e6], [1.5, 22, 42e6], [3, 610, 640e6], [26, 240, 300e6], [28, 61, 95e6], [50, 1500, 1.2e9]] as const) {
  const at = hoursAgo(ago), file = path.join(clips, stamped(at));
  fs.writeFileSync(file, movieOf(seconds)); fs.truncateSync(file, size); fs.utimesSync(file, at, at);
}
const named = path.join(clips, "Onboarding walkthrough for the review.mp4");
fs.writeFileSync(named, movieOf(3725)); fs.truncateSync(named, 1.24e9); fs.utimesSync(named, hoursAgo(75), hoursAgo(75));
if (hasTool("ffmpeg")) {
  const clip = path.join(clips, "preview-product-demo.mp4");
  const made = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=8", "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", clip], { encoding: "utf8", timeout: 60_000 });
  if (made.status === 0) fs.utimesSync(clip, hoursAgo(0.1), hoursAgo(0.1));
  else console.warn(`ffmpeg could not make the playable clip; the player and full screen are left out: ${(made.stderr ?? "").trim().slice(-200)}`);
} else console.warn("ffmpeg is missing (brew install ffmpeg): the player and full screen are left out of the gallery.");

const fixture = await buildFixture("ui-preview", dir);
const log = fs.openSync(path.join(dir, "electron.log"), "a");
const execution = await runIsolatedProcess({ executable: ELECTRON, args: [fixture, dir, REPO_ROOT, clips], cwd: REPO_ROOT,
  env: scrubbedEnv(), logFd: log, timeoutMs: 180_000 });
fs.closeSync(log);
fs.writeFileSync(path.join(dir, "cleanup.json"), JSON.stringify(execution, null, 2));
// A gallery that left Electron's helpers running is not a finished run (review: cleanup).
if (execution.error || execution.stopped || !execution.groupGone) fail(`The preview left processes behind or was stopped (see cleanup.json): ${JSON.stringify(execution)}\nEvidence: ${dir}`, 1);
if (execution.code !== 0 || !fs.existsSync(path.join(dir, "index.html"))) {
  const detail = fs.existsSync(path.join(dir, "error.txt")) ? fs.readFileSync(path.join(dir, "error.txt"), "utf8") : "see electron.log";
  fail(`The preview did not finish (exit ${execution.code ?? "by signal"}): ${detail}\nEvidence: ${dir}`, 1);
}
const count = (JSON.parse(fs.readFileSync(path.join(dir, "shots.json"), "utf8")) as unknown[]).length;
console.log(`${count} pictures. Open ${path.join(dir, "index.html")}`);
