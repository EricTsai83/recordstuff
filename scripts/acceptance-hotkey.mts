/**
 * `pnpm acceptance [-- --seconds 10] [--no-open-material] [--out <dir>]`
 *
 * Unattended acceptance of the global recording shortcut (plan 016) against
 * the app that is already running (`pnpm start:app`): open the test material
 * in a Chrome kiosk on the primary display (as `pnpm matrix` does), send the
 * shortcut the app registered through System Events (a real system-level
 * keystroke — a key posted to one app never reaches a global shortcut), wait
 * for `state → recording`, record, send it again, wait for `saved`, then run
 * the verifier's integrity tier (what a release acceptance needs, see
 * docs/system-design/tooling.md; frame-rate and sync thresholds belong to
 * `pnpm matrix`) and write a report under
 * docs/verification/measurements/<timestamp>-hotkey-acceptance/.
 *
 * Exit 0 when the shortcut flow completed and every judged integrity check
 * passed. The verifier runs with `testMaterial`, so the audio bitrate of the
 * page's sparse beeps is reported, not judged (see docs/system-design/tooling.md).
 * macOS only (`open`, `osascript`, `pgrep`). Nothing here ships with the app.
 */
import { setTimeout as delay } from "node:timers/promises";
import { command, finishRecording, waitForLog } from "./lib/acceptance-runtime.mts";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acceleratorToKeystroke,
  currentState,
  nextLogIndex,
  keystrokeScript,
  lineTime,
  materialOpenArgs,
  registeredAccelerator,
} from "./lib/acceptance.mts";
import { hasTool, syncMarkers } from "./lib/media-tools.mts";
import { readLogPairs, verifyRecording } from "./lib/verify-recording.mts";
import { formatText } from "./lib/verify.mts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PATH = path.join(os.homedir(), "Library/Logs/recordstuff/recordstuff.log");
const MATERIAL = path.join(REPO_ROOT, "scripts/test-material.html");
/** A fresh profile per run: a reused one that was killed restores its last window and ignores `--kiosk`. */
const MATERIAL_PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-acceptance-profile-"));

let seconds = 10;
let openMaterial = true;
let outDir: string | undefined;
const argv = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--"));
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--seconds") seconds = Number(argv[++i]);
  else if (arg === "--no-open-material") openMaterial = false;
  else if (arg === "--out") outDir = argv[++i];
  else {
    console.error("usage: pnpm acceptance [-- --seconds N] [--no-open-material] [--out <dir>]");
    process.exit(2);
  }
}
if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) {
  console.error("--seconds must be in (0, 600]");
  process.exit(2);
}

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => controller.abort(new Error(`run interrupted by ${signal}`)));
}
const sleep = async (ms: number): Promise<void> => { await delay(ms, undefined, { signal: controller.signal }); };
const readLines = (): string[] => fs.readFileSync(LOG_PATH, "utf8").split(/\r?\n/);
/** Index at which the next log line will appear (the split leaves a trailing "" after the final newline). */
const nextIndex = (): number => nextLogIndex(readLines());
const now = (): string => new Date().toISOString();

class AcceptanceFailure extends Error {}
/** Thrown, not `process.exit`, so `finally` still closes the material kiosk. */
function fail(message: string): never {
  throw new AcceptanceFailure(message);
}

function appRunning(): string | undefined {
  const r = spawnSync("pgrep", ["-f", "RecordStuff.app/Contents/MacOS/RecordStuff$"], { encoding: "utf8" });
  if (r.error || ![0, 1].includes(r.status ?? -1)) fail("could not check for a running RecordStuff.app (pgrep)");
  const pid = r.stdout.trim().split("\n")[0];
  return pid ? pid : undefined;
}

async function sendKey(script: string): Promise<string> {
  controller.signal.throwIfAborted();
  const at = now();
  // Finish bounded delivery before handling cancellation, so cleanup knows whether stop was sent.
  await command("osascript", ["-e", script], AbortSignal.timeout(5000), 5000);
  return at;
}

