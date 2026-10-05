import { spawn, spawnSync } from "node:child_process";
import { INTERRUPT_EXIT, electronPattern, pgrepPids, recordStuffPids, startBuild, stopGroup } from "./processes.mts";
import { scrubbedEnv } from "./runner-env.mts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, fixture, wav, RATE, type AudioReport } from "./audio-quality.mts";
import { parseAutorecordOutcome } from "./verify.mts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BUILD_TIMEOUT_MS = 60_000;

/** Decode without resampling or remixing: format faults must not be hidden. Bounded to 60 s. */
export function inspectAudio(file: string): AudioReport {
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels", "-of", "json", file], { encoding: "utf8", timeout: 30_000 });
  if (probe.error) throw probe.error;
  if (probe.status !== 0 || probe.stderr.trim()) throw new Error(`ffprobe failed: ${probe.stderr}`);
  const stream = (JSON.parse(probe.stdout) as { streams: { sample_rate: string; channels: number }[] }).streams[0];
  if (!stream) throw new Error("No audio stream");
  const rate = Number(stream.sample_rate);
  if (rate !== RATE || stream.channels !== 2) return analyze(new Float32Array(), rate, stream.channels);
  const decoded = spawnSync("ffmpeg", ["-v", "error", "-xerror", "-nostdin", "-i", file, "-map", "0:a:0", "-t", "60", "-f", "f32le", "-c:a", "pcm_f32le", "pipe:1"], { maxBuffer: 24 * 1024 * 1024, timeout: 30_000 });
  if (decoded.error) throw decoded.error;
  if (decoded.status !== 0 || decoded.stderr.length) throw new Error(`Audio decode failed: ${decoded.stderr.toString()}`);
  const samples = new Float32Array(decoded.stdout.length / 4);
  for (let i = 0; i < samples.length; i++) samples[i] = decoded.stdout.readFloatLE(i * 4);
  return analyze(samples);
}

/** Built once per process: every `--repeat` run records the same code. */
let built = false;

/** Uses the actual application capture host and encoder; only terminates children it owns. */
export async function recordAudio(output: string): Promise<string> {
  if (process.platform !== "darwin") throw new Error("Automatic audio capture requires macOS; use fixture/verify elsewhere");
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const available = spawnSync(tool, ["-version"], { stdio: "ignore", timeout: 5000 });
    if (available.error || available.status !== 0) throw new Error(`${tool} is required; install it with brew install ffmpeg`);
  }
  const electron = fs.realpathSync(path.join(ROOT, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"));
  // The shared anchored pattern: a sibling executable such as `ElectronX` is not this app, and a failed pgrep throws.
  if (pgrepPids(electronPattern(path.resolve(electron, "../../.."), "main")).length > 0) {
    throw new Error("Quit this project's development Electron app before running audio capture");
  }
  // An installed copy holds the same userData lock, so the development app would exit before recording.
  if (recordStuffPids().length > 0) throw new Error("Quit RecordStuff before running audio capture");
  if (!built) {
    // In a process group of its own: a build past its time, or interrupted, is stopped whole, so no electron-vite or
    // esbuild child keeps writing `out/` after pnpm alone was signalled. The terminal's Ctrl-C does not reach that
    // group, so it is passed on here and the runner exits only once the group is gone.
    const build = startBuild(ROOT, ["pnpm", "build"]);
    let stopping: Promise<void> | undefined;
    const interrupt = (signal: keyof typeof INTERRUPT_EXIT): void => {
      stopping ??= stopGroup(build.child.pid).finally(() => process.exit(INTERRUPT_EXIT[signal]));
    };
    const onInt = (): void => interrupt("SIGINT"), onTerm = (): void => interrupt("SIGTERM");
    process.once("SIGINT", onInt);
    process.once("SIGTERM", onTerm);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const status = await Promise.race([build.done, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), BUILD_TIMEOUT_MS); })])
      .finally(() => { clearTimeout(timer); process.removeListener("SIGINT", onInt); process.removeListener("SIGTERM", onTerm); });
    // pnpm ends first when its group is signalled: an interrupted build is not a failed one, and nothing goes on
    // until the whole group is gone and the runner has exited.
    if (stopping) await stopping;
    if (status === "timeout") {
      await stopGroup(build.child.pid);
      throw new Error(`Application build did not finish within ${BUILD_TIMEOUT_MS / 1000} s; it was stopped`);
    }
    if (status !== 0) throw new Error("Application build failed");
    built = true;
  }
  const material = path.join(output, "reference.wav");
  fs.writeFileSync(material, wav(fixture()));
  const env: NodeJS.ProcessEnv = { ...scrubbedEnv(), RECORDSTUFF_AUTORECORD: JSON.stringify({ seconds: 16, quality: { resolutionCap: "1080p" } }) };
  console.log("Recording 16 seconds; playing diagnostic tones after capture starts. Keep other audio quiet and output volume fixed.");
  return await new Promise<string>((resolve, reject) => {
    const app = spawn(electron, [ROOT], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let player: ReturnType<typeof spawn> | undefined;
    let played = false;
    let log = "";
    let done = false;
    const finish = (error?: Error, file?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (player && player.exitCode === null) player.kill("SIGKILL");
      if (app.exitCode === null) app.kill("SIGKILL");
      // The log is evidence, not the result: a failed write must not leave this promise unsettled.
      try { fs.writeFileSync(path.join(output, "capture.log"), log); }
      catch (cause) { console.error(`capture.log could not be written: ${cause instanceof Error ? cause.message : String(cause)}`); }
      if (error) reject(error); else resolve(file!);
    };
    const timer = setTimeout(() => finish(new Error("Audio capture timed out after 60 seconds")), 60_000);
    app.on("error", error => finish(error));
    app.stderr.on("data", (chunk: Buffer) => { log += chunk.toString(); });
    app.stdout.on("data", (chunk: Buffer) => {
      log += chunk.toString();
      if (!done && !player && log.includes("autorecord: recording, will stop")) {
        player = spawn("afplay", [material], { stdio: "ignore" });
        player.on("error", error => finish(error));
        player.on("close", code => {
          if (code !== 0) finish(new Error(`Test audio playback failed (${code})`));
          else played = true;
        });
      }
    });
    app.on("close", code => {
      const outcome = parseAutorecordOutcome(log);
      if (code !== 0 || !played || !outcome.saved || outcome.failed) {
        finish(new Error(outcome.failed ?? `Recording did not complete (exit ${code}, playback ${played}); see capture.log`));
      } else finish(undefined, outcome.saved);
    });
  });
}
