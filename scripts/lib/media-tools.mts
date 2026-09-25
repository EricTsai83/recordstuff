/**
 * The only place the verification toolkit runs external programs: ffprobe for
 * container / stream facts and frame timestamps, ffmpeg for per-channel
 * loudness and the flash / beep sync markers of `scripts/test-material.html`.
 * Both come from `brew install ffmpeg`. Development only, never shipped.
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

function run(tool: string, args: string[]): RunResult {
  const result = spawnSync(tool, args, { encoding: "utf8", maxBuffer: MAX_BUFFER });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") throw new ToolMissingError(tool);
  if (result.error) throw result.error;
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
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
  try {
    run(tool, ["-version"]);
    return true;
  } catch {
    return false;
  }
}

/** Streams, format and a full decode (`-count_frames`); stderr holds decode errors, if any. */
export function probe(file: string): { info: ProbeInfo; decodeErrors: string } {
  const { stdout, stderr } = completed("ffprobe", run("ffprobe", [
    "-v", "error", "-show_format", "-show_streams", "-count_frames", "-of", "json", file,
  ]));
  let info: ProbeInfo;
  try {
    info = JSON.parse(stdout) as ProbeInfo;
  } catch {
    throw new MeasurementError(`ffprobe printed malformed JSON${stderrTail(stderr)}`);
  }
  if (!Array.isArray(info.streams) || typeof info.format !== "object" || info.format === null) {
    throw new MeasurementError("ffprobe output has no format or stream list");
  }
  return { info, decodeErrors: stderr };
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
    return parseFrameTimes(completed("ffprobe frames", run("ffprobe", args)).stdout);
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
  ]));
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
 * `silencedetect` gives the beep starts (silence_end). The crop is expressed
 * in fractions of the frame height so it lands inside the box at any
 * landscape resolution.
 */
export function syncMarkers(file: string, durationSeconds: number | undefined): { flashes: number[]; beeps: number[] } {
  const video = completed("ffmpeg blackdetect", run("ffmpeg", [
    "-hide_banner", "-nostats", "-an", "-i", file,
    "-vf", "crop=ih*0.08:ih*0.08:iw-ih*0.115:ih*0.035,blackdetect=d=0.4:pix_th=0.10:pic_th=0.90",
    "-f", "null", "-",
  ]));
  const audio = completed("ffmpeg silencedetect", run("ffmpeg", [
    "-hide_banner", "-nostats", "-vn", "-i", file,
    "-af", "silencedetect=n=-35dB:d=0.4",
    "-f", "null", "-",
  ]));
  return { flashes: parseBlackdetect(video.stderr, durationSeconds), beeps: parseSilencedetect(audio.stderr, durationSeconds) };
}
