/**
 * Countdown evidence for `pnpm acceptance` (plan 040): the start timeline the
 * app logs between the key press and the first chunk, where the digit sat in
 * the recorded frames, and whether any of the first frames still show it.
 * With the countdown sound (plan 046) it also checks that the recording's
 * first audio carries no tick. Development only, never shipped.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { COUNTDOWN_TICK, tickFrequencyHz } from "../../src/shared/countdown.ts";
import { lineTime } from "./acceptance.mts";

export interface Rect { x: number; y: number; width: number; height: number }

export interface CountdownTimeline {
  /** Seconds the session counted down; 0 is Off. */
  countdown?: number;
  /** Whether the session's countdown ticked (plan 046); absent from builds before it. */
  sound?: boolean;
  /** Press → `prepared`: folder probe, temporary file, capture request and checks. */
  preparationMs?: number;
  /** Each `state → countdown (n)` relative to the first. */
  ticks: Array<{ remaining: number; atMs: number }>;
  /** The overlay's window and the display it was placed on, in points. */
  overlay?: { window: Rect; display: Rect };
  dismissal?: { outcome: string; ms?: number };
  /** `record` relative to the countdown's anchor, as the recorder measured it. */
  recordAfterAnchorMs?: number;
  /** `record` sent → `started`, as the recorder measured it. */
  recordToStartedMs?: number;
  /** `state → recording` → first chunk, from log timestamps. */
  startedToFirstChunkMs?: number;
}

/** Lines after the key press, in order; the session is named by its `prepared` line. */
export function countdownTimeline(lines: readonly string[], pressedAt: Date): CountdownTimeline {
  const timeline: CountdownTimeline = { ticks: [] };
  let session: string | undefined;
  let patterns: Record<"dismissal" | "dismissalTimedOut" | "recordSent" | "started" | "firstChunk", RegExp> | undefined;
  let firstTick: number | undefined;
  let recordingAt: number | undefined;
  for (const line of lines) {
    const at = lineTime(line)?.getTime();
    let m: RegExpExecArray | null;
    if ((m = /recorder: session (\S+) prepared after \d+ ms; countdown (\d+) s(?:; sound (on|off))?/.exec(line)) && !session) {
      session = m[1];
      // One compile per session, not five per line; the id is escaped since it is data.
      const own = `recorder: session ${session!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `;
      patterns = {
        dismissal: new RegExp(`${own}countdown overlay (dismissed|error) after (\\d+) ms`),
        dismissalTimedOut: new RegExp(`${own}countdown overlay did not confirm dismissal`),
        recordSent: new RegExp(`${own}record sent (\\d+) ms after`),
        started: new RegExp(`${own}started (\\d+) ms after record`),
        firstChunk: new RegExp(`${own}first chunk`),
      };
      timeline.countdown = Number(m[2]);
      if (m[3]) timeline.sound = m[3] === "on";
      if (at !== undefined) timeline.preparationMs = at - pressedAt.getTime();
    } else if ((m = /state → countdown \((\d+)\)/.exec(line)) && at !== undefined) {
      firstTick ??= at;
      timeline.ticks.push({ remaining: Number(m[1]), atMs: at - firstTick });
    } else if ((m = /countdown overlay: display \S+ at (-?\d+),(-?\d+) (\d+)x(\d+) in display bounds (-?\d+),(-?\d+) (\d+)x(\d+)/.exec(line))) {
      const [x, y, width, height, dx, dy, dw, dh] = m.slice(1).map(Number) as [number, number, number, number, number, number, number, number];
      timeline.overlay = { window: { x, y, width, height }, display: { x: dx, y: dy, width: dw, height: dh } };
    } else if (patterns && (m = patterns.dismissal.exec(line))) {
      timeline.dismissal = { outcome: m[1]!, ms: Number(m[2]) };
    } else if (patterns && patterns.dismissalTimedOut.test(line)) {
      timeline.dismissal = { outcome: "timed out" };
    } else if (patterns && (m = patterns.recordSent.exec(line))) {
      timeline.recordAfterAnchorMs = Number(m[1]);
    } else if (patterns && (m = patterns.started.exec(line))) {
      timeline.recordToStartedMs = Number(m[1]);
    } else if (/\] state → recording/.test(line) && at !== undefined) {
      recordingAt ??= at;
    } else if (patterns && patterns.firstChunk.test(line) && at !== undefined && recordingAt !== undefined) {
      timeline.startedToFirstChunkMs ??= at - recordingAt;
    }
  }
  return timeline;
}

