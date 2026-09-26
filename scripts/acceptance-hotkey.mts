/**
 * `pnpm acceptance [-- --seconds 10] [--no-open-material] [--skip-cancel] [--out <dir>]`
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
 * docs/verification/measurements/<timestamp>-hotkey-acceptance/. Waits read
 * the log through rotation-aware cursors and follow this run's session by the
 * ids in its session records (plan 029), so a rotated or restarted log can
 * neither hide the save nor lend an older one.
 *
 * It uses the app's real settings, countdown included (plan 040): the report
 * gives preparation, each countdown tick, the overlay's dismissal,
 * `record → started` and `started → first chunk` separately, and no latency
 * threshold absorbs the countdown. With a countdown it saves crops of the
 * digit region from the first 15 frames and, over the test material's dark
 * marker, compares each with the same flash phase two seconds later. A second
 * case then presses the shortcut twice: the countdown must cancel with no
 * file, failure or recording (`--skip-cancel` omits it).
 *
 * Exit 0 when the shortcut flow completed and no integrity check failed, was
 * blocked or is incomplete; channel energy is required evidence (plan 030), so
 * missing ffmpeg/ffprobe blocks the run (exit 2) before any key is sent. The
 * verifier runs with `testMaterial`, so the audio bitrate of the page's sparse
 * beeps is reported, not judged (see docs/system-design/tooling.md).
 * macOS only (`open`, `osascript`, `pgrep`). Nothing here ships with the app.
 */
import { setTimeout as delay } from "node:timers/promises";
import { command, confirmedIdle, quitIdleApp, settleRecording, waitForLog, waitForRecord } from "./lib/acceptance-runtime.mts";
import { inputDiagnostics } from "./lib/acceptance-diagnostics.mts";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acceleratorToKeystroke,
  currentRunId,
  currentState,
  keystrokeScript,
  lineTime,
  materialOpenArgs,
  registeredAccelerator,
} from "./lib/acceptance.mts";
import { LogReader, evidenceSince, type LogCursor } from "./lib/log-reader.mts";
import { hasTool, syncMarkers } from "./lib/media-tools.mts";
import { readLogPairs, verifyRecording } from "./lib/verify-recording.mts";
import { BLOCKED_EXIT, blocksSuccess, formatText } from "./lib/verify.mts";
import { DIGIT_DIFF_THRESHOLD, countdownTimeline, digitCrops, digitRegion, type CountdownTimeline } from "./lib/countdown-evidence.mts";
import { DESKTOP_BLOCKED_EXIT, DesktopBlockedError, beginDesktopRound } from "./lib/desktop-session.mts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PATH = path.join(os.homedir(), "Library/Logs/recordstuff/recordstuff.log");
const MATERIAL = path.join(REPO_ROOT, "scripts/test-material.html");
/** A fresh profile per run: a reused one that was killed restores its last window and ignores `--kiosk`. */
let MATERIAL_PROFILE: string;

