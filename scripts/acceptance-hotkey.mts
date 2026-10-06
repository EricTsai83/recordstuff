/**
 * `pnpm acceptance [-- --seconds 10] [--no-open-material] [--skip-cancel] [--countdown-sound] [--out <dir>]`
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
 * It reports whether the countdown ticked (plan 046). When it did, the first
 * 500 ms of the recording's audio must hold no more energy at the tick's
 * pitches than the same phase 2 s later, and no beep onset there may lack its
 * flash. `--countdown-sound` turns the stored switch on for the round: if it
 * is off, the app is quit, the switch set and the same bundle relaunched, and
 * after the final quit only that key is set back.
 *
 * Exit 0 when the shortcut flow completed and no integrity check failed, was
 * blocked or is incomplete; channel energy is required evidence (plan 030), so
 * missing ffmpeg/ffprobe blocks the run (exit 2) before any key is sent. The
 * verifier runs with `testMaterial`, so the audio bitrate of the page's sparse
 * beeps is reported, not judged (see docs/system-design/tooling.md).
 * macOS only (`open`, `osascript`, `pgrep`). Nothing here ships with the app.
 */
import { setTimeout as delay } from "node:timers/promises";
import { APP_LOG_PATH, APP_SETTINGS_PATH, writeAppSettings } from "./lib/runner/runner-env.mts";
import { escapeRegExp, recordStuffPids, command } from "./lib/runner/processes.mts";
import { confirmedIdle, quitIdleApp, sessionEnded, settleRecording, waitForLog, waitForRecord, type TerminalRecord } from "./lib/acceptance/acceptance-runtime.mts";
import { inputDiagnostics } from "./lib/acceptance/acceptance-diagnostics.mts";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acceleratorToKeystroke,
  createMaterialProfile,
  currentRunId,
  currentState,
  sessionBelongsTo,
  keystrokeScript,
  materialOpenArgs,
  registeredAccelerator,
  removeMaterialProfile,
} from "./lib/acceptance/acceptance.mts";
import { LogReader, evidenceSince, lineTime, type LogCursor } from "./lib/runner/log-reader.mts";
import { hasTool, requireMediaTimeout, syncMarkers } from "./lib/verification/media-tools.mts";
import { readLogPairs, verifyRecording } from "./lib/verification/verify-recording.mts";
import { BLOCKED_EXIT, blocksSuccess, formatText } from "./lib/verification/verify.mts";
import { DIGIT_DIFF_THRESHOLD, TICK_EXCESS_DB, TICK_FLOOR_DBFS, countdownTimeline, digitCrops, digitRegion, skippedCrops, tickCheck, type CountdownTimeline, type TickCheck } from "./lib/acceptance/countdown-evidence.mts";
import { DESKTOP_BLOCKED_EXIT, DesktopBlockedError, beginDesktopRound } from "./lib/runner/desktop-session.mts";
import { roundExit } from "./lib/runner/round-exit.mts";
import { StoredOverride } from "./lib/acceptance/stored-override.mts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PATH = APP_LOG_PATH;
const MATERIAL = path.join(REPO_ROOT, "scripts/test-material.html");
const SETTINGS_PATH = APP_SETTINGS_PATH;
/** A fresh profile per run: a reused one that was killed restores its last window and ignores `--kiosk`. */
let MATERIAL_PROFILE: string;

let seconds = 10;
let openMaterial = true;
let cancelCase = true;
let countdownSound = false;
let outDir: string | undefined;
const argv = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--"));
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--seconds") seconds = Number(argv[++i]);
  else if (arg === "--no-open-material") openMaterial = false;
  else if (arg === "--skip-cancel") cancelCase = false;
  else if (arg === "--countdown-sound") countdownSound = true;
  else if (arg === "--out" && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) outDir = argv[++i];
  else {
    console.error("usage: pnpm acceptance [-- --seconds N] [--no-open-material] [--skip-cancel] [--countdown-sound] [--out <dir>]");
    process.exit(2);
  }
}
if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) {
  console.error("--seconds must be in (0, 600]");
  process.exit(2);
}