/** The overlay's rectangle in the recorded frames, scaled from display points and kept inside the frame. */
export function digitRegion(overlay: NonNullable<CountdownTimeline["overlay"]>, video: { width: number; height: number }): Rect {
  const scale = video.width / overlay.display.width;
  const x = Math.max(0, Math.floor((overlay.window.x - overlay.display.x) * scale));
  const y = Math.max(0, Math.floor((overlay.window.y - overlay.display.y) * scale));
  const width = Math.min(video.width - x, Math.ceil(overlay.window.width * scale));
  const height = Math.min(video.height - y, Math.ceil(overlay.window.height * scale));
  // Even sizes keep every pixel format's crop exact.
  return { x: x - (x % 2), y: y - (y % 2), width: width - (width % 2), height: height - (height % 2) };
}

/** Mean absolute luma difference that still counts as the same static region (8-bit levels). */
export const DIGIT_DIFF_THRESHOLD = 3;
/** Crops brighter than this on average are the material's flash; a white digit cannot show on it. */
export const FLASH_MEAN = 96;

export interface CropComparison {
  frame: number;
  meanDiff?: number;
  skipped?: "flash";
}

function mean(bytes: Uint8Array): number {
  let sum = 0;
  for (const value of bytes) sum += value;
  return bytes.length ? sum / bytes.length : 0;
}

/**
 * Compares each early crop with the crop of the same flash phase later. Only
 * frames dark in both are judged: that is where a 28%-white digit would show.
 */
export function compareCrops(early: readonly Uint8Array[], later: readonly Uint8Array[]): { comparisons: CropComparison[]; judged: number; worst?: number; pass: boolean } {
  const comparisons = early.map((crop, frame): CropComparison => {
    const other = later[frame];
    if (!other || other.length !== crop.length) return { frame, skipped: "flash" };
    if (mean(crop) > FLASH_MEAN || mean(other) > FLASH_MEAN) return { frame, skipped: "flash" };
    let sum = 0;
    for (let i = 0; i < crop.length; i += 1) sum += Math.abs(crop[i]! - other[i]!);
    return { frame, meanDiff: sum / crop.length };
  });
  const judged = comparisons.filter((c) => c.meanDiff !== undefined);
  const worst = judged.length ? Math.max(...judged.map((c) => c.meanDiff!)) : undefined;
  return { comparisons, judged: judged.length, ...(worst === undefined ? {} : { worst }), pass: judged.length > 0 && worst! <= DIGIT_DIFF_THRESHOLD };
}

