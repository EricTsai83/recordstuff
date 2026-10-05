/**
 * Where the verification toolkit runs external programs: ffprobe for
 * container / stream facts and frame timestamps, ffmpeg for per-channel
 * loudness and the flash / beep sync markers of `scripts/test-material.html`.
 * Both come from `brew install ffmpeg`. The countdown evidence decodes raw
 * frames itself, bounded by the same `mediaTimeout`. Development only, never shipped.
 */
import { spawnSync } from "node:child_process";
import {
  parseBlackdetect,
  parseChannelRms,
  parseFrameTimes,
  parseSilencedetect,
  type ProbeInfo,
} from "./verify.mts";

const MAX_BUFFER = 256 * 1024 * 1024;

export class ToolMissingError extends Error {
  constructor(tool: string) {
    super(`${tool} is missing; install it with brew install ffmpeg`);
    this.name = "ToolMissingError";
  }
}

/**
 * A tool ran but did not produce a valid measurement: it exited nonzero or was
 * killed, or its output is incomplete. Parseable output from such a run is
 * never used (plan 030); the message keeps the end of stderr for diagnosis.
 */
export class MeasurementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeasurementError";
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

export interface ToolTiming { tool: string; seconds: number }

/** Set only inside `timeTools`; every run is synchronous, so two collections never interleave. */
let timings: ToolTiming[] | undefined;

/** Runs `measure` and appends how long each labelled tool run inside it took, even when it throws (plan 042). */
export function timeTools<T>(into: ToolTiming[], measure: () => T): T {
  const outer = timings;
  timings = into;
  try {
    return measure();
  } finally {
    timings = outer;
  }
}

/** How long one tool run may take before it is killed: `RECORDSTUFF_MEDIA_TIMEOUT_MS`, 15 minutes by default. */
export function mediaTimeout(): number {
  const timeout = Number(process.env["RECORDSTUFF_MEDIA_TIMEOUT_MS"] ?? 900_000);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new MeasurementError("RECORDSTUFF_MEDIA_TIMEOUT_MS must be a positive integer");
  return timeout;
}

/**
 * A runner's preflight, before it launches or records anything: a malformed `RECORDSTUFF_MEDIA_TIMEOUT_MS` is a usage
 * error (exit 2) said in one line, not a stack trace from the first tool run or a file reported as failed.
 */
export function requireMediaTimeout(): void {
  try { mediaTimeout(); } catch (cause) {
    console.error(`${cause instanceof Error ? cause.message : String(cause)}; nothing was run.`);
    process.exit(2);
  }
}

function run(tool: string, args: string[], label?: string): RunResult {
  const timeout = mediaTimeout();
  const started = performance.now();
  try {
    const result = spawnSync(tool, args, { encoding: "utf8", maxBuffer: MAX_BUFFER, timeout, killSignal: "SIGKILL" });
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") throw new ToolMissingError(tool);
    if (result.error) throw new MeasurementError(`${tool}: ${result.error.message}`);
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  } finally {
    if (label) timings?.push({ tool: label, seconds: (performance.now() - started) / 1000 });
  }
}

/** The last few stderr lines, enough to see why a run failed without the whole log. */
function stderrTail(stderr: string): string {
  const tail = stderr.trim().split(/\r?\n/).slice(-3).join(" | ");
  return tail ? `: ${tail}` : "";
}

/** Only a run that exited 0 is a measurement. */
function completed(what: string, result: RunResult): RunResult {
  if (result.status === 0) return result;
  const ending = result.status === null ? "was terminated by a signal" : `exited ${result.status}`;
  throw new MeasurementError(`${what} ${ending}${stderrTail(result.stderr)}`);
}

export function hasTool(tool: string): boolean {
  // Outside the try: a bad RECORDSTUFF_MEDIA_TIMEOUT_MS is a usage error, not a missing tool.
  mediaTimeout();
  try {
    return run(tool, ["-version"]).status === 0;
  } catch {
    return false;
  }
}

function parseProbe(stdout: string, stderr: string): ProbeInfo {
  let info: ProbeInfo;
  try {
    info = JSON.parse(stdout) as ProbeInfo;
  } catch {
    throw new MeasurementError(`ffprobe printed malformed JSON${stderrTail(stderr)}`);
  }
  if (!Array.isArray(info.streams) || typeof info.format !== "object" || info.format === null) {
    throw new MeasurementError("ffprobe output has no format or stream list");
  }
  return info;
}

/** Streams, format and a full decode (`-count_frames`); stderr holds decode errors, if any. */
export function probe(file: string): { info: ProbeInfo; decodeErrors: string } {
  const { stdout, stderr } = completed("ffprobe", run("ffprobe", [
    "-v", "error", "-show_format", "-show_streams", "-count_frames", "-of", "json", file,
  ], "ffprobe"));
  return { info: parseProbe(stdout, stderr), decodeErrors: stderr };
}

/**
 * Streams and format without decoding every frame, then ffprobe decodes only
 * the first and last `edgeSeconds`: a missing track, a wrong duration or a
 * damaged tail shows up in well under a second, where a full decode of a 2 GB
 * file takes over a minute. ffprobe, not `ffmpeg -f null`: the null muxer
 * reports repeated timestamps of static screen content as errors although
 * every frame decodes. `nb_read_frames` is absent; each video and audio
 * track is decoded on its own, so audio still playing cannot hide a video
 * track that ended early; a window where a track decodes no frame counts as
 * an error; decode errors are joined.
 */
