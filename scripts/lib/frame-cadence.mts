/**
 * Frame-cadence diagnostic, pure part (plan 041): the interval distribution of
 * a list of frame timestamps and the layer a recording's distributions point
 * at. `scripts/diagnose-frame-cadence.mts` feeds it the renderer's frame
 * timestamps, the track's frame counters and the file's pts. Development
 * only; nothing here ships with the app.
 */

export interface CadenceStats {
  frames: number;
  /** Last minus first timestamp, in seconds. */
  spanSeconds: number;
  /** (frames − 1) ÷ span: the delivered rate, independent of the container duration. */
  averageFps: number | undefined;
  meanIntervalMs: number | undefined;
  medianIntervalMs: number | undefined;
  p05IntervalMs: number | undefined;
  p95IntervalMs: number | undefined;
  minIntervalMs: number | undefined;
  maxIntervalMs: number | undefined;
  /** Intervals shorter than 99% of the nominal period. */
  short: number;
  /** Intervals within ±1% of the nominal period. */
  onPeriod: number;
  /** Intervals longer than 1.5 nominal periods: at least one frame missing. */
  doubled: number;
}

/** Share of the nominal period an interval may differ by and still be on period; also the go criterion for the median. */
export const PERIOD_TOLERANCE = 0.01;

function quantile(sorted: number[], q: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return (sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low));
}

/** Timestamps in seconds, in any order; undefined when there are fewer than two. */
export function cadenceStats(times: number[], nominalFps: number): CadenceStats | undefined {
  const sorted = [...times].sort((a, b) => a - b);
  if (sorted.length < 2) return undefined;
  const period = 1 / nominalFps;
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) intervals.push(sorted[i]! - sorted[i - 1]!);
  const byLength = [...intervals].sort((a, b) => a - b);
  const span = sorted[sorted.length - 1]! - sorted[0]!;
  const ms = (seconds: number | undefined): number | undefined => (seconds === undefined ? undefined : seconds * 1000);
  return {
    frames: sorted.length,
    spanSeconds: span,
    averageFps: span > 0 ? intervals.length / span : undefined,
    meanIntervalMs: ms(span / intervals.length),
    medianIntervalMs: ms(quantile(byLength, 0.5)),
    p05IntervalMs: ms(quantile(byLength, 0.05)),
    p95IntervalMs: ms(quantile(byLength, 0.95)),
    minIntervalMs: ms(byLength[0]),
    maxIntervalMs: ms(byLength[byLength.length - 1]),
    short: intervals.filter((gap) => gap < period * (1 - PERIOD_TOLERANCE)).length,
    onPeriod: intervals.filter((gap) => Math.abs(gap - period) <= period * PERIOD_TOLERANCE).length,
    doubled: intervals.filter((gap) => gap > period * 1.5).length,
  };
}

export interface CounterSample { at: number; delivered?: number; discarded?: number; total?: number }
export type CounterDelta = Partial<Record<"delivered" | "discarded" | "total", number>>;

/**
 * `track.stats` counters over a recording: from the first once-a-second
 * sample taken after the recorder started to the last one before it stopped.
 * Starting after the recorder keeps the start-up burst, while the constraint
 * is still being applied, out of the share: a 10-second run discarded all 4
 * of its frames there (1.3%, above `DISCARD_SHARE`) and none afterwards.
 */
export function counterDelta(samples: CounterSample[], begin: number, end: number): CounterDelta | undefined {
  const first = samples.find((sample) => sample.at >= begin);
  const last = samples.filter((sample) => sample.at <= end).at(-1);
  if (!first || !last || last.at <= first.at) return undefined;
  const delta: CounterDelta = {};
  for (const key of ["delivered", "discarded", "total"] as const) {
    const from = first[key];
    const to = last[key];
    if (from !== undefined && to !== undefined) delta[key] = to - from;
  }
  return delta;
}

/**
 * Step 1's three candidates, named by where the excess interval appears:
 * (A) `source-floor` — frames already reach the track late and none is
 * discarded; (B) `track-limiter` — the track discards frames the source
 * delivered; (C) `recorder-timestamps` — frames reach the track on time but
 * the file's intervals are longer.
 */
export type CadenceLayer = "source-floor" | "track-limiter" | "recorder-timestamps" | "on-time" | "undetermined";

export interface CadenceEvidence {
  nominalFps: number;
  /** Frame timestamps as the track delivered them (before MediaRecorder). */
  delivered: CadenceStats | undefined;
  /** The recorded file's pts. */
  file: CadenceStats | undefined;
  /** `track.stats` counters over the recording, when the platform exposes them. */
  discardedFrames: number | undefined;
  totalFrames: number | undefined;
}

/** A track that discards more than this share of its frames is limiting the rate. */
export const DISCARD_SHARE = 0.01;

/**
 * The renderer's frame tap is one more sink on the track: a stalled reader
 * can miss frames the recorder still got. Seeing fewer than this share of
 * the file's frames makes the delivered distribution unusable (review F1).
 */
export const TAP_COMPLETENESS = 0.99;

export function classifyCadence(evidence: CadenceEvidence): { layer: CadenceLayer; reason: string } {
  const { delivered, file, nominalFps } = evidence;
  if (!delivered?.medianIntervalMs || !file?.medianIntervalMs) {
    return { layer: "undetermined", reason: "delivered or file timestamps missing" };
  }
  if (delivered.frames < file.frames * TAP_COMPLETENESS) {
    return { layer: "undetermined", reason: `the frame tap saw ${delivered.frames} of the file's ${file.frames} frames; observer-side loss hides the source cadence` };
  }
  const periodMs = 1000 / nominalFps;
  const late = (medianMs: number): boolean => medianMs > periodMs * (1 + PERIOD_TOLERANCE);
  const discardShare = evidence.totalFrames ? (evidence.discardedFrames ?? 0) / evidence.totalFrames : undefined;
  const medians = `delivered median ${delivered.medianIntervalMs.toFixed(2)} ms, file median ${file.medianIntervalMs.toFixed(2)} ms, period ${periodMs.toFixed(2)} ms`;
  const discards = discardShare === undefined ? "track.stats unavailable" : `${(discardShare * 100).toFixed(2)}% discarded`;
  if (discardShare !== undefined && discardShare > DISCARD_SHARE) {
    return { layer: "track-limiter", reason: `${discards}; ${medians}` };
  }
  if (late(delivered.medianIntervalMs)) {
    return { layer: "source-floor", reason: `frames reach the track late; ${discards}; ${medians}` };
  }
  if (late(file.medianIntervalMs)) {
    return { layer: "recorder-timestamps", reason: `frames reach the track on time but the file is late; ${discards}; ${medians}` };
  }
  return { layer: "on-time", reason: `${discards}; ${medians}` };
}