const controller = new AbortController();
/** The first signal names the exit code once the recording is settled and the app has quit (round-exit.mts). */
let interruptedBy: "SIGINT" | "SIGTERM" | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { interruptedBy ??= signal; controller.abort(new Error(`run interrupted by ${signal}`)); });
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
  let pids: number[];
  try { pids = recordStuffPids(); } catch (error) { fail(`could not check for a running RecordStuff.app: ${String(error)}`); }
  if (pids.length > 1) fail("multiple RecordStuff processes; refusing to choose one");
  const pid = pids[0];
  return pid === undefined ? undefined : String(pid);
}

/** The stored settings as the app reads the countdown: a missing or non-boolean sound is on (plan 046). */
function storedCountdown(): { countdown: unknown; sound: boolean; stored: unknown } {
  const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
  const stored = settings["countdownSound"];
  return { countdown: settings["countdown"] ?? 3, sound: typeof stored === "boolean" ? stored : true, stored };
}

/** Sets only the countdown sound, leaving every other key as the app last wrote it. */
function writeStoredSound(value: boolean): void {
  const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
  settings["countdownSound"] = value;
  writeAppSettings(settings, SETTINGS_PATH);
}

/** The running app's bundle, from its executable; anything else is not ours to quit or relaunch. */
async function bundleOf(pid: string, signal: AbortSignal): Promise<string> {
  const executable = (await command("ps", ["-p", pid, "-o", "comm="], signal)).trim();
  const suffix = "/Contents/MacOS/RecordStuff";
  if (!executable.endsWith(`RecordStuff.app${suffix}`)) fail("unexpected executable; refusing to quit");
  return executable.slice(0, -suffix.length);
}

