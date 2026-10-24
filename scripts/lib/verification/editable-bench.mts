/**
 * The judging half of `pnpm bench:editable` (plan 087, step 1): each recording's figures, the medians per mode, and
 * the prototype's provisional budgets. The engine's share is measured on synthetic capture; the app's is estimated by
 * adding the engine's increase to the app's recorded R with the camera, which only a recording of the packaged app can
 * confirm (087's closure).
 */
import { distribution } from "./finalization-timing.mts";

export type Mode = "direct" | "editable";

/** What the engine's bench line reports for one track. */
export interface BenchTrack { descriptions: string[]; samples: number; bytes: number; seconds: number; enabled: boolean }
export interface BenchLine { mode: Mode; seconds: number; fileBytes: number; fragmented: boolean; cameraLost: number; failures: string[]; tracks: BenchTrack[] }

/** One recording: its line and what the sampler read over its judged window. */
export interface Run {
  mode: Mode;
  round: number;
  line: BenchLine;
  /** The bench process, percent of one core, averaged over the window. */
  engineCpu: number;
  /** VideoToolbox's encoder service, outside the process. */
  encoderCpu: number;
  /** The bench process's largest resident size in the window. */
  residentBytes: number;
}

/**
 * The app's recording CPU with the camera composed at 30 fps on the reference M1 Pro: plan 090's retaken R
 * (docs/system-design/tooling.md, "The camera's rows, retaken by plan 090"), the before of the estimate.
 */
export const APP_CAMERA_R_30 = 12.2;
/** 087's provisional budgets: the app's CPU at most 1.5 times the direct mode's, its memory at most 256 MiB more. */
export const CPU_RATIO_BUDGET = 1.5;
export const MEMORY_BUDGET_BYTES = 256 * 1024 ** 2;

const median = (values: number[]): number => distribution(values)?.p50 ?? NaN;

export interface ModeFigures { engineCpu: number; encoderCpu: number; residentBytes: number; fileBytesPerMinute: number; trackBytesPerMinute: number[] }

/** The medians of a mode's recordings; each track's bytes scaled to a minute of its own length. */
export function figures(runs: readonly Run[], mode: Mode): ModeFigures | undefined {
  const of = runs.filter((run) => run.mode === mode);
  if (!of.length) return undefined;
  const perMinute = (bytes: number, seconds: number): number => (seconds > 0 ? bytes * 60 / seconds : NaN);
  const trackCount = Math.max(...of.map((run) => run.line.tracks.length));
  return {
    engineCpu: median(of.map((run) => run.engineCpu)),
    encoderCpu: median(of.map((run) => run.encoderCpu)),
    residentBytes: median(of.map((run) => run.residentBytes)),
    fileBytesPerMinute: median(of.map((run) => perMinute(run.line.fileBytes, run.line.seconds))),
    trackBytesPerMinute: Array.from({ length: trackCount }, (_, track) =>
      median(of.flatMap((run) => (run.line.tracks[track] ? [perMinute(run.line.tracks[track]!.bytes, run.line.tracks[track]!.seconds)] : [])))),
  };
}

export interface Verdict { check: string; limit: string; actual: string; verdict: "pass" | "fail" | "report" }

/**
 * The prototype's budgets against the medians: the app's estimated CPU (its R plus the engine's increase) over the
 * direct mode's, and the engine's resident increase. The encoder service is reported, not judged: it is the system's.
 */
export function judge(direct: ModeFigures, editable: ModeFigures, appR = APP_CAMERA_R_30): Verdict[] {
  const increase = editable.engineCpu - direct.engineCpu;
  const estimated = appR + increase;
  const ratio = estimated / appR;
  const memory = editable.residentBytes - direct.residentBytes;
  const mib = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return [
    { check: "engine CPU increase", limit: "reported", actual: `${increase >= 0 ? "+" : ""}${increase.toFixed(2)} points (${direct.engineCpu.toFixed(2)}% → ${editable.engineCpu.toFixed(2)}%)`, verdict: "report" },
    { check: "app CPU, estimated", limit: `≤ ${CPU_RATIO_BUDGET}× R ${appR}%`, actual: `${estimated.toFixed(2)}% (${ratio.toFixed(2)}×)`, verdict: ratio <= CPU_RATIO_BUDGET ? "pass" : "fail" },
    { check: "encoder service", limit: "reported", actual: `${direct.encoderCpu.toFixed(2)}% → ${editable.encoderCpu.toFixed(2)}%`, verdict: "report" },
    { check: "resident memory increase", limit: `≤ ${mib(MEMORY_BUDGET_BYTES)}`, actual: `${memory >= 0 ? "+" : ""}${mib(memory)}`, verdict: memory <= MEMORY_BUDGET_BYTES ? "pass" : "fail" },
    { check: "disk a minute", limit: "reported", actual: `${mib(direct.fileBytesPerMinute)} → ${mib(editable.fileBytesPerMinute)} (${(editable.fileBytesPerMinute / direct.fileBytesPerMinute).toFixed(2)}×)`, verdict: "report" },
  ];
}

/** The recording's frame rate: every video track must hold nearly this many pictures a second. */
export const FRAME_RATE = 30;
/** The share of the frame rate's pictures a video track must hold for its CPU to count: fewer is less work done. */
export const MIN_CADENCE = 0.95;

/**
 * Why a recording's evidence is unusable, if it is: an error, a fragmented file, lost camera, the wrong tracks, or a
 * video track with fewer pictures than its moving source gives (the muxer stretches the last picture to the stop, so a
 * track's length alone cannot show frames that were never encoded).
 */
export function problems(run: Run): string[] {
  const found: string[] = [...run.line.failures];
  if (run.line.fragmented) found.push("the file stayed fragmented");
  if (run.line.cameraLost) found.push(`the camera was told lost ${run.line.cameraLost} time(s)`);
  const expected = run.mode === "editable" ? ["avc1", "mp4a", "mp4a", "avc1"] : ["avc1", "mp4a"];
  const kinds = run.line.tracks.map((track) => track.descriptions[0] ?? "?");
  if (kinds.join() !== expected.join()) found.push(`tracks ${kinds.join(", ")} instead of ${expected.join(", ")}`);
  const presented = run.line.tracks.map((track) => track.enabled);
  if (presented.some((enabled, index) => enabled !== (index < 2))) found.push(`tracks presented ${presented.join(", ")}: only the first picture and sound should be`);
  run.line.tracks.forEach((track, index) => {
    if (track.descriptions[0] !== "avc1") return;
    const wanted = Math.floor(track.seconds * FRAME_RATE * MIN_CADENCE);
    if (track.samples < wanted) found.push(`video track ${index + 1} holds ${track.samples} pictures in ${track.seconds.toFixed(1)} s, fewer than ${wanted}`);
  });
  const lengths = run.line.tracks.map((track) => track.seconds);
  if (lengths.length && Math.max(...lengths) - Math.min(...lengths) > 0.1) found.push(`track lengths ${lengths.map((s) => s.toFixed(3)).join(", ")} s differ by more than 0.1 s`);
  return found;
}