function waitFor(from: number, pattern: RegExp, what: string): Promise<{ line: string; index: number }> {
  return waitForLog(readLines, from, pattern, what, controller.signal);
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") fail("macOS only");
  const pid = appRunning() ?? fail("RecordStuff is not running; start it with `pnpm start:app` first");
  const lines = readLines();
  const accelerator = registeredAccelerator(lines) ?? fail("the running app did not log `hotkey: registered …` after its last start (shortcut disabled or refused)");
  const state = currentState(lines);
  if (state !== undefined && state !== "idle") fail(`the app is in state ${state}; it must be idle (screen recording permission granted, no session running)`);
  const keystroke = acceleratorToKeystroke(accelerator) ?? fail(`cannot type accelerator ${accelerator} through System Events`);
  const script = keystrokeScript(keystroke);
  console.log(`RecordStuff pid ${pid}; shortcut ${accelerator}; ${seconds} s recording; log ${LOG_PATH}`);

  const stamp = now().slice(0, 16).replace(/:/g, "");
  const dir = outDir ?? path.join(REPO_ROOT, "docs/verification/measurements", `${stamp}-hotkey-acceptance`);
  fs.mkdirSync(dir, { recursive: true });

  let material: ReturnType<typeof spawn> | undefined;
  let recordingFrom: number | undefined;
  let stopSent = false;
  const events: string[] = [];
  const note = (s: string): void => {
    events.push(`${now()} ${s}`);
    console.log(s);
  };
  try {
    if (openMaterial) {
      material = spawn(
        "open",
        materialOpenArgs(MATERIAL, MATERIAL_PROFILE),
        { stdio: "ignore" },
      );
      note("opened test material in Chrome kiosk on the primary display; waiting 5 s");
      await sleep(5000);
    } else {
      note("material not opened (--no-open-material): show the test material yourself");
    }

    const before = nextIndex();
    recordingFrom = before;
    const sentStart = await sendKey(script);
    note(`sent ${accelerator} via System Events (start)`);
    const pressed = await waitFor(before, /hotkey: \S+ pressed/, "`hotkey: … pressed`");
    const recording = await waitFor(pressed.index, /state → recording/, "`state → recording`");
    const startLatency = (lineTime(pressed.line)?.getTime() ?? 0) - new Date(sentStart).getTime();
    note(`recording (press → pressed ${startLatency} ms; pressed → recording ${(lineTime(recording.line)?.getTime() ?? 0) - (lineTime(pressed.line)?.getTime() ?? 0)} ms)`);

    await sleep(seconds * 1000);
    const beforeStop = nextIndex();
    await sendKey(script);
    stopSent = true;
    note(`sent ${accelerator} via System Events (stop)`);
    await waitFor(beforeStop, /hotkey: \S+ pressed/, "second `pressed`");
    const saved = await waitFor(beforeStop, /\] saved (.+)$/, "`saved <path>`");
    const file = /\] saved (.+)$/.exec(saved.line)?.[1] ?? fail("saved line without a path");
    recordingFrom = undefined;
    note(`saved ${file}`);

    if (material) {
      spawnSync("pkill", ["-f", MATERIAL_PROFILE]);
      material = undefined;
    }

    const result = verifyRecording(file, readLogPairs(LOG_PATH), { expectedDurationSeconds: seconds, testMaterial: openMaterial });
    const text = formatText(file, result.entry, result.checks);
    console.log(text);
    const failing = result.checks.filter((c) => c.verdict === "fail");
    // Evidence guards: the marker box must be in the recording (flashes) and the
    // beeps must stand out of silence. No flashes means the material was not on
    // the recorded display; no beeps means other audio was playing (or the
    // output was muted), which contaminates the audio evidence.
    const guards: string[] = [];
    if (openMaterial && hasTool("ffmpeg")) {
      const markers = syncMarkers(file, result.measurement.durationSeconds);
      const expected = Math.floor(seconds / 2);
      note(`markers: ${markers.flashes.length} flashes, ${markers.beeps.length} beeps in ${seconds} s`);
      if (markers.flashes.length < expected) guards.push(`material not visible in the recording (${markers.flashes.length} flashes; the kiosk did not cover the recorded display)`);
      if (markers.beeps.length < expected) guards.push(`beeps not separable from silence (${markers.beeps.length} found): other audio was playing or output is muted; audio evidence is contaminated`);
    }

    const appLog = readLines().slice(Math.max(before - 5, 0)).filter(Boolean).join("\n");
    fs.writeFileSync(path.join(dir, "verify.json"), JSON.stringify(result, null, 2) + "\n");
    fs.writeFileSync(path.join(dir, "app-session.log"), appLog + "\n");
    fs.writeFileSync(
      path.join(dir, "report.md"),
      [
        "# Global shortcut acceptance (`pnpm acceptance`)",
        "",
        `Run ${now()} on ${os.hostname()}, macOS ${os.release()}, pid ${pid}, shortcut \`${accelerator}\`, ${seconds} s requested. Keys were sent by System Events from this script; the material was ${openMaterial ? "opened fullscreen in Chrome app mode with autoplay allowed" : "shown by the operator"}. Material SHA-256 \`${createHash("sha256").update(fs.readFileSync(MATERIAL)).digest("hex")}\`.`,
        "",
        `Result: **${failing.length === 0 && guards.length === 0 ? "pass" : "fail"}** (${failing.length} failing check(s); integrity tier${openMaterial ? ", test material: audio bitrate reported only" : ""}${guards.length ? `; evidence guards: ${guards.join("; ")}` : ""}).`,
        "",
        "## Events",
        "",
        ...events.map((e) => `- ${e}`),
        "",
        "## Verifier",
        "",
        "```text",
        text,
        "```",
        "",
        `File: \`${file}\`. Evidence: [verify.json](verify.json), [app-session.log](app-session.log). Not covered: tray menu cases, playback by ear, first permission grant, long recordings.`,
      ].join("\n"),
    );
    console.log(`Report ${path.relative(REPO_ROOT, dir)}/report.md`);
    if (failing.length > 0) fail(`${failing.length} verifier check(s) failed: ${failing.map((c) => c.metric).join(", ")}`);
    if (guards.length > 0) fail(guards.join("; "));
    console.log("✅ shortcut acceptance passed");
  } finally {
    try {
      if (recordingFrom !== undefined) {
        await finishRecording({
          read: readLines, from: recordingFrom, stopSent, signal: AbortSignal.timeout(30_000),
          stop: () => command("osascript", ["-e", script], AbortSignal.timeout(5000), 5000),
        });
      }
    } finally {
      if (material) spawnSync("pkill", ["-f", MATERIAL_PROFILE]);
      // Chrome keeps writing for a moment after pkill returns, so a single rm
      // races it. Cleanup of a temp profile must never fail the acceptance.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { fs.rmSync(MATERIAL_PROFILE, { recursive: true, force: true }); break; }
        catch { await delay(400); }
      }
    }
  }
}

main().catch((error: unknown) => {
  if (error instanceof AcceptanceFailure) console.error(`✗ ${error.message}`);
  else console.error(error);
  process.exit(1);
});
