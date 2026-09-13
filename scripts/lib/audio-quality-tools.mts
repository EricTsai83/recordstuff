import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, fixture, wav, RATE, type AudioReport } from "./audio-quality.mts";
import { parseAutorecordOutcome } from "./verify.mts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

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

/** Uses the actual application capture host and encoder; only terminates children it owns. */
export async function recordAudio(output: string): Promise<string> {
  if (process.platform !== "darwin") throw new Error("Automatic audio capture requires macOS; use fixture/verify elsewhere");
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const available = spawnSync(tool, ["-version"], { stdio: "ignore", timeout: 5000 });
    if (available.error || available.status !== 0) throw new Error(`${tool} is required; install it with brew install ffmpeg`);
  }
  const electron = fs.realpathSync(path.join(ROOT, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"));
  const processes = spawnSync("ps", ["-axo", "command="], { encoding: "utf8" });
  if (processes.error || processes.status !== 0) throw new Error("Cannot check for an existing development app");
  if (processes.stdout.split("\n").some(line => line.startsWith(electron))) {
    throw new Error("Quit this project's development Electron app before running audio capture");
  }
  const build = spawnSync("pnpm", ["build"], { cwd: ROOT, stdio: "inherit", timeout: 60_000 });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error("Application build failed");
  const material = path.join(output, "reference.wav");
  fs.writeFileSync(material, wav(fixture()));
  const env: NodeJS.ProcessEnv = { ...process.env, RECORDSTUFF_AUTORECORD: JSON.stringify({ seconds: 16, quality: { resolutionCap: "1080p" } }) };
  delete env.ELECTRON_RUN_AS_NODE;
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
      fs.writeFileSync(path.join(output, "capture.log"), log);
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
