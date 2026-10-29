#!/usr/bin/env node
/**
 * `pnpm echo:record -- <new-directory> [--runs 1..5]` (plan 096, step 2): stage B on the Mac's real speakers and
 * microphone, no canceller (docs/system-design/tooling.md#real-speaker-echo-round). macOS only; never shipped. Build and
 * quit the bundle first (`pnpm start:app`, then Quit), set the output to speakers (not headphones) and the input to the
 * microphone under test, and keep the room quiet apart from the reading.
 *
 * The runner saves Editable recordings, the microphone (the system default input: `microphoneDevice` is cleared) on,
 * the camera off, no countdown and the primary display over the user's settings, opens its guided page full screen on
 * the primary display (the only window recorded), launches the bundle and records, each started and stopped by the
 * registered shortcut:
 *
 * 1. **The voice take.** The page counts down and shows sentences for the maintainer to read at their normal level and
 *    distance; nothing plays. Its microphone track is the near voice of every condition, and its level G0's reference.
 *    A reading not 15 dB over the quiet before it is asked for once more, then blocks the round.
 * 2. **The echo takes**, each `--runs` times (3 by default): the far end (English speech or synthesized music, placed by
 *    stage A's script) played by `afplay` at an output volume of 50% and 100%; the music at 50% stepped to 100% at 28 s
 *    (G1c's re-convergence); the music at 50% with the output muted from 3 to 6 s (D2: what the system track holds
 *    then); and the speech with the output muted throughout (no echo, G4). The page asks for quiet meanwhile.
 *
 * Each take's own system and microphone tracks are decoded; the material is found in the system track by
 * cross-correlation and both tracks are cut there (they share the session's clock). Each echo take plus the read voice
 * becomes a condition directory in stage A's format under `conditions/` (`pnpm echo:bench -- analyze` and `baseline`
 * read it), and `summary.json` and `report.md` give G0 per condition (median and worst run), whether the system's sound
 * is captured before or after the output volume, and the muted stretch. Restored afterwards: the settings file byte for
 * byte, the output volume and mute; the app quit and the page closed. Exit 0 when G0 passes, 1 when it fails or cleanup
 * is incomplete, 2 blocked, 130/143 interrupted.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { APP_LOG_PATH, APP_SETTINGS_PATH, runnerArgs, writeAppSettings } from "./lib/runner/runner-env.mts";
import { INTERRUPT_EXIT, command, electronPattern, escapeRegExp, pgrepPids, recordStuffPids, signalPids } from "./lib/runner/processes.mts";
import { confirmedIdle, sessionEnded, waitForLog, waitForRecord, type TerminalRecord } from "./lib/acceptance/acceptance-runtime.mts";
import { acceleratorToKeystroke, createMaterialProfile, currentRunId, keystrokeScript, registeredAccelerator, removeMaterialProfile } from "./lib/acceptance/acceptance.mts";
import { DESKTOP_BLOCKED_EXIT, DesktopBlockedError, beginDesktopRound } from "./lib/runner/desktop-session.mts";
import { LogReader } from "./lib/runner/log-reader.mts";
import { roundExit } from "./lib/runner/round-exit.mts";
import { developmentAppPath } from "./lib/runner/verification-timing.mts";
import { readEditableDescription } from "./lib/acceptance/editor-acceptance.mts";
import { hasTool, probe, requireMediaTimeout } from "./lib/verification/media-tools.mts";
import { RATE, writeWav } from "./lib/audio/echo-dsp.mts";
import { FAR_SENTENCES, FAR_VOICES, SCRIPT_SECONDS, music, place, sayVoice, type VolumeEvent } from "./lib/audio/echo-material.mts";
import { READING_LINES, VOICE_SECONDS, captureStage, composeTake, cut, findOffset, levelDb, mean, medianAndWorst, readVoice, servePage, soundTrackIndexes, type PageState } from "./lib/audio/echo-stage-b.mts";
import { analyzeEcho, GATES } from "./lib/audio/echo-analyze.mts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = developmentAppPath(REPO_ROOT);
const EXECUTABLE = path.join(BUNDLE, "Contents/MacOS/RecordStuff");
const ELECTRON_APP = path.join(REPO_ROOT, "node_modules/electron/dist/Electron.app");
const ELECTRON_APP_REAL = fs.existsSync(ELECTRON_APP) ? fs.realpathSync(ELECTRON_APP) : ELECTRON_APP;
/** How far into a take the material may start: the recording starts, a second passes, then `afplay`. */
const MAX_START_SECONDS = 6;
const READ_SECONDS = 20;
const COUNTDOWN_MS = 5000;

