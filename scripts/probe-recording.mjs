#!/usr/bin/env node
/**
 * Development-only measurement: prints the duration, file size, video size,
 * average frame rate (counted from the decoded frames), bitrates, audio sample
 * rate and channels, and the audio/video start offset of one or more recordings.
 * Wraps `ffprobe` (brew install ffmpeg); nothing here ships with the app.
 *
 *   pnpm probe -- ~/Movies/RecordStuff/*.mp4
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

// `pnpm probe -- file` forwards the `--` itself (review pass 2, F4).
const files = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--"));
if (files.length === 0) {
  console.error("usage: pnpm probe -- <recording.mp4> [...]");
  process.exit(2);
}

function probe(file) {
  const json = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_format", "-show_streams", "-count_frames", "-of", "json", file],
    // stderr is captured, not passed through, so a failure is printed once, below.
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(json);
}

function ratio(text) {
  if (!text) return undefined;
  const [num, den] = text.split("/").map(Number);
  return den ? num / den : num;
}

const known = (n) => n !== undefined && Number.isFinite(n);
const kbps = (bps) => (known(bps) ? `${Math.round(bps / 1000)} kbps` : "unknown");
/** `n` to `digits` places with its unit, or `unknown` without one. */
const fixed = (n, digits = 2, unit = "") => (known(n) ? `${n.toFixed(digits)}${unit}` : "unknown");
/** One aligned row of the report. */
const row = (label, value) => console.log(`  ${label.padEnd(14)}${value}`);

let failed = false;
for (const file of files) {
  let info;
  try {
    info = probe(file);
  } catch (cause) {
    failed = true;
    const missing = cause?.code === "ENOENT";
    // ffprobe's own message already starts with the file's name.
    const detail = missing ? "ffprobe is missing; install it with brew install ffmpeg" : String(cause.stderr || cause.message || cause).trim();
    console.error(detail.startsWith(file) ? detail : `${file}: ${detail}`);
    if (missing) break;
    continue;
  }
  const video = info.streams.find((s) => s.codec_type === "video");
  const audio = info.streams.find((s) => s.codec_type === "audio");
  const duration = Number(info.format.duration);
  const size = fs.statSync(file).size;
  const frames = video?.nb_read_frames ? Number(video.nb_read_frames) : undefined;
  const avgFps = frames && duration ? frames / duration : ratio(video?.avg_frame_rate);
  const videoBps = video?.bit_rate ? Number(video.bit_rate) : undefined;
  const audioBps = audio?.bit_rate ? Number(audio.bit_rate) : undefined;
  const totalBps = duration ? (size * 8) / duration : undefined;

  console.log(file);
  row("Duration", fixed(duration, 1, " s"));
  row("File size", `${(size / 1024 / 1024).toFixed(1)} MB (total ${kbps(totalBps)})`);
  row("Video", video
    ? `${video.codec_name} ${video.width}x${video.height}, average ${fixed(avgFps, 2, " fps")} (${frames ?? "unknown"} frames, ` +
      `declared ${video.r_frame_rate ?? "unknown"}), bitrate ${kbps(videoBps)}${video.pix_fmt ? `, ${video.pix_fmt}` : ""}`
    : "none");
  row("Audio", audio
    ? `${audio.codec_name} ${audio.sample_rate} Hz, ${audio.channels} channels (${audio.channel_layout ?? "unknown"}), bitrate ${kbps(audioBps)}`
    : "none");
  if (video?.start_time !== undefined && audio?.start_time !== undefined) {
    row("Start offset", `audio − video = ${fixed((Number(audio.start_time) - Number(video.start_time)) * 1000, 0, " ms")}`);
  }
}
process.exit(failed ? 1 : 0);
