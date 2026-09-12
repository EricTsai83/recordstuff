#!/usr/bin/env node
/**
 * Development-only measurement for plan 007 §A3: print the actual size,
 * average frame rate, bitrate, sample rate, channels, duration and file size
 * of one or more recordings. Wraps `ffprobe` (brew install ffmpeg); nothing
 * here ships with the app.
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
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(json);
}

function ratio(text) {
  if (!text) return undefined;
  const [num, den] = text.split("/").map(Number);
  return den ? num / den : num;
}

const kbps = (bps) => (bps === undefined || Number.isNaN(bps) ? "未知" : `${Math.round(bps / 1000)} kbps`);
const fixed = (n, digits = 2) => (n === undefined || Number.isNaN(n) ? "未知" : n.toFixed(digits));

let failed = false;
for (const file of files) {
  let info;
  try {
    info = probe(file);
  } catch (cause) {
    failed = true;
    const missing = cause?.code === "ENOENT";
    console.error(`${file}: ${missing ? "找不到 ffprobe，請先 brew install ffmpeg" : String(cause.stderr ?? cause.message ?? cause)}`);
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
  console.log(`  時長          ${fixed(duration, 1)} s`);
  console.log(`  檔案大小      ${(size / 1024 / 1024).toFixed(1)} MB（整體 ${kbps(totalBps)}）`);
  console.log(
    `  影像          ${video ? `${video.codec_name} ${video.width}x${video.height}` : "無"}` +
      `，平均 ${fixed(avgFps, 2)} fps（${frames ?? "未知"} 張，宣告 ${video?.r_frame_rate ?? "未知"}）` +
      `，位元率 ${kbps(videoBps)}${video?.pix_fmt ? `，${video.pix_fmt}` : ""}`,
  );
  console.log(
    `  音訊          ${audio ? `${audio.codec_name} ${audio.sample_rate} Hz，${audio.channels} 聲道（${audio.channel_layout ?? "未知"}）` : "無"}` +
      `，位元率 ${kbps(audioBps)}`,
  );
  if (video?.start_time !== undefined && audio?.start_time !== undefined) {
    const offset = Number(audio.start_time) - Number(video.start_time);
    console.log(`  起始偏移      音訊 − 影像 = ${fixed(offset * 1000, 0)} ms`);
  }
}
process.exit(failed ? 1 : 0);