export function probeEdges(file: string, edgeSeconds = 1): { info: ProbeInfo; decodeErrors: string } {
  const { stdout, stderr } = completed("ffprobe", run("ffprobe", [
    "-v", "error", "-show_format", "-show_streams", "-of", "json", file,
  ], "ffprobe"));
  const info = parseProbe(stdout, stderr);
  const duration = Number(info.format.duration);
  if (!Number.isFinite(duration)) throw new MeasurementError("ffprobe reported no duration, so the last second cannot be located");
  const tracks = (["video", "audio"] as const).filter((type) => info.streams.some((stream) => stream.codec_type === type));
  // `-read_intervals` starts at the keyframe before the window, so frames before `from` say nothing about it.
  const decode = (what: string, from: number | undefined, type: "video" | "audio"): string => {
    const label = `${what} (${type})`;
    const window = completed(`ffprobe ${label} decode`, run("ffprobe", [
      "-v", "error", "-select_streams", `${type[0]}:0`, "-read_intervals", from === undefined ? `%+${edgeSeconds}` : `${from}%`,
      "-show_entries", "frame=pts_time", "-of", "csv=p=0", file,
    ], "ffprobe edges"));
    const decoded = parseFrameTimes(window.stdout).some((time) => from === undefined || time >= from);
    return decoded ? window.stderr : `${window.stderr}\n${label}: no frame decoded`;
  };
  const tailFrom = Math.max(0, duration - edgeSeconds);
  const edges = tracks.flatMap((type) => [decode("first second", undefined, type), decode("last second", tailFrom, type)]);
  return { info, decodeErrors: [stderr, ...edges].map((text) => text.trim()).filter(Boolean).join("\n") };
}

/**
 * Video presentation timestamps. A file longer than `2 × edgeSeconds` is
 * sampled at its head and tail only and returns two lists.
 */
export function frameTimes(file: string, durationSeconds: number | undefined, edgeSeconds = 60): number[][] {
  const read = (interval?: string): number[] => {
    const args = ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0"];
    if (interval) args.push("-read_intervals", interval);
    args.push(file);
    return parseFrameTimes(completed("ffprobe frames", run("ffprobe", args, "ffprobe frames")).stdout);
  };
  if (durationSeconds === undefined || durationSeconds <= edgeSeconds * 2) return [read()];
  return [read(`%+${edgeSeconds}`), read(`${(durationSeconds - edgeSeconds).toFixed(3)}%`)];
}

/**
 * RMS level per channel in dBFS, from `astats`. Complete only when ffmpeg
 * exited 0 and reported every channel of the stream (`channels`, from
 * ffprobe); anything less is a MeasurementError, not a silent channel.
 */
export function channelRms(file: string, channels: number | undefined): number[] {
  const { stderr } = completed("ffmpeg astats", run("ffmpeg", [
    "-hide_banner", "-nostats", "-vn", "-i", file,
    "-af", "astats=measure_perchannel=RMS_level:measure_overall=none",
    "-f", "null", "-",
  ], "ffmpeg astats"));
  const levels = parseChannelRms(stderr);
  if (levels.length === 0 || (channels !== undefined && levels.length !== channels)) {
    throw new MeasurementError(`ffmpeg astats reported ${levels.length} of ${channels ?? "an unknown number of"} channels${stderrTail(stderr)}`);
  }
  return levels;
}

/**
 * Sync markers of the test material page: the top-right box is black except
 * for a 100 ms white flash each second, and a short beep plays on the same
 * clock. `blackdetect` on that crop gives the flash starts (black_end),
 * `silencedetect` gives the beep starts (silence_end). The page sizes the box
 * in `vmin`, so the crop is expressed in fractions of the frame's shorter side:
 * it lands inside the box at any resolution, a portrait display's included
 * (sized by the height, it missed the box there and found no flash).
 */
export const SYNC_MARKER_CROP = "crop=min(iw\\,ih)*0.08:min(iw\\,ih)*0.08:iw-min(iw\\,ih)*0.115:min(iw\\,ih)*0.035";
export function syncMarkers(file: string, durationSeconds: number | undefined): { flashes: number[]; beeps: number[] } {
  const video = completed("ffmpeg blackdetect", run("ffmpeg", [
    "-hide_banner", "-nostats", "-an", "-i", file,
    "-vf", `${SYNC_MARKER_CROP},blackdetect=d=0.4:pix_th=0.10:pic_th=0.90`,
    "-f", "null", "-",
  ], "ffmpeg blackdetect"));
  const audio = completed("ffmpeg silencedetect", run("ffmpeg", [
    "-hide_banner", "-nostats", "-vn", "-i", file,
    "-af", "silencedetect=n=-35dB:d=0.4",
    "-f", "null", "-",
  ], "ffmpeg silencedetect"));
  return { flashes: parseBlackdetect(video.stderr, durationSeconds), beeps: parseSilencedetect(audio.stderr, durationSeconds) };
}