interface EchoTake {
  name: string;
  material: "speech" | "music";
  volume: 50 | 100;
  /** G0's primary condition: the speakers at a fixed volume. */
  primary: boolean;
  step?: { at: number; to: number };
  muted?: { from: number; to: number };
  mutedThroughout?: true;
}
const TAKES: EchoTake[] = [
  { name: "speech-50", material: "speech", volume: 50, primary: true },
  { name: "music-50", material: "music", volume: 50, primary: true },
  { name: "speech-100", material: "speech", volume: 100, primary: true },
  { name: "music-100", material: "music", volume: 100, primary: true },
  { name: "music-50-step-100", material: "music", volume: 50, primary: false, step: { at: 28, to: 100 } },
  { name: "music-50-muted-3-6", material: "music", volume: 50, primary: false, muted: { from: 3, to: 6 } },
  { name: "speech-50-muted", material: "speech", volume: 50, primary: false, mutedThroughout: true },
];

const usage = "usage: pnpm echo:record -- <new-directory> [--runs 1..5] [--speakers-on-jack]";
const argv = runnerArgs();
let runs = 3;
/** The output is named for the headphone jack, but speakers are plugged into it: macOS cannot tell them apart. */
let speakersOnJack = false;
const target = argv[0];
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === "--runs" && /^[1-5]$/.test(argv[i + 1] ?? "")) runs = Number(argv[++i]);
  else if (argv[i] === "--speakers-on-jack") speakersOnJack = true;
  else { console.error(usage); process.exit(2); }
}
if (!target || target.startsWith("--")) { console.error(usage); process.exit(2); }

const controller = new AbortController();
let interruptedBy: keyof typeof INTERRUPT_EXIT | undefined;
for (const name of ["SIGINT", "SIGTERM"] as const) {
  process.on(name, () => { interruptedBy ??= name; controller.abort(new Error(`interrupted by ${name}`)); });
}
const sleep = (ms: number): Promise<void> => delay(ms, undefined, { signal: controller.signal });
const log = new LogReader(APP_LOG_PATH);
const events: string[] = [];
const note = (text: string): void => { events.push(`${new Date().toISOString()} ${text}`); console.log(text); };
class Failure extends Error {}
const fail = (message: string): never => { throw new Failure(message); };
class Blocked extends Error {}
const blocked = (message: string): never => { throw new Blocked(message); };
const running = (): number | undefined => recordStuffPids()[0];
const osascript = (script: string): Promise<string> => command("osascript", ["-e", script], AbortSignal.timeout(10_000));

interface AudioDevice { name: string; transport?: string }
/** The default output and input as System Information names them. */
function defaultDevices(): { output: AudioDevice | undefined; input: AudioDevice | undefined } {
  const result = spawnSync("system_profiler", ["SPAudioDataType", "-json"], { encoding: "utf8", timeout: 20_000 });
  if (result.status !== 0) return { output: undefined, input: undefined };
  type Item = { _name: string; coreaudio_device_transport?: string; coreaudio_default_audio_output_device?: string; coreaudio_default_audio_input_device?: string };
  const items = (JSON.parse(result.stdout) as { SPAudioDataType?: { _items?: Item[] }[] }).SPAudioDataType?.flatMap(group => group._items ?? []) ?? [];
  const device = (item: Item | undefined): AudioDevice | undefined => item && { name: item._name, ...(item.coreaudio_device_transport ? { transport: item.coreaudio_device_transport } : {}) };
  return {
    output: device(items.find(item => item.coreaudio_default_audio_output_device === "spaudio_yes")),
    input: device(items.find(item => item.coreaudio_default_audio_input_device === "spaudio_yes")),
  };
}