function ffmpeg(args: string[], encoding: "buffer" | "utf8" = "utf8"): Buffer | string {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { maxBuffer: 256 * 1024 * 1024, ...(encoding === "utf8" ? { encoding } : {}) });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ffmpeg exited ${result.status}: ${String(result.stderr).trim().split("\n").slice(-2).join(" | ")}`);
  return result.stdout;
}

/** Frames from `fromSeconds` after the first frame on, by timestamp: a VFR file's average rate cannot place them. */
function selectFrom(fromSeconds: number): string {
  return fromSeconds === 0 ? "select='1'" : `select='gte(t-start_t\\,${fromSeconds})'`;
}

function grayFrames(file: string, region: Rect, fromSeconds: number, count: number): Uint8Array[] {
  const crop = `crop=${region.width}:${region.height}:${region.x}:${region.y}`;
  const raw = ffmpeg(["-i", file, "-vf", `${selectFrom(fromSeconds)},${crop}`, "-fps_mode", "passthrough", "-frames:v", String(count),
    "-f", "rawvideo", "-pix_fmt", "gray", "-"], "buffer") as Buffer;
  const size = region.width * region.height;
  return Array.from({ length: Math.floor(raw.length / size) }, (_, i) => new Uint8Array(raw.subarray(i * size, (i + 1) * size)));
}

/**
 * Saves PNG crops of the digit region from the first `count` frames and from
 * the frames `laterSeconds` after the first one, and compares them pairwise.
 * The material flashes once per second, so a whole-second offset keeps the
 * phase.
 */
export function digitCrops(file: string, region: Rect, dir: string, count = 15, laterSeconds = 2): ReturnType<typeof compareCrops> & { files: string[]; laterSeconds: number } {
  fs.mkdirSync(dir, { recursive: true });
  const crop = `crop=${region.width}:${region.height}:${region.x}:${region.y}`;
  ffmpeg(["-i", file, "-vf", `${selectFrom(0)},${crop}`, "-fps_mode", "passthrough", "-frames:v", String(count), path.join(dir, "frame-%02d.png")]);
  ffmpeg(["-i", file, "-vf", `${selectFrom(laterSeconds)},${crop}`, "-fps_mode", "passthrough", "-frames:v", String(count), path.join(dir, `later-${laterSeconds}s-%02d.png`)]);
  const result = compareCrops(grayFrames(file, region, 0, count), grayFrames(file, region, laterSeconds, count));
  return { ...result, laterSeconds, files: fs.readdirSync(dir).filter((name) => name.endsWith(".png")).sort() };
}

/** The tick's pitches: every digit's, and the last digit's a fifth higher. */
export const TICK_PITCHES_HZ = [COUNTDOWN_TICK.frequencyHz, tickFrequencyHz(1)] as const;
/** The first audio fails when it rises this far above the same phase later (the material's tone leaks equally into both). */
export const TICK_EXCESS_DB = 6;
/** Below this a difference is noise, not a tick (a leaked tick measures around −30 dBFS at full volume). */
export const TICK_FLOOR_DBFS = -70;
/** Hann-windowed frames short enough for one tick to dominate a frame, overlapping so one is centred on it. */
const FRAME_SECONDS = 0.05;
const HOP_SECONDS = 0.025;

/**
 * The loudest short-frame level at `hz`, in dBFS of an equivalent sine:
 * Goertzel over Hann-windowed frames. The window keeps the material's
 * 660 Hz tone, 137 Hz away, from leaking into the tick's bins.
 */
export function peakToneLevelDb(samples: Float32Array, sampleRate: number, hz: number): number {
  const size = Math.round(FRAME_SECONDS * sampleRate);
  const hop = Math.round(HOP_SECONDS * sampleRate);
  const k = 2 * Math.cos((2 * Math.PI * hz) / sampleRate);
  let peak = 0;
  for (let start = 0; start + size <= samples.length; start += hop) {
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < size; i += 1) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
      const next = samples[start + i]! * w + k * s1 - s2;
      s2 = s1;
      s1 = next;
    }
    // A sine of amplitude A gives |X| = A · size / 4 under a Hann window.
    const amplitude = (4 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2))) / size;
    peak = Math.max(peak, amplitude);
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

export interface TickCheck {
  /** Loudest level per pitch in the first window and in the same phase later, dBFS. */
  levels: Array<{ hz: number; earlyDb: number; laterDb: number }>;
  windowSeconds: number;
  laterSeconds: number;
  pass: boolean;
}

/** Compares the first window with the same phase `laterSeconds` on; the material's tone repeats every second. */
export function compareTickLevels(early: Float32Array, later: Float32Array, sampleRate: number, windowSeconds = 0.5, laterSeconds = 2): TickCheck {
  const levels = TICK_PITCHES_HZ.map((hz) => ({ hz, earlyDb: peakToneLevelDb(early, sampleRate, hz), laterDb: peakToneLevelDb(later, sampleRate, hz) }));
  const tick = levels.some(({ earlyDb, laterDb }) => earlyDb > TICK_FLOOR_DBFS && earlyDb > laterDb + TICK_EXCESS_DB);
  return { levels, windowSeconds, laterSeconds, pass: early.length > 0 && later.length > 0 && !tick };
}

const SAMPLE_RATE = 48000;

function monoSamples(file: string, fromSeconds: number, seconds: number): Float32Array {
  const raw = ffmpeg(["-i", file, "-map", "0:a:0", "-ss", String(fromSeconds), "-t", String(seconds), "-ac", "1", "-ar", String(SAMPLE_RATE),
    "-f", "f32le", "-"], "buffer") as Buffer;
  const copy = new Uint8Array(raw.byteLength - (raw.byteLength % 4));
  copy.set(raw.subarray(0, copy.byteLength));
  return new Float32Array(copy.buffer);
}

/** The recording's first 500 ms against the same phase 2 s later, mixed to mono, at the tick's pitches. */
export function tickCheck(file: string, windowSeconds = 0.5, laterSeconds = 2): TickCheck {
  return compareTickLevels(monoSamples(file, 0, windowSeconds), monoSamples(file, laterSeconds, windowSeconds), SAMPLE_RATE, windowSeconds, laterSeconds);
}