let seconds = 10;
let openMaterial = true;
let cancelCase = true;
let outDir: string | undefined;
const argv = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--"));
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--seconds") seconds = Number(argv[++i]);
  else if (arg === "--no-open-material") openMaterial = false;
  else if (arg === "--skip-cancel") cancelCase = false;
  else if (arg === "--out") outDir = argv[++i];
  else {
    console.error("usage: pnpm acceptance [-- --seconds N] [--no-open-material] [--skip-cancel] [--out <dir>]");
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
/** Rotation-aware: positions are cursors, and the retained archives count as history. */
const appLog = new LogReader(LOG_PATH);
const readLines = (): string[] => appLog.all();
/** Where the next log line will appear, even if a rotation moves the current file meanwhile. */
const nextIndex = (): LogCursor => appLog.end();
const now = (): string => new Date().toISOString();

class AcceptanceFailure extends Error {}
/** Thrown, not `process.exit`, so `finally` still closes the material kiosk. */
function fail(message: string): never {
  throw new AcceptanceFailure(message);
}

function appRunning(): string | undefined {
  const r = spawnSync("pgrep", ["-f", "RecordStuff\\.app/Contents/MacOS/RecordStuff($| )"], { encoding: "utf8" });
  if (r.error || ![0, 1].includes(r.status ?? -1)) fail("could not check for a running RecordStuff.app (pgrep)");
  const pids = r.stdout.trim().split("\n").filter(Boolean);
  if (pids.length > 1) fail("multiple RecordStuff processes; refusing to choose one");
  const pid = pids[0];
  return pid ? pid : undefined;
}

async function sendKey(script: string): Promise<string> {
  controller.signal.throwIfAborted();
  const at = now();
  // Finish bounded delivery before handling cancellation, so cleanup knows whether stop was sent.
  await command("osascript", ["-e", script], AbortSignal.timeout(5000), 5000);
  return at;
}

function waitFor(from: LogCursor, pattern: RegExp, what: string): ReturnType<typeof waitForLog> {
  return waitForLog(appLog, from, pattern, what, controller.signal);
}

function describeTimeline(t: CountdownTimeline): string {
  const ms = (value: number | undefined): string => (value === undefined ? "?" : `${value} ms`);
  return [
    `countdown ${t.countdown ?? "?"} s`,
    `preparation (press → prepared) ${ms(t.preparationMs)}`,
    `ticks ${t.ticks.length ? t.ticks.map((tick) => `${tick.remaining}@+${tick.atMs}`).join(", ") : "none"}`,
    `overlay ${t.dismissal ? `${t.dismissal.outcome}${t.dismissal.ms === undefined ? "" : ` after ${t.dismissal.ms} ms`}` : "not shown"}`,
    `record sent ${t.recordAfterAnchorMs === undefined ? "without a countdown" : `${t.recordAfterAnchorMs} ms after the anchor`}`,
    `record → started ${ms(t.recordToStartedMs)}`,
    `started → first chunk ${ms(t.startedToFirstChunkMs)}`,
  ].join("; ");
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") fail("macOS only");
  const missingTools = ["ffprobe", "ffmpeg"].filter((tool) => !hasTool(tool));
  if (missingTools.length > 0) {
    console.error(`BLOCKED: ${missingTools.join(" and ")} missing (brew install ffmpeg); channel energy is required evidence. No key was sent.`);
    process.exit(BLOCKED_EXIT);
  }
  const pid = appRunning() ?? fail("RecordStuff is not running; start it with `pnpm start:app` first");
  const lines = readLines();
  const accelerator = registeredAccelerator(lines) ?? fail("the running app did not log `hotkey: registered …` after its last start (shortcut disabled or refused)");
  const state = currentState(lines);
  if (!confirmedIdle(lines)) fail(`the app is in state ${state}; it must be idle (screen recording permission granted, no session running)`);
  const run = currentRunId(lines) ?? fail("the running app's start line has no run id (built before session records); rebuild it with `pnpm start:app`");
  const keystroke = acceleratorToKeystroke(accelerator) ?? fail(`cannot type accelerator ${accelerator} through System Events`);
  const script = keystrokeScript(keystroke);
  console.log(`RecordStuff pid ${pid}; run ${run}; shortcut ${accelerator}; ${seconds} s recording; log ${LOG_PATH}`);
  // A slept or locked display would be recorded instead of the material.
  const desktop = await beginDesktopRound().catch((cause: unknown) => {
    if (cause instanceof DesktopBlockedError) { console.error(`BLOCKED: ${cause.message} No key was sent.`); process.exit(DESKTOP_BLOCKED_EXIT); }
    throw cause;
  });

  const stamp = now().replace(/[:.]/g, "-");
  const dir = outDir ?? path.join(REPO_ROOT, "docs/verification/measurements", `${stamp}-hotkey-acceptance`);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) fail("output directory is not empty; preserving existing evidence");
  fs.mkdirSync(dir, { recursive: true });

  MATERIAL_PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-acceptance-profile-"));
  let runError: unknown;
  const cleanupErrors: string[] = [];
  let material: ReturnType<typeof spawn> | undefined;
  let recordingFrom: LogCursor | undefined;
  /** This run's session, once its capture record names it; the report identifies it. */
  let session: string | undefined;
  /** The attempt cleanup must settle: the recording's session, then none for the cancel case. */
  let cleanupSession: string | undefined;
  let stopSent = false;
  const sessionFrom = nextIndex();
  const diagnostics: Array<Record<string, unknown>> = [];
  const diagnose = async (phase: string): Promise<void> => {
    diagnostics.push({ phase, pid, accelerator, appleScript: script, ...await inputDiagnostics(pid) });
    fs.writeFileSync(path.join(dir, "input-diagnostics.json"), JSON.stringify(diagnostics, null, 2));
  };
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

    await diagnose("before-start");
    const before = nextIndex();
    recordingFrom = before;
    const sentStart = await sendKey(script);
    note(`sent ${accelerator} via System Events (start)`);
    const pressed = await waitFor(before, /hotkey: \S+ pressed/, "`hotkey: … pressed`");
    const recording = await waitFor(pressed.at, /state → recording/, "`state → recording`");
    const capture = await waitForRecord(appLog, pressed.at, (r): r is Extract<typeof r, { kind: "capture" }> => r.kind === "capture",
      "this run's capture session record", controller.signal);
    if (capture.record.run !== run) fail(`the capture record belongs to run ${capture.record.run}, not ${run}: the app restarted`);
    session = capture.record.session;
    cleanupSession = session;
    note(`session ${session} (run ${run})`);
    const startLatency = (lineTime(pressed.line)?.getTime() ?? 0) - new Date(sentStart).getTime();
    note(`recording (press → pressed ${startLatency} ms; pressed → recording ${(lineTime(recording.line)?.getTime() ?? 0) - (lineTime(pressed.line)?.getTime() ?? 0)} ms, preparation and any countdown included)`);

    await sleep(seconds * 1000);
    // By now the first chunk has arrived; each phase is reported on its own.
    const timeline = countdownTimeline(appLog.since(pressed.at).lines.map((line) => line.text), lineTime(pressed.line) ?? new Date(sentStart));
    note(`start timeline: ${describeTimeline(timeline)}`);
    const beforeStop = nextIndex();
    await sendKey(script);
    stopSent = true;
    note(`sent ${accelerator} via System Events (stop)`);
    await waitFor(beforeStop, /hotkey: \S+ pressed/, "second `pressed`");
    // From the capture record: a failure before the stop key is this session's outcome too.
    const terminal = await waitForRecord(appLog, capture.next,
      (r): r is Extract<typeof r, { kind: "saved" | "failed" }> => (r.kind === "saved" || r.kind === "failed") && r.run === run && r.session === session,
      `the terminal session record of ${session}`, controller.signal);
    recordingFrom = undefined;
    if (terminal.record.kind === "failed") fail(`session ${session} failed: ${terminal.record.code} ${terminal.record.detail}`);
    const file = terminal.record.path;
    note(`saved ${file}`);

    if (material) {
      spawnSync("pkill", ["-f", MATERIAL_PROFILE]);
      material = undefined;
    }

    const result = verifyRecording(file, readLogPairs(LOG_PATH), { expectedDurationSeconds: seconds, testMaterial: openMaterial, required: { energy: true } });
    const text = formatText(file, result.entry, result.checks, result.pairing);
    console.log(text);
    // Blocked or incomplete required evidence is no more a pass than a failure is.
    const failing = result.checks.filter((c) => blocksSuccess(c.verdict));
    // Evidence guards: the marker box must be in the recording (flashes) and the
    // beeps must stand out of silence. No flashes means the material was not on
    // the recorded display; no beeps means other audio was playing (or the
    // output was muted), which contaminates the audio evidence.
    const guards: string[] = [];
    // Media measurements stand on their own; checks against requested settings need this session's metadata.
    if (result.pairing.status !== "matched" || result.entry?.sessionId !== session || result.entry.runId !== run) {
      guards.push(`log metadata for this file is ${result.pairing.status}${result.pairing.note ? ` (${result.pairing.note})` : ""}, not session ${session}; requested-settings checks were not judged`);
    }
    if (timeline.countdown === undefined) guards.push("the app logged no `prepared` line: it was built before plan 040; rebuild it with `pnpm start:app`");
    else if (timeline.ticks.map((tick) => tick.remaining).join() !== Array.from({ length: timeline.countdown }, (_, i) => timeline.countdown! - i).join()) {
      guards.push(`countdown ticks ${timeline.ticks.map((tick) => tick.remaining).join(", ") || "none"} do not count down from ${timeline.countdown}`);
    }
    let crops: ReturnType<typeof digitCrops> | undefined;
    const video = result.measurement.video;
    if (timeline.countdown && timeline.overlay && video) {
      const region = digitRegion(timeline.overlay, video);
      try {
        crops = digitCrops(file, region, path.join(dir, "digit-crops"));
        note(`digit region ${region.width}x${region.height}+${region.x}+${region.y}: first 15 frames saved; ${crops.judged} judged against the frames ${crops.laterSeconds} s later; worst mean difference ${crops.worst?.toFixed(2) ?? "n/a"} (threshold ${DIGIT_DIFF_THRESHOLD})`);
        // Only the material's marker is known to be static there; elsewhere the crops are evidence, not a verdict.
        if (openMaterial && !crops.pass) guards.push(`the countdown digit may appear in the first frames: worst mean difference ${crops.worst?.toFixed(2) ?? "n/a"} over ${crops.judged} judged frame(s), threshold ${DIGIT_DIFF_THRESHOLD}`);
      } catch (error) { guards.push(`digit crops failed: ${String(error)}`); }
    } else if (timeline.countdown) guards.push("no overlay placement was logged: digit crops not taken");
    else note("countdown Off: no digit to crop");
    if (openMaterial) {
      const markers = syncMarkers(file, result.measurement.durationSeconds);
      const expected = Math.floor(seconds / 2);
      note(`markers: ${markers.flashes.length} flashes, ${markers.beeps.length} beeps in ${seconds} s`);
      if (markers.flashes.length < expected) guards.push(`material not visible in the recording (${markers.flashes.length} flashes; the kiosk did not cover the recorded display)`);
      if (markers.beeps.length < expected) guards.push(`beeps not separable from silence (${markers.beeps.length} found): other audio was playing or output is muted; audio evidence is contaminated`);
    }

    // A second press during the countdown cancels: no file, failure or recording.
    const cancel: string[] = [];
    let cancelSummary = "not run";
    if (!cancelCase) cancelSummary = "not run (--skip-cancel)";
    else if (!timeline.countdown) cancelSummary = "not applicable: the countdown is Off";
    else {
      const beforeCancel = nextIndex();
      recordingFrom = beforeCancel;
      stopSent = false;
      cleanupSession = undefined;
      await sendKey(script);
      note(`cancel case: sent ${accelerator} (start)`);
      const counting = await waitFor(beforeCancel, /state → countdown \(\d+\)/, "`state → countdown`");
      await sendKey(script);
      stopSent = true;
      note(`cancel case: sent ${accelerator} again during the countdown`);
      const cancelled = await waitFor(counting.next, /\] cancelled: session \S+ \(\w+\)/, "`cancelled: session …`");
      recordingFrom = undefined;
      const [, cancelledSession, reason] = /cancelled: session (\S+) \((\w+)\)/.exec(cancelled.line) ?? [];
      const temporary = /; temporary file (.+)$/.exec(cancelled.line)?.[1];
      await sleep(500);
      const after = appLog.since(beforeCancel).lines.map((line) => line.text);
      if (reason !== "toggle") cancel.push(`cancelled by ${reason ?? "?"}, not by the second press`);
      if (!temporary) cancel.push("the cancel line names no temporary file");
      else if (fs.existsSync(temporary) || fs.existsSync(temporary.replace(/\.recording\.mp4$/, ".mp4"))) cancel.push(`a file remains: ${temporary}`);
      const forbidden = after.filter((line) => /\] failed: |"kind":"failed"|record sent|state → recording|notification: show requested/.test(line));
      if (forbidden.length) cancel.push(`unexpected lines: ${forbidden.join(" | ")}`);
      if (currentState(after) !== "idle") cancel.push(`state ${currentState(after) ?? "?"} after the cancel`);
      cancelSummary = cancel.length ? `FAIL: ${cancel.join("; ")}` : `pass: session ${cancelledSession} cancelled by the second press; ${temporary} removed; no failure, notification or recording`;
      note(`cancel case: ${cancelSummary}`);
      if (cancel.length) guards.push(`cancel case: ${cancel.join("; ")}`);
    }

    fs.writeFileSync(path.join(dir, "verify.json"), JSON.stringify(result, null, 2) + "\n");
    fs.writeFileSync(path.join(dir, "app-session.log"), evidenceSince(appLog, sessionFrom).filter(Boolean).join("\n") + "\n");
    fs.writeFileSync(
      path.join(dir, "report.md"),
      [
        "# Global shortcut acceptance (`pnpm acceptance`)",
        "",
        `Run ${now()} on ${os.hostname()}, macOS ${os.release()}, pid ${pid}, app run \`${run}\`, session \`${session}\`, shortcut \`${accelerator}\`, ${seconds} s requested. Keys were sent by System Events from this script; the material was ${openMaterial ? "opened fullscreen in Chrome app mode with autoplay allowed" : "shown by the operator"}. Material SHA-256 \`${createHash("sha256").update(fs.readFileSync(MATERIAL)).digest("hex")}\`.`,
        "",
        `Result: **${failing.length === 0 && guards.length === 0 ? "pass" : "fail"}** (${failing.length} check(s) not passed; integrity tier${openMaterial ? ", test material: audio bitrate reported only" : ""}${guards.length ? `; evidence guards: ${guards.join("; ")}` : ""}).`,
        "",
        "## Events",
        "",
        ...events.map((e) => `- ${e}`),
        "",
        "## Start timeline",
        "",
        describeTimeline(timeline),
        "",
        "## Countdown digit",
        "",
        crops
          ? `Crops of the first 15 frames and of the 15 frames ${crops.laterSeconds} s later: [digit-crops/](digit-crops/). ${crops.judged} frame(s) judged; worst mean luma difference ${crops.worst?.toFixed(2) ?? "n/a"} (threshold ${DIGIT_DIFF_THRESHOLD}; flash frames skipped)${openMaterial ? "" : "; material not opened, so not judged"}.`
          : timeline.countdown ? "No crops (see guards)." : "Countdown Off: nothing to crop.",
        "",
        "## Cancel case",
        "",
        cancelSummary,
        "",
        "## Verifier",
        "",
        "```text",
        text,
        "```",
        "",
        `File: \`${file}\`. Evidence: [verify.json](verify.json), [app-session.log](app-session.log). Not covered: tray menu cases, tray-click cancel, the overlay seen by eye, playback by ear, first permission grant, long recordings.`,
      ].join("\n"),
    );
    console.log(`Report ${path.relative(REPO_ROOT, dir)}/report.md`);
    if (failing.length > 0) fail(`${failing.length} verifier check(s) not passed: ${failing.map((c) => `${c.metric} (${c.verdict})`).join(", ")}`);
    if (guards.length > 0) fail(guards.join("; "));
  } catch (error) {
    runError = error;
    await diagnose("failure");
  } finally {
    try {
      if (recordingFrom !== undefined) {
        // A ready app with no session events after the deadline never started recording: safe to quit, though the run fails.
        const settled = await settleRecording({
          log: appLog, from: recordingFrom, stopSent, signal: AbortSignal.timeout(30_000),
          stop: () => command("osascript", ["-e", script], AbortSignal.timeout(5000), 5000),
          ...(cleanupSession ? { session: cleanupSession } : {}),
        });
        if (settled.neverStarted) note("cleanup: no recording started; app remains idle");
      }
      const signal = AbortSignal.timeout(15_000);
      let bundle: string | undefined;
      await quitIdleApp({
        pid, running: appRunning, read: readLines, signal,
        quit: async () => {
          const executable = (await command("ps", ["-p", pid, "-o", "comm="], signal)).trim();
          const suffix = "/Contents/MacOS/RecordStuff";
          if (!executable.endsWith(`RecordStuff.app${suffix}`)) fail("unexpected executable; refusing to quit");
          bundle = executable.slice(0, -suffix.length);
          await command("osascript", ["-e", `tell application ${JSON.stringify(bundle)} to quit`], signal);
        },
      });
      if (bundle) {
        const pattern = `${bundle}/Contents/`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        while ((await command("pgrep", ["-f", `^${pattern}`], signal, 5000, [0, 1])).trim()) {
          await delay(100, undefined, { signal });
        }
      }
      note("cleanup: RecordStuff exited; recordings and reports preserved");
    } catch (error) {
      cleanupErrors.push(String(error));
    } finally {
      if (material) spawnSync("pkill", ["-f", MATERIAL_PROFILE]);
      try {
        const signal = AbortSignal.timeout(5000);
        while ((await command("pgrep", ["-f", MATERIAL_PROFILE], signal, 1000, [0, 1])).trim()) {
          await delay(100, undefined, { signal });
        }
      } catch (error) { cleanupErrors.push(`material process: ${String(error)}`); }
      // Chrome keeps writing for a moment after pkill returns, so a single rm
      // races it. Report any residue after bounded retries.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { fs.rmSync(MATERIAL_PROFILE, { recursive: true, force: true }); break; }
        catch (error) {
          if (attempt === 4) cleanupErrors.push(`material profile: ${String(error)}`);
          else await delay(400);
        }
      }
    }
    desktop.end();
    fs.writeFileSync(path.join(dir, "app-session.log"), evidenceSince(appLog, sessionFrom).join("\n"));
    fs.writeFileSync(path.join(dir, "events.log"), events.join("\n"));
    const report = path.join(dir, "report.md");
    const passed = !runError && cleanupErrors.length === 0;
    if (!fs.existsSync(report)) fs.writeFileSync(report, "# Global shortcut acceptance\n");
    fs.appendFileSync(report, `\n\n## Final result (including cleanup)\n\nInput context: [input-diagnostics.json](input-diagnostics.json). Run events: [events.log](events.log). App callbacks: [app-session.log](app-session.log).\n\n${desktop.lockedAt ? "BLOCKED" : passed ? "PASS" : "FAIL"}\n\n${desktop.summary}\n\n${runError ? `Run: ${String(runError)}\n` : ""}Cleanup: ${cleanupErrors.length ? cleanupErrors.join("; ") : "complete; RecordStuff exited"}\n`);
    if (desktop.lockedAt) { console.error(`✗ ${desktop.summary}`); process.exit(DESKTOP_BLOCKED_EXIT); }
    if (!passed) fail([runError && String(runError), ...cleanupErrors].filter(Boolean).join("; "));
  }
  console.log("✅ shortcut acceptance and cleanup passed");
}

main().catch((error: unknown) => {
  if (error instanceof AcceptanceFailure) console.error(`✗ ${error.message}`);
  else console.error(error);
  process.exit(1);
});