/** One sound track of `file` as float PCM, one array per channel. */
function decodeTrack(file: string, index: number, channels: number): Float32Array[] {
  const decoded = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-i", file, "-map", `0:a:${index}`, "-f", "f32le", "-c:a", "pcm_f32le", "-ar", String(RATE), "pipe:1"],
    { maxBuffer: 256 * 1024 * 1024, timeout: 60_000 });
  if (decoded.error) throw decoded.error;
  if (decoded.status !== 0) fail(`could not decode sound track ${index} of ${file}: ${decoded.stderr.toString().trim()}`);
  const frames = Math.floor(decoded.stdout.length / 4 / channels);
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) out[c]![i] = decoded.stdout.readFloatLE((i * channels + c) * 4);
  return out;
}

async function main(): Promise<number> {
  if (process.platform !== "darwin" || !fs.existsSync(EXECUTABLE)) {
    console.error(process.platform !== "darwin" ? "BLOCKED: macOS only" : `BLOCKED: no bundle at ${BUNDLE}: build it with \`pnpm start:app\`, then quit it`);
    return 2;
  }
  if (running() !== undefined || pgrepPids(electronPattern(ELECTRON_APP_REAL, "bundle")).length > 0) {
    console.error("BLOCKED: RecordStuff or this project's Electron.app is running: quit it first; this runner launches the bundle itself");
    return 2;
  }
  requireMediaTimeout();
  if (!hasTool("ffmpeg") || !hasTool("ffprobe")) { console.error("BLOCKED: ffmpeg and ffprobe are needed (brew install ffmpeg)"); return 2; }
  if (spawnSync("open", ["-Ra", "Google Chrome"]).status !== 0) { console.error("BLOCKED: Google Chrome is needed for the guided page"); return 2; }
  if (!fs.existsSync(APP_SETTINGS_PATH)) { console.error(`BLOCKED: no settings at ${APP_SETTINGS_PATH}: launch RecordStuff once first`); return 2; }
  const devices = defaultDevices();
  if (!devices.output || !devices.input) { console.error("BLOCKED: could not read the default audio output and input"); return 2; }
  // Headphones make no echo: the round would measure nothing and stop the plan for the wrong reason.
  if (/headphone|耳機|airpods/i.test(devices.output.name) && !(speakersOnJack && devices.output.transport === "coreaudio_device_type_builtin")) {
    console.error(`BLOCKED: the output is ${devices.output.name}; set it to speakers, or pass --speakers-on-jack when speakers are plugged into the headphone jack`);
    return 2;
  }
  const dir = path.resolve(target!);
  try { fs.mkdirSync(dir); } catch (error) { console.error(`BLOCKED: ${dir} must be a new directory: ${String(error)}`); return 2; }
  for (const sub of ["material", "conditions", "voice"]) fs.mkdirSync(path.join(dir, sub));
  const originalText = fs.readFileSync(APP_SETTINGS_PATH, "utf8");
  const original = JSON.parse(originalText) as Record<string, unknown>;
  fs.writeFileSync(path.join(dir, "settings.before.json"), originalText);
  const originalVolume = (await osascript("output volume of (get volume settings)")).trim();
  const originalMuted = (await osascript("output muted of (get volume settings)")).trim();
  note(`devices: output ${devices.output.name}${speakersOnJack ? " (speakers on the headphone jack, as the operator said)" : ""}, input ${devices.input.name}; output volume ${originalVolume}${originalMuted === "true" ? " (muted)" : ""}`);

  const desktop = await beginDesktopRound().catch((cause: unknown) => {
    if (cause instanceof DesktopBlockedError) { console.error(`BLOCKED: ${cause.message}`); process.exit(DESKTOP_BLOCKED_EXIT); }
    throw cause;
  });
  const cleanup: string[] = [];
  const files: string[] = [];
  let runError: unknown;
  let launchIssued = false;
  /** The page's `open`, the material's player and the recording in progress, for cleanup after any failure. */
  let launcher: ChildProcess | undefined;
  let player: ChildProcess | undefined;
  let active: { stop: () => Promise<void> } | undefined;
  const profile = createMaterialProfile("echo");
  const pagePids = (): number[] => pgrepPids(escapeRegExp(profile));
  const page = await servePage({ phase: "intro", title: "RecordStuff 回音測試", body: "準備中…" });
  const show = (state: PageState): void => page.set(state);
  const rows: { take: string; run: number; echoToVoiceDb: number | null; referenceDb: number; referenceScore: number; file: string; note?: string }[] = [];
  const muted: { run: number; referenceMutedDb: number; referenceAudibleDb: number; micMutedDb: number; micAudibleDb: number }[] = [];
  let voiceLevel: { overQuietDb: number; file: string } | undefined;

  const setVolume = async (volume: number, mute: boolean): Promise<void> => {
    await osascript(`set volume output volume ${volume}`);
    await osascript(`set volume output muted ${mute}`);
  };
  const quitApp = async (): Promise<void> => {
    if (launchIssued && running() === undefined) for (const end = Date.now() + 10_000; running() === undefined && Date.now() < end;) await delay(250);
    if (running() === undefined) return;
    await command("osascript", ["-e", `tell application ${JSON.stringify(BUNDLE)} to quit`], AbortSignal.timeout(15_000));
    for (const end = Date.now() + 30_000; running() !== undefined;) {
      if (Date.now() > end) fail("RecordStuff did not exit within 30 s of Quit");
      await delay(200);
    }
  };

  try {
    // The material, before anything is launched: placed by stage A's script, so the composed takes line up with it.
    const seconds = SCRIPT_SECONDS + 10;
    const speech = sayVoice(FAR_VOICES, FAR_SENTENCES, seconds);
    const tunes = music(seconds, 96);
    const played = {
      speech: [place(speech, ["far", "double"]), place(speech, ["far", "double"])],
      music: [place(tunes[0], ["far", "double"]), place(tunes[1], ["far", "double"])],
    };
    const materialFile = (name: "speech" | "music"): string => path.join(dir, "material", `${name}.wav`);
    for (const name of ["speech", "music"] as const) fs.writeFileSync(materialFile(name), writeWav(played[name]));
    note(`material: ${FAR_VOICES.join(", ")} (say) and synthesized music, ${SCRIPT_SECONDS} s each, in ${path.join(dir, "material")}`);

    // The guided page full screen on the primary display: the only window the recordings show.
    launcher = spawn("open", ["-na", "Google Chrome", "--args", `--user-data-dir=${profile}`, `--app=${page.url}`, "--start-fullscreen", "--kiosk",
      "--window-position=0,0", "--no-first-run", "--no-default-browser-check", "--disable-features=Translate"], { stdio: "ignore" });
    await sleep(5000);
    if (!pagePids().length) blocked("the guided page did not open in Google Chrome");
    fs.writeFileSync(path.join(dir, "page.html"), (await (await fetch(page.url)).text()));

    // The round's settings over the user's: restored byte for byte at the end.
    const { microphoneDevice: _device, ...rest } = original;
    writeAppSettings({ ...rest, editableRecording: true, microphone: true, camera: false, countdown: 0, display: { kind: "primary" } });
    note("settings: Editable recordings, the microphone (system default input) on, the camera off, no countdown, the primary display");

    const from = log.end();
    launchIssued = true;
    await command("open", ["-a", BUNDLE], AbortSignal.timeout(15_000));
    const launchSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
    const start = await waitForLog(log, from, /\] start: /, "`start:`", launchSignal, 60_000);
    let lines: string[] = [];
    for (;;) {
      lines = [start.line, ...log.since(start.at).lines.map((line) => line.text)];
      if (confirmedIdle(lines) && registeredAccelerator(lines)) break;
      if (launchSignal.aborted && !controller.signal.aborted) fail("RecordStuff did not reach idle with its shortcut registered within 60 s");
      await sleep(200);
    }
    launchIssued = false;
    const run = currentRunId(lines) ?? fail("the start line has no run id");
    const shortcut = keystrokeScript(acceleratorToKeystroke(registeredAccelerator(lines)!) ?? fail("cannot type the recording shortcut"));
    note(`RecordStuff run ${run}`);

    /** One editable recording; `during` runs while it records. Returns its file and when, after the start, `during` began. */
    const record = async (during: () => Promise<void>): Promise<{ file: string; duringAt: number }> => {
      const pressFrom = log.end();
      await osascript(shortcut);
      const capture = await waitForRecord(log, pressFrom, (r): r is Extract<typeof r, { kind: "capture" }> => r.kind === "capture" && r.run === run, "the capture record", controller.signal);
      const started = Date.now();
      const session = capture.record.session;
      const ended = (): TerminalRecord | undefined => sessionEnded(log.since(capture.next).lines.map((line) => line.text), run, session);
      const settle = (signal: AbortSignal) => waitForRecord(log, capture.next, (r): r is TerminalRecord => (r.kind === "saved" || r.kind === "failed") && r.run === run && r.session === session,
        "the save", signal, 60_000);
      // Cleanup stops it once, unless it already ended: a shortcut to an idle app would start another recording.
      active = { stop: async () => { if (!ended()) { await osascript(shortcut); await settle(AbortSignal.timeout(60_000)); } } };
      await sleep(1000);
      const duringAt = (Date.now() - started) / 1000;
      await during();
      await sleep(1500);
      const early = ended();
      if (early) {
        active = undefined;
        fail(`the recording ended before its stop: ${early.kind === "failed" ? `${early.code} ${early.detail}` : `saved early (${early.path})`}`);
      }
      active = undefined;
      await osascript(shortcut);
      const terminal = await settle(controller.signal);
      if (terminal.record.kind === "failed") fail(`a recording failed: ${terminal.record.code} ${terminal.record.detail}`);
      const file = terminal.record.kind === "saved" ? terminal.record.path : fail("no saved file");
      files.push(file);
      return { file, duringAt };
    };
    /** The take's own system and microphone tracks. */
    const tracks = (file: string): { system: Float32Array[]; microphone: Float32Array } => {
      const description = readEditableDescription(fs.readFileSync(file)) ?? fail(`${file} is not an editable recording`);
      const sounds = probe(file).info.streams.filter((s) => s.codec_type === "audio");
      const index = soundTrackIndexes(description, sounds.length) ?? fail(`${file} does not hold the system's sound and the microphone apart (${description.sounds.join(", ")})`);
      return { system: decodeTrack(file, index.system, sounds[index.system]!.channels ?? 2), microphone: mean(decodeTrack(file, index.microphone, sounds[index.microphone]!.channels ?? 1)) };
    };

    // 1. The voice take, read by the maintainer; once more if nothing was heard.
    let voice: Float32Array | undefined;
    for (let attempt = 1; attempt <= 2 && !voice; attempt++) {
      show({ phase: "intro", title: attempt === 1 ? "請準備朗讀" : "沒有收到聲音，請再念一次",
        body: "倒數結束後，請用平常說話的音量、平常坐在 Mac 前的距離，念出畫面上的文字。念完前不必停；念完了就安靜等待。" });
      await sleep(8000);
      const take = await record(async () => {
        show({ phase: "countdown", title: "準備開始", remainingMs: COUNTDOWN_MS, lines: [...READING_LINES] });
        await sleep(COUNTDOWN_MS);
        show({ phase: "read", title: "請念", remainingMs: READ_SECONDS * 1000, totalMs: READ_SECONDS * 1000, lines: [...READING_LINES] });
        await sleep(READ_SECONDS * 1000);
        show({ phase: "quiet", title: "謝謝", body: "請保持安靜。", progress: "" });
      });
      // The file's clock starts with the capture record (within a few hundred ms): the reading from there, half a second in.
      const startSeconds = take.duringAt + COUNTDOWN_MS / 1000 + 0.5;
      const read = readVoice(tracks(take.file).microphone, startSeconds, VOICE_SECONDS);
      if ("problem" in read) note(`voice take ${attempt}: ${read.problem}`);
      else {
        voice = read.voice;
        voiceLevel = { overQuietDb: read.overQuietDb, file: take.file };
        fs.writeFileSync(path.join(dir, "voice", "voice.wav"), writeWav([voice]));
        note(`voice take ${attempt}: ${read.overQuietDb.toFixed(1)} dB over the quiet before it (${take.file})`);
      }
    }
    if (!voice) blocked("no reading was heard twice: check the input device and its permission, then run again");

    // 2. The echo takes.
    const total = TAKES.length * runs;
    for (let r = 1; r <= runs; r++) {
      for (const [index, take] of TAKES.entries()) {
        const k = (r - 1) * TAKES.length + index + 1;
        show({ phase: "quiet", title: "正在錄製回音", body: "請保持安靜，不要說話或發出聲音。", progress: `${k} / ${total}：${take.name}` });
        await setVolume(take.volume, Boolean(take.mutedThroughout));
        const timeline: VolumeEvent[] = [];
        let playedAt = 0;
        const recorded = await record(async () => {
          const playing = spawn("afplay", [materialFile(take.material)], { stdio: "ignore" });
          player = playing;
          playedAt = Date.now();
          // Each scheduled change is observed at once: an interrupt rejects its timer while the material still plays.
          const timers: Promise<void>[] = [];
          const problems: unknown[] = [];
          const at = (seconds: number, action: () => Promise<void>): void => {
            timers.push(sleep(Math.max(0, seconds * 1000 - (Date.now() - playedAt))).then(action).catch((error: unknown) => { problems.push(error); }));
          };
          if (take.step) at(take.step.at, async () => { await osascript(`set volume output volume ${take.step!.to}`); timeline.push({ kind: "volume", at: (Date.now() - playedAt) / 1000, gainDb: 0 }); });
          if (take.muted) {
            at(take.muted.from, () => osascript("set volume output muted true").then(() => undefined));
            at(take.muted.to, () => osascript("set volume output muted false").then(() => undefined));
          }
          const code = await new Promise<number | null>((resolve, reject) => {
            playing.once("exit", resolve);
            playing.once("error", reject);
            controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
          });
          await Promise.all(timers);
          player = undefined;
          if (problems.length) throw problems[0];
          if (code !== 0) fail(`afplay ended with ${code}`);
        });
        await setVolume(take.volume, false);
        const { system, microphone } = tracks(recorded.file);
        const reference = mean(played[take.material]);
        const found = findOffset(mean(system), reference, MAX_START_SECONDS * RATE);
        // A muted output may leave the system track silent: the take is then placed by the runner's own timing.
        const offset = found.score >= 0.5 ? found.lag : Math.round(recorded.duringAt * RATE);
        const placedBy = found.score >= 0.5 ? `the system track (correlation ${found.score.toFixed(3)})` : `timing (system track correlation ${found.score.toFixed(3)})`;
        const length = Math.round(SCRIPT_SECONDS * RATE);
        const [echoMic] = cut([microphone], offset, length) as [Float32Array];
        const systemCut = cut(system, offset, length);
        if (take.step) {
          // The step's size as the microphone heard it, a few seconds either side.
          for (const event of timeline) event.gainDb = levelDb(echoMic, event.at + 0.5, event.at + 4.5) - levelDb(echoMic, event.at - 3, event.at - 0.5);
        }
        const composed = composeTake(echoMic, systemCut, voice!, timeline);
        const name = `${take.name}-run-${r}`;
        const conditionDir = path.join(dir, "conditions", name);
        fs.mkdirSync(conditionDir);
        fs.writeFileSync(path.join(conditionDir, "mic.wav"), writeWav([composed.mic]));
        fs.writeFileSync(path.join(conditionDir, "reference.wav"), writeWav(composed.reference));
        fs.writeFileSync(path.join(conditionDir, "ideal.wav"), writeWav([composed.ideal]));
        fs.writeFileSync(path.join(conditionDir, "echo.wav"), writeWav([composed.echo]));
        fs.writeFileSync(path.join(conditionDir, "take.json"), `${JSON.stringify({ condition: { ...take, name }, run: r, recording: recorded.file, placedBy, offsetSamples: offset,
          script: composed.script, events: composed.events, devices, voice: voiceLevel }, null, 2)}\n`);
        const report = analyzeEcho({ input: composed.mic, output: composed.mic, ideal: composed.ideal, script: composed.script, events: composed.events });
        const referenceDb = levelDb(mean(systemCut), 1.5, 8.5);
        rows.push({ take: take.name, run: r, echoToVoiceDb: report.raw.echoToVoiceDb, referenceDb, referenceScore: found.score, file: recorded.file, ...(found.score < 0.5 ? { note: placedBy } : {}) });
        if (take.muted) {
          muted.push({ run: r, referenceMutedDb: levelDb(mean(systemCut), 3.3, 5.7), referenceAudibleDb: levelDb(mean(systemCut), 1.5, 2.8),
            micMutedDb: levelDb(echoMic, 3.3, 5.7), micAudibleDb: levelDb(echoMic, 1.5, 2.8) });
        }
        note(`${k}/${total} ${name}: echo/voice ${report.raw.echoToVoiceDb?.toFixed(1) ?? "n/a"} dB, reference ${referenceDb.toFixed(1)} dB; placed by ${placedBy}`);
      }
    }
    fs.writeFileSync(path.join(dir, "conditions", "material.json"), `${JSON.stringify({ conditions: rows.map(row => `${row.take}-run-${row.run}`), devices }, null, 2)}\n`);
    show({ phase: "done", title: "完成", body: "錄音結束，可以說話了。" });
  } catch (error) {
    runError = error;
  } finally {
    if (player && player.exitCode === null && player.signalCode === null) {
      player.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => player!.once("exit", resolve)), delay(5000)]);
      if (player.exitCode === null && player.signalCode === null) cleanup.push("afplay did not exit");
    }
    if (active) {
      try { await active.stop(); } catch (error) { cleanup.push(`could not stop the recording in progress: ${String(error)}`); }
    }
    try { await setVolume(Number(originalVolume), originalMuted === "true"); } catch (error) { cleanup.push(`could not restore the output volume ${originalVolume}: ${String(error)}`); }
    try { await quitApp(); } catch (error) { cleanup.push(String(error)); }
    try {
      if (running() === undefined) fs.writeFileSync(APP_SETTINGS_PATH, originalText);
      else cleanup.push(`RecordStuff is still running: settings NOT restored; copy them back from ${path.join(dir, "settings.before.json")}`);
    } catch (error) { cleanup.push(`could not restore the settings: ${String(error)}`); }
    // A launch still on its way could open the page after it was closed: wait for it first.
    const opening = launcher;
    if (opening && opening.exitCode === null && opening.signalCode === null) await Promise.race([new Promise((resolve) => opening.once("exit", resolve)), delay(10_000)]);
    if (opening && opening.exitCode === null && opening.signalCode === null) cleanup.push("the guided page's launch did not finish");
    for (let attempt = 0; attempt < 40 && pagePids().length > 0; attempt++) { signalPids(pagePids(), "SIGTERM"); await delay(250); }
    if (pagePids().length > 0) cleanup.push(`could not close the guided page (private profile ${profile})`);
    else {
      const problem = await removeMaterialProfile(profile);
      if (problem) cleanup.push(problem);
    }
    await page.close().catch((error: unknown) => cleanup.push(`could not stop the page's server: ${String(error)}`));
    desktop.end();
  }

  // G0 per primary condition: the median run must have the echo within 30 dB of the voice. The problem is real when
  // any primary output volume meets it; the maintainer confirms a stop either way.
  // A completed take whose echo never rose 10 dB over the microphone's floor has none to measure: below any threshold
  // (-Infinity, reported as "below the floor"), never a missing measurement.
  const byTake = TAKES.map(take => {
    const taken = rows.filter(row => row.take === take.name);
    return { take: take.name, primary: take.primary, runs: taken.length, belowFloor: taken.filter(row => row.echoToVoiceDb === null).length,
      ...medianAndWorst(taken.map(row => row.echoToVoiceDb ?? -Infinity)) };
  });
  const primary = byTake.filter(row => row.primary && row.median !== null);
  const g0 = primary.length ? primary.some(row => row.median! >= GATES.g0EchoToVoiceDb) : null;
  // Only references that are the material (correlation 0.5 or more): a silent system track says nothing about the stage.
  const reference = (name: string): number[] => rows.filter(row => row.take === name && row.referenceScore >= 0.5).map(row => row.referenceDb);
  const stage = (low: string, high: string): string | null => {
    const a = medianAndWorst(reference(low)).median, b = medianAndWorst(reference(high)).median;
    return a === null || b === null ? "unavailable: no system track matching the material at one of the volumes" : `${captureStage(a, b)} (${a.toFixed(1)} dB at 50%, ${b.toFixed(1)} dB at 100%)`;
  };
  const capture = { speech: stage("speech-50", "speech-100"), music: stage("music-50", "music-100") };
  const cleanupIncomplete = cleanup.length > 0;
  const prerequisite = runError instanceof Blocked;
  const { outcome, code } = roundExit({ cleanupIncomplete, interrupted: interruptedBy, locked: desktop.lockedAt !== undefined,
    failed: (Boolean(runError) && !prerequisite) || g0 === false, blocked: prerequisite || g0 === null });
  const result = cleanupIncomplete ? "INCOMPLETE CLEANUP" : outcome.toUpperCase();
  const summary = { result, g0: { threshold: GATES.g0EchoToVoiceDb, pass: g0, byTake }, capture, muted, voice: voiceLevel ?? null, devices,
    outputVolume: { before: originalVolume, muted: originalMuted }, runs, rows, files, cleanup, events, error: runError ? String(runError) : null,
    environment: { platform: process.platform, release: os.release(), node: process.version } };
  fs.writeFileSync(path.join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  const f = (value: number | null): string => value === null ? "n/a" : value === -Infinity ? "below the floor" : value.toFixed(1);
  fs.writeFileSync(path.join(dir, "report.md"), [
    "# Real-speaker echo round (`pnpm echo:record`, plan 096 step 2)", "",
    `Result: **${result}**.${runError ? ` Stopped by: ${runError instanceof Error ? runError.message : String(runError)}.` : ""}`, "",
    `Devices: output ${devices.output.name}, input ${devices.input.name}. Runs: ${runs}. Voice: ${voiceLevel ? `${voiceLevel.overQuietDb.toFixed(1)} dB over the quiet before it` : "none"}.`, "",
    `G0 (the echo within ${-GATES.g0EchoToVoiceDb} dB of the voice, the median run of a primary condition): **${g0 === null ? "not measured" : g0 ? "pass" : "fail"}**.`, "",
    "| Take | Primary | Runs | Echo below the floor | Echo/voice median (dB) | Worst run (dB) |", "| --- | --- | --- | --- | --- | --- |",
    ...byTake.map(row => `| ${row.take} | ${row.primary ? "yes" : "no"} | ${row.runs} | ${row.belowFloor} | ${f(row.median)} | ${f(row.worst)} |`), "",
    `System sound captured: speech ${capture.speech ?? "n/a"}; music ${capture.music ?? "n/a"}.`, "",
    "Output muted from 3 to 6 s (D2): " + (muted.length ? muted.map(m => `run ${m.run}: reference ${f(m.referenceMutedDb)} dB muted against ${f(m.referenceAudibleDb)} dB audible; microphone ${f(m.micMutedDb)} against ${f(m.micAudibleDb)} dB`).join("; ") : "not measured") + ".", "",
    "## Cleanup", "", cleanupIncomplete ? cleanup.map(line => `- ${line}`).join("\n") : "Complete: RecordStuff exited, the guided page closed, the output volume and the settings file were restored. The recordings stay in the output folder.", "",
    "## Desktop", "", desktop.summary, "",
    "## Events", "", ...events.map(line => `- ${line}`), "",
  ].join("\n"));
  console.log(`Report ${path.join(dir, "report.md")}`);
  console.log(result);
  return code;
}

main().then((code) => process.exit(code), (error: unknown) => {
  console.error(error);
  process.exit(1);
});
