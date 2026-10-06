/**
 * Plays a saved recording in QuickTime Player, driven through its AppleScript
 * dictionary, and judges what the player reports and what its window shows:
 * duration and size, real-time playback, seeking, a picture that follows the
 * seek, and playback to the end. Clicking the player's own controls and
 * listening stay manual (docs/system-design/tooling.md#playback-check).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DESKTOP_BLOCKED_EXIT, DesktopBlockedError, beginDesktopRound, type DesktopRound } from "./lib/runner/desktop-session.mts";
import { hasTool, requireMediaTimeout } from "./lib/verification/media-tools.mts";
import { INTERRUPT_EXIT, escapeRegExp, pgrepPids, command } from "./lib/runner/processes.mts";
import {
  judgePlayback, meanAbsDiff, parseBounds, parseDocumentState, parseVolumeSettings, playbackScript,
  type Check, type DocumentState, type PlaybackObservations,
} from "./lib/verification/playback.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUICKTIME = "/System/Applications/QuickTime Player.app";
const quickTimePids = (): number[] => pgrepPids(`^${escapeRegExp(`${QUICKTIME}/Contents/MacOS/QuickTime Player`)}( |$)`);

const args = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--"));
if (args.length !== 1 || args[0]!.startsWith("-")) {
  console.error("usage: pnpm acceptance:playback -- <recording.mp4>");
  process.exit(2);
}
const file = path.resolve(args[0]!);

fs.mkdirSync(path.join(root, "docs/verification/measurements"), { recursive: true });
const out = fs.mkdtempSync(path.join(root, "docs/verification/measurements/", `${new Date().toISOString().replaceAll(":", "-")}-playback-`));
const controller = new AbortController();
let interrupted: keyof typeof INTERRUPT_EXIT | undefined;
for (const name of ["SIGINT", "SIGTERM"] as const) process.on(name, () => { interrupted ??= name; controller.abort(new Error(`interrupted: ${name}`)); });
const signal = controller.signal;

class Blocked extends Error {}
const osa = (script: string, timeout = 10_000): Promise<string> => command("osascript", ["-e", script], signal, timeout);
const state = async (): Promise<DocumentState> => parseDocumentState(await osa(playbackScript.state));
const pause = (ms: number): Promise<void> => delay(ms, undefined, { signal });

async function until<T>(what: string, timeoutMs: number, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeoutMs / 1000} s`);
    await pause(200);
  }
}

/** The front window as 8-bit gray pixels; the PNG stays only if the round does not pass. */
async function screenshot(name: string): Promise<Uint8Array> {
  const bounds = parseBounds(await osa(playbackScript.bounds));
  const png = path.join(out, `${name}.png`);
  await command("screencapture", ["-x", "-R", `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`, png], signal);
  const gray = spawnSync("ffmpeg", ["-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], { maxBuffer: 256 * 1024 * 1024, timeout: 30_000 });
  if (gray.error || gray.status !== 0) throw new Error(`Could not read ${png}: ${gray.error?.message ?? gray.stderr.toString().trim()}`);
  return new Uint8Array(gray.stdout);
}

async function seek(seconds: number, shot: string): Promise<{ requested: number; reached: number; pixels: Uint8Array }> {
  await osa(playbackScript.seek(seconds));
  // The new frame is drawn after the reply; give it a moment before capturing.
  await pause(800);
  return { requested: seconds, reached: (await state()).currentTime, pixels: await screenshot(shot) };
}

/** Closes what this round opened and quits the player; returns what is still left, if anything. */
async function cleanup(): Promise<string | undefined> {
  if (quickTimePids().length === 0) return undefined;
  const quiet = new AbortController();
  const send = (script: string): Promise<unknown> => command("osascript", ["-e", script], quiet.signal, 10_000).catch(() => undefined);
  await send(playbackScript.close);
  await send(playbackScript.quit);
  for (let i = 0; i < 50 && quickTimePids().length > 0; i++) await delay(200);
  const left = quickTimePids();
  return left.length > 0 ? `QuickTime Player still running (pid ${left.join(", ")})` : undefined;
}

let desktop: DesktopRound | undefined;
let owned = false;
let checks: Check[] = [];
let verdict: "pass" | "fail" | "blocked" = "fail";
let problem: string | undefined;
let observations: PlaybackObservations | undefined;
try {
  if (process.platform !== "darwin") throw new Blocked("QuickTime playback needs macOS.");
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);
  requireMediaTimeout();
  for (const tool of ["ffmpeg", "ffprobe"]) if (!hasTool(tool)) throw new Blocked(`${tool} is missing; install it with brew install ffmpeg`);
  // Only a player this round started is closed and quit; an open one may hold someone's work.
  if (quickTimePids().length > 0) throw new Blocked("QuickTime Player is already running. Quit it first; this check closes only what it opens.");
  const probed = JSON.parse(await command("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", file], signal, 30_000)) as {
    format: { duration?: string }; streams: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  const video = probed.streams.find(stream => stream.codec_type === "video");
  if (!video?.width || !video.height || !probed.format.duration) throw new Error("ffprobe found no video stream or duration");
  const expected = { duration: Number(probed.format.duration), width: video.width, height: video.height, audio: probed.streams.some(stream => stream.codec_type === "audio") };

  desktop = await beginDesktopRound();
  owned = true;
  await command("open", ["-a", QUICKTIME, file], signal);
  await until("QuickTime opening the file", 20_000, async () => Number(await osa(playbackScript.documents)) > 0 ? true : undefined);
  const opened = await until("QuickTime loading the file", 20_000, async () => { const s = await state(); return s.duration > 0 ? s : undefined; });

  // Paused frames: one position twice for the noise floor, then a later one.
  const duration = opened.duration;
  const first = await seek(duration * 0.25, "seek-25a");
  const again = await seek(duration * 0.25, "seek-25b");
  const later = await seek(duration * 0.75, "seek-75");
  const picture = { change: meanAbsDiff(first.pixels, later.pixels), noise: meanAbsDiff(first.pixels, again.pixels) };

  await osa(playbackScript.seek(0));
  await osa(playbackScript.play);
  const startedAt = performance.now();
  await pause(2000);
  const playing = await state();
  const played = { from: 0, to: playing.currentTime, playing: playing.playing, waitedSeconds: (performance.now() - startedAt) / 1000 };
  await screenshot("playing");
  await osa(playbackScript.pause);

  await osa(playbackScript.seek(Math.max(0, duration - 1.5)));
  await osa(playbackScript.play);
  const end = await until("Playback stopping at the end", 6000, async () => { const s = await state(); return s.playing ? undefined : s; }).catch(() => undefined);
  const ended = end ? { stopped: true, currentTime: end.currentTime } : { stopped: false, currentTime: (await state()).currentTime };
  await screenshot("end");

  const output = parseVolumeSettings(await command("osascript", ["-e", "get volume settings"], signal));
  observations = { expected, opened, played, seeks: [first, again, later].map(({ requested, reached }) => ({ requested, reached })), picture, ended, output };
  ({ checks, verdict } = judgePlayback(observations));
  desktop.end();
  if (desktop.lockedAt) throw new DesktopBlockedError(desktop.summary);
} catch (error) {
  desktop?.end();
  problem = error instanceof Error ? error.message : String(error);
  // A lock seen during the round blocks it, whatever the step that then failed (docs/testing.md).
  verdict = error instanceof Blocked || error instanceof DesktopBlockedError || desktop?.lockedAt ? "blocked" : "fail";
} finally {
  const left = owned ? await cleanup().catch((cause: unknown) => `cleanup failed: ${String(cause)}`) : undefined;
  if (left) { verdict = "fail"; problem = [problem, `CLEANUP INCOMPLETE: ${left}`].filter(Boolean).join("; "); }
  // The screenshots feed the picture check; only a round that did not pass keeps them, to show why.
  if (verdict === "pass") for (const name of fs.readdirSync(out)) if (name.endsWith(".png")) fs.rmSync(path.join(out, name));
  const lines = [
    `# QuickTime playback — ${verdict.toUpperCase()}`, "",
    `File: ${file}`, `Player: ${QUICKTIME} (AppleScript; the player's own buttons were not clicked)`,
    ...(desktop ? [desktop.summary] : []), "",
    ...checks.map(c => `- ${c.status === "pass" ? "✅" : c.status === "fail" ? "❌" : "—"} ${c.name}: ${c.detail}`),
    ...(problem ? ["", `Problem: ${problem}`] : []), "",
    `Cleanup: ${!owned ? "nothing opened" : left ? left : "QuickTime closed"}`,
    verdict === "pass" ? "Screenshots were removed after the pass; listening is not covered." : "Screenshots of the front window are in this directory; listening is not covered.",
  ];
  fs.writeFileSync(path.join(out, "report.md"), `${lines.join("\n")}\n`);
  fs.writeFileSync(path.join(out, "result.json"), `${JSON.stringify({ file, verdict, problem, checks, observations }, null, 2)}\n`);
  console.log(`${lines.join("\n")}\nEvidence: ${out}`);
  process.exitCode = interrupted ? (left ? 1 : INTERRUPT_EXIT[interrupted]) : verdict === "pass" ? 0 : verdict === "blocked" ? DESKTOP_BLOCKED_EXIT : 1;
}