/** Quits the confirmed-idle app through its bundle and waits until every process of the bundle is gone. */
async function quitBundle(pid: string, signal: AbortSignal): Promise<string | undefined> {
  let bundle: string | undefined;
  await quitIdleApp({
    pid, running: appRunning, read: readLines, signal,
    quit: async () => {
      bundle = await bundleOf(pid, signal);
      await command("osascript", ["-e", `tell application ${JSON.stringify(bundle)} to quit`], signal);
    },
  });
  if (bundle) {
    while ((await command("pgrep", ["-f", `^${escapeRegExp(bundle)}/Contents/`], signal, 5000, [0, 1])).trim()) {
      await delay(100, undefined, { signal });
    }
  }
  return bundle;
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

function describeTicks(check: TickCheck): string {
  const db = (value: number): string => (Number.isFinite(value) ? `${value.toFixed(1)} dBFS` : "silent");
  const levels = check.levels.map((l) => `${l.hz} Hz ${db(l.earlyDb)} vs ${db(l.laterDb)}`).join(", ");
  return check.onsetSeconds === undefined ? levels
    : `${levels}; capture began inside a sound at ${Math.round(check.onsetSeconds * 1000)} ms: both windows fade in from there`;
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
  const stamp = now().replace(/[:.]/g, "-");
  const dir = outDir ?? path.join(REPO_ROOT, "docs/verification/measurements", `${stamp}-hotkey-acceptance`);
  // A usage error, as in the other runners, checked before anything else can refuse or change the round.
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    console.error(`✗ ${dir} is not empty; choose a new directory so no earlier evidence is overwritten. Nothing was sent or changed.`);
    process.exit(2);
  }
  requireMediaTimeout();
  const missingTools = ["ffprobe", "ffmpeg"].filter((tool) => !hasTool(tool));
  if (missingTools.length > 0) {
    console.error(`BLOCKED: ${missingTools.join(" and ")} missing (brew install ffmpeg); channel energy is required evidence. No key was sent.`);
    process.exit(BLOCKED_EXIT);
  }
  let pid = appRunning() ?? fail("RecordStuff is not running; start it with `pnpm start:app` first");
  // Everything that can refuse the round runs before a stored value changes (review of plan 046).
  let soundOverride: StoredOverride<boolean> | undefined;
  if (countdownSound) {
    const stored = storedCountdown();
    if (stored.countdown === 0) fail("--countdown-sound needs a countdown: the stored countdown is Off; choose 3, 5 or 10 s in Settings");
    if (stored.sound) console.log(`countdown sound already on in the stored settings (${stored.stored === undefined ? "no field: the default" : "true"}); nothing to change`);
    else {
      if (!confirmedIdle(readLines())) fail("the app must be idle before its countdown sound can be turned on");
      const bundle = await bundleOf(pid, AbortSignal.timeout(5000));
      soundOverride = new StoredOverride<boolean>({
        quit: async () => { await quitBundle(appRunning() ?? pid, AbortSignal.timeout(30_000)); },
        running: () => appRunning() !== undefined,
        write: writeStoredSound,
        // Its own bounded signal, not the interrupt: a launch already issued settles to idle, so cleanup can quit it.
        relaunch: async () => {
          const signal = AbortSignal.timeout(60_000);
          const from = nextIndex();
          await command("open", ["-a", bundle], signal);
          await waitForLog(appLog, from, /\] start: /, "the relaunched app's `start:` line", signal);
          await waitForLog(appLog, from, /hotkey: registered/, "the relaunched app's `hotkey: registered`", signal);
          while (!confirmedIdle(readLines())) await delay(200, undefined, { signal });
        },
      }, false, true);
    }
  }
  // A slept or locked display would be recorded instead of the material.
  const desktop = await beginDesktopRound().catch((cause: unknown) => {
    if (cause instanceof DesktopBlockedError) { console.error(`BLOCKED: ${cause.message} No key was sent.`); process.exit(DESKTOP_BLOCKED_EXIT); }
    throw cause;
  });

  let lines: string[];
  let accelerator: string;
  let run: string;
  let script: string;
  try {
    if (soundOverride) {
      controller.signal.throwIfAborted();
      await soundOverride.apply();
      pid = appRunning() ?? fail("the relaunched RecordStuff is not running");
      console.log(`countdown sound turned on for this round; relaunched the same bundle (pid ${pid})`);
    }
    // Run right after `pnpm start:app` (as the recording recipe does), the app may not have logged
    // its start or ready lines yet; judge only this pid's session, waiting up to 30 s for it to settle.
    const settleBy = Date.now() + 30_000;
    lines = readLines();
    while (!(sessionBelongsTo(lines, pid) && confirmedIdle(lines)) && Date.now() < settleBy) {
      await delay(250, undefined, { signal: controller.signal });
      lines = readLines();
    }
    if (!sessionBelongsTo(lines, pid)) fail(`RecordStuff pid ${pid} logged no start line within 30 s; the log's latest session belongs to another process`);
    accelerator = registeredAccelerator(lines) ?? fail("the running app did not log `hotkey: registered …` after its last start (shortcut disabled or refused)");
    const state = currentState(lines);
    if (!confirmedIdle(lines)) fail(`the app is in state ${state}; it must be idle (screen recording permission granted, no session running)`);
    run = currentRunId(lines) ?? fail("the running app's start line has no run id (built before session records); rebuild it with `pnpm start:app`");
    const keystroke = acceleratorToKeystroke(accelerator) ?? fail(`cannot type accelerator ${accelerator} through System Events`);
    script = keystrokeScript(keystroke);
    fs.mkdirSync(dir, { recursive: true });
    MATERIAL_PROFILE = createMaterialProfile("acceptance");
  } catch (error) {
    // Nothing was recorded; the round's value goes back once the app it launched is gone.
    const changed = soundOverride?.pending ?? false;
    let unrestored = false;
    try {
      const problem = await soundOverride?.restore(true);
      unrestored = Boolean(problem);
      if (problem) console.error(`✗ countdown sound NOT restored: ${problem}. Quit RecordStuff, then set "countdownSound": false in ${SETTINGS_PATH}.`);
      else if (changed) console.error("countdown sound set back to off in the stored settings");
    } catch (restoreError) {
      unrestored = true;
      console.error(`✗ countdown sound NOT restored: ${String(restoreError)}. Quit RecordStuff, then set "countdownSound": false in ${SETTINGS_PATH}.`);
    } finally {
      desktop.end();
    }
    // The same order as the recording's end (round-exit.mts): an unrestored setting fails the round, an interrupt
    // exits 130 or 143 and a lock is blocked, before the setup failure itself.
    const end = roundExit({ cleanupIncomplete: unrestored, interrupted: interruptedBy, locked: Boolean(desktop.lockedAt), failed: true });
    if (end.outcome === "blocked") {
      console.error(`✗ ${desktop.summary} (setup also failed: ${String(error)})`);
      process.exit(end.code);
    }
    if (end.outcome === "interrupted") {
      console.error(`✗ INTERRUPTED (${interruptedBy}) during setup; nothing was recorded`);
      process.exit(end.code);
    }
    throw error;
  }
  console.log(`RecordStuff pid ${pid}; run ${run}; shortcut ${accelerator}; ${seconds} s recording; log ${LOG_PATH}`);

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
    // A session that already ended would take the stop key as a new start (plan 054).
    const ended = sessionEnded(appLog.since(capture.next).lines.map((line) => line.text), run, session);
    if (ended) {
      recordingFrom = undefined;
      note(`session ${session} ended before the stop key (${ended.kind}); stop not sent`);
      if (ended.kind === "failed") fail(`session ${session} failed before the stop key: ${ended.code} ${ended.detail}`);
      fail(`session ${session} saved ${ended.path} before the stop key${ended.stoppedEarly ? ` (stopped early: ${ended.stoppedEarly})` : ""}`);
    }
    const beforeStop = nextIndex();
    await sendKey(script);
    stopSent = true;
    note(`sent ${accelerator} via System Events (stop)`);
    await waitFor(beforeStop, /hotkey: \S+ pressed/, "second `pressed`");
    // From the capture record: a failure between the check and the stop key is this session's outcome too.
    const terminal = await waitForRecord(appLog, capture.next,
      (r): r is TerminalRecord => (r.kind === "saved" || r.kind === "failed") && r.run === run && r.session === session,
      `the terminal session record of ${session}`, controller.signal);
    recordingFrom = undefined;
    if (terminal.record.kind === "failed") fail(`session ${session} failed: ${terminal.record.code} ${terminal.record.detail}`);
    const file = terminal.record.path;
    note(`saved ${file}`);

    // Frees the display before analysis; cleanup signals again and confirms the exit.
    if (material) spawnSync("pkill", ["-f", escapeRegExp(MATERIAL_PROFILE)]);

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
    note(`countdown sound: ${timeline.sound === undefined ? "not logged (a build before plan 046)" : timeline.sound ? "on" : "off"}`);
    if (countdownSound && timeline.sound !== true) guards.push("--countdown-sound was given but the session did not tick");
    let ticks: TickCheck | undefined;
    if (openMaterial) {
      const markers = syncMarkers(file, result.measurement.durationSeconds);
      const expected = Math.floor(seconds / 2);
      note(`markers: ${markers.flashes.length} flashes, ${markers.beeps.length} beeps in ${seconds} s`);
      if (markers.flashes.length < expected) guards.push(`material not visible in the recording (${markers.flashes.length} flashes; the kiosk did not cover the recorded display)`);
      if (markers.beeps.length < expected) guards.push(`beeps not separable from silence (${markers.beeps.length} found): other audio was playing or output is muted; audio evidence is contaminated`);
      if (timeline.sound) {
        // A tick would add an onset in the first 500 ms that no flash accompanies.
        const unpaired = markers.beeps.filter((beep) => beep < 0.5 && !markers.flashes.some((flash) => Math.abs(beep - flash) < 0.25));
        if (unpaired.length) guards.push(`a beep onset at ${unpaired.map((t) => `${(t * 1000).toFixed(0)} ms`).join(", ")} has no flash: the tick may be in the recording`);
      }
    }
    if (timeline.sound) {
      try {
        ticks = tickCheck(file);
        note(`tick check: first ${ticks.windowSeconds * 1000} ms against ${ticks.laterSeconds} s later: ${describeTicks(ticks)} (fails above +${TICK_EXCESS_DB} dB and ${TICK_FLOOR_DBFS} dBFS)`);
        if (!ticks.pass) guards.push(`the countdown tick may be in the first audio: ${describeTicks(ticks)}`);
      } catch (error) { guards.push(`tick check failed: ${String(error)}`); }
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
          ? `Crops of the first 15 frames and of the 15 frames ${crops.laterSeconds} s later: [digit-crops/](digit-crops/). ${crops.judged} frame(s) judged; worst mean luma difference ${crops.worst?.toFixed(2) ?? "n/a"} (threshold ${DIGIT_DIFF_THRESHOLD}; skipped: ${skippedCrops(crops.comparisons, "flash")} flash, ${skippedCrops(crops.comparisons, "missing")} without a later frame)${openMaterial ? "" : "; material not opened, so not judged"}.`
          : timeline.countdown ? "No crops (see guards)." : "Countdown Off: nothing to crop.",
        "",
        "## Countdown sound",
        "",
        timeline.sound === undefined ? "Not logged: the app was built before plan 046."
          : !timeline.sound ? "Off for this session: nothing to check."
          : ticks ? `On. The first ${ticks.windowSeconds * 1000} ms against the same phase ${ticks.laterSeconds} s later: ${describeTicks(ticks)}; ${ticks.pass ? "no tick" : "**possible tick**"} (fails above +${TICK_EXCESS_DB} dB over the later window and ${TICK_FLOOR_DBFS} dBFS).${soundOverride ? " Turned on for this round by `--countdown-sound`." : ""}`
          : "On, but the tick check did not run (see guards).",
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
      await quitBundle(pid, AbortSignal.timeout(15_000));
      note("cleanup: RecordStuff exited; recordings and reports preserved");
    } catch (error) {
      cleanupErrors.push(String(error));
    } finally {
      if (soundOverride?.pending) {
        // Only once the app is gone: a running app would write the round's value back on its next save.
        try {
          const problem = await soundOverride.restore(false);
          if (problem) cleanupErrors.push(`countdown sound NOT restored: ${problem}; quit RecordStuff, then set "countdownSound": false in ${SETTINGS_PATH}`);
          else note("cleanup: countdown sound set back to off in the stored settings");
        } catch (error) { cleanupErrors.push(`countdown sound not restored: ${String(error)}`); }
      }
      // The profile path is a pattern: escaped, a `TMPDIR` with regex characters still matches only itself.
      const materialPattern = MATERIAL_PROFILE ? escapeRegExp(MATERIAL_PROFILE) : undefined;
      if (material && materialPattern) spawnSync("pkill", ["-f", materialPattern]);
      try {
        const signal = AbortSignal.timeout(5000);
        while (materialPattern && (await command("pgrep", ["-f", materialPattern], signal, 1000, [0, 1])).trim()) {
          await delay(100, undefined, { signal });
        }
      } catch (error) { cleanupErrors.push(`material process: ${String(error)}`); }
      const profileProblem = MATERIAL_PROFILE ? await removeMaterialProfile(MATERIAL_PROFILE) : undefined;
      if (profileProblem) cleanupErrors.push(profileProblem);
    }
    desktop.end();
    fs.writeFileSync(path.join(dir, "app-session.log"), evidenceSince(appLog, sessionFrom).filter(Boolean).join("\n") + "\n");
    fs.writeFileSync(path.join(dir, "events.log"), events.join("\n"));
    const report = path.join(dir, "report.md");
    // Incomplete cleanup outranks a lock and an interrupt: the next round must not start over it (round-exit.mts).
    const end = roundExit({ cleanupIncomplete: cleanupErrors.length > 0, interrupted: interruptedBy, locked: Boolean(desktop.lockedAt), failed: Boolean(runError) });
    const label = { pass: "PASS", fail: "FAIL", blocked: "BLOCKED", interrupted: `INTERRUPTED (${interruptedBy})` }[end.outcome];
    if (!fs.existsSync(report)) fs.writeFileSync(report, "# Global shortcut acceptance\n");
    fs.appendFileSync(report, `\n\n## Final result (including cleanup)\n\nInput context: [input-diagnostics.json](input-diagnostics.json). Run events: [events.log](events.log). App callbacks: [app-session.log](app-session.log).\n\n${label}\n\n${desktop.summary}\n\n${runError ? `Run: ${String(runError)}\n` : ""}Cleanup: ${cleanupErrors.length ? cleanupErrors.join("; ") : "complete; RecordStuff exited"}\n`);
    if (end.outcome === "blocked") {
      console.error(`✗ ${desktop.summary}`);
      process.exit(end.code);
    }
    if (end.outcome === "interrupted") {
      console.error(`✗ ${label}: the recording was settled and RecordStuff exited; nothing was left running`);
      process.exit(end.code);
    }
    if (end.outcome === "fail") fail([runError && String(runError), ...cleanupErrors].filter(Boolean).join("; "));
  }
  console.log("✅ shortcut acceptance and cleanup passed");
}

main().catch((error: unknown) => {
  if (error instanceof AcceptanceFailure) console.error(`✗ ${error.message}`);
  else console.error(error);
  process.exit(1);
});
