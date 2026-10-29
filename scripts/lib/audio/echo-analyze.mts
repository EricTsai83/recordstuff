/**
 * Plan 096's analyzer: how much echo a canceller removed and what it did to the voice, judged against the answer known
 * in advance (docs/system-design/tooling.md#echo-removal-bench). Inputs are the microphone before (`input`) and after
 * (`output`) processing and the ideal output (the microphone without the echo), with the take's script. Every figure
 * is computed on 20 ms frames (Hann window, 1024-point FFT), per band and over 125 Hz–16 kHz. Developer tooling only.
 */
import { RATE, db, fft, percentile } from "./echo-dsp.mts";
import type { Segment, SegmentKind, VolumeEvent } from "./echo-material.mts";

export const FRAME = 960;
const SIZE = 1024;
export const BANDS = [
  { name: "full", low: 125, high: 16_000 },
  { name: "125-1k", low: 125, high: 1_000 },
  { name: "1k-4k", low: 1_000, high: 4_000 },
  { name: "4k-8k", low: 4_000, high: 8_000 },
  { name: "8k-12k", low: 8_000, high: 12_000 },
  { name: "12k-16k", low: 12_000, high: 16_000 },
] as const;
export type BandName = typeof BANDS[number]["name"];

/** The plan's proposed gates, applied as written until D1 freezes them; the report says they are proposed. */
export const PROPOSED_GATES = {
  g0EchoToVoiceDb: -30,
  g1aErleDb: 25,
  g1bErleDb: 15,
  g1bBands: ["125-1k", "1k-4k", "4k-8k", "8k-12k"] as BandName[],
  g1cSeconds: 2,
  g1cErleDb: 15,
  g2ChangeDb: -40,
  g2LevelDb: 0.5,
  g3MedianLossDb: 1,
  g3P95LossDb: 3,
  g3DropoutDb: 10,
  g3DropoutFraction: 0.01,
} as const;
/** ERLE is not judged before this long after the first far-end sound or a volume change (G1c's allowance). */
export const SETTLE_SECONDS = 2;
/** Frames this close to a segment's boundary belong to neither side. */
const MARGIN_SECONDS = 0.03;
/** A band's frames in which the voice is judged need at least this many to be judged at all. */
const MIN_FRAMES = 20;
const MAX_LOSS_DB = 60;
/** How far the output may lag or lead the input and still be aligned before the comparison (±50 ms). */
const MAX_LAG = 2400;

export interface AnalysisInput {
  input: Float32Array;
  output: Float32Array;
  ideal: Float32Array;
  script: readonly Segment[];
  events: readonly VolumeEvent[];
}
export interface Check { gate: string; metric: string; value: number | null; expected: string; pass: boolean | null }
export interface EchoReport {
  version: 1;
  gates: "proposed";
  verdict: "pass" | "fail" | "invalid";
  /** Samples by which the output was shifted to line up with the input (positive: the output was late). */
  lagSamples: number;
  /** The echo in the input against the voice, each where it is alone, over 125 Hz–16 kHz: G0. */
  raw: { echoToVoiceDb: number | null };
  erle: Record<BandName, { frames: number; median: number | null; p5: number | null }>;
  convergence: { from: "first far-end sound" | "volume change"; at: number; seconds: number | null }[];
  nearEnd: Record<BandName, { frames: number; changeDb: number | null; levelDb: number | null }>;
  doubleTalk: Record<BandName, { frames: number; medianLossDb: number | null; p95LossDb: number | null; dropoutFraction: number | null }>;
  checks: Check[];
  invalid?: string;
}

const HANN = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / FRAME));
const BINS = BANDS.map(b => [Math.ceil(b.low * SIZE / RATE), Math.min(SIZE / 2, Math.floor(b.high * SIZE / RATE))] as const);

function spectrum(pcm: Float32Array, start: number): [Float64Array, Float64Array] {
  const re = new Float64Array(SIZE), im = new Float64Array(SIZE);
  for (let i = 0; i < FRAME; i++) re[i] = (pcm[start + i] ?? 0) * HANN[i]!;
  fft(re, im);
  return [re, im];
}

/** The lag (in samples, ±MAX_LAG) that best lines the output up with the input, over the stretches with a voice. */
export function estimateLag(input: Float32Array, output: Float32Array, script: readonly Segment[]): number {
  const voiced = script.filter(s => s.kind === "near" || s.kind === "double");
  const ranges = (voiced.length ? voiced : [{ start: 0, end: input.length / RATE }]).map(s => [Math.round(s.start * RATE), Math.min(input.length, Math.round(s.end * RATE))] as const);
  const total = ranges.reduce((sum, [a, b]) => sum + b - a, 0);
  // Circular cross-correlation of the two concatenations, padded so lags within ±MAX_LAG do not wrap.
  const size = 2 ** Math.ceil(Math.log2(total + MAX_LAG + 1));
  const ar = new Float64Array(size), ai = new Float64Array(size), br = new Float64Array(size), bi = new Float64Array(size);
  let at = 0;
  for (const [a, b] of ranges) {
    for (let i = a; i < b; i++, at++) { ar[at] = input[i]!; br[at] = output[i] ?? 0; }
  }
  fft(ar, ai); fft(br, bi);
  for (let i = 0; i < size; i++) {
    const r = br[i]! * ar[i]! + bi[i]! * ai[i]!, m = bi[i]! * ar[i]! - br[i]! * ai[i]!;
    br[i] = r; bi[i] = m;
  }
  fft(br, bi, true);
  let best = 0, bestValue = 0;
  for (let lag = -MAX_LAG; lag <= MAX_LAG; lag++) {
    const value = br[(lag + size) % size]!;
    if (value > bestValue) { bestValue = value; best = lag; }
  }
  return best;
}

const empty = <T,>(make: () => T): Record<BandName, T> => Object.fromEntries(BANDS.map(b => [b.name, make()])) as Record<BandName, T>;

export function analyzeEcho({ input, output, ideal, script, events }: AnalysisInput): EchoReport {
  const report: EchoReport = {
    version: 1, gates: "proposed", verdict: "fail", lagSamples: 0, raw: { echoToVoiceDb: null },
    erle: empty(() => ({ frames: 0, median: null, p5: null })), convergence: [],
    nearEnd: empty(() => ({ frames: 0, changeDb: null, levelDb: null })),
    doubleTalk: empty(() => ({ frames: 0, medianLossDb: null, p95LossDb: null, dropoutFraction: null })), checks: [],
  };
  const finite = (pcm: Float32Array): boolean => pcm.every(Number.isFinite);
  if (!input.length || input.length !== ideal.length || Math.abs(output.length - input.length) > FRAME || ![input, output, ideal].every(finite)) {
    return { ...report, verdict: "invalid", invalid: "input, output and ideal must be finite and equally long (the output within one frame)" };
  }
  const lag = estimateLag(input, output, script);
  report.lagSamples = lag;
  const aligned = new Float32Array(input.length);
  for (let i = 0; i < aligned.length; i++) aligned[i] = output[i + lag] ?? 0;

  const frames = Math.floor(input.length / FRAME);
  const kindOf = (frame: number): SegmentKind | undefined => {
    const start = frame * FRAME / RATE, end = (frame + 1) * FRAME / RATE;
    return script.find(s => start >= s.start + MARGIN_SECONDS && end <= s.end - MARGIN_SECONDS)?.kind;
  };
  // Per frame and band: energies of input, output, ideal, the input's echo (input − ideal) and the change (output −
  // input), and the complex sums the voice's two-regressor fit needs.
  type Stats = { eIn: number; eOut: number; eIdeal: number; eEcho: number; eChange: number; xe: [number, number]; xy: [number, number]; ey: [number, number] };
  const stats: Stats[][] = [];
  const kinds: (SegmentKind | undefined)[] = [];
  for (let f = 0; f < frames; f++) {
    const [ir, ii] = spectrum(input, f * FRAME), [or, oi] = spectrum(aligned, f * FRAME), [xr, xi] = spectrum(ideal, f * FRAME);
    stats.push(BINS.map(([lo, hi]) => {
      const s: Stats = { eIn: 0, eOut: 0, eIdeal: 0, eEcho: 0, eChange: 0, xe: [0, 0], xy: [0, 0], ey: [0, 0] };
      for (let k = lo; k <= hi; k++) {
        const er = ir[k]! - xr[k]!, ei = ii[k]! - xi[k]!;
        s.eIn += ir[k]! ** 2 + ii[k]! ** 2;
        s.eOut += or[k]! ** 2 + oi[k]! ** 2;
        s.eIdeal += xr[k]! ** 2 + xi[k]! ** 2;
        s.eEcho += er ** 2 + ei ** 2;
        s.eChange += (or[k]! - ir[k]!) ** 2 + (oi[k]! - ii[k]!) ** 2;
        // conj(a)·b = (ar·br + ai·bi) + i(ar·bi − ai·br)
        s.xe[0] += xr[k]! * er + xi[k]! * ei; s.xe[1] += xr[k]! * ei - xi[k]! * er;
        s.xy[0] += xr[k]! * or[k]! + xi[k]! * oi[k]!; s.xy[1] += xr[k]! * oi[k]! - xi[k]! * or[k]!;
        s.ey[0] += er * or[k]! + ei * oi[k]!; s.ey[1] += er * oi[k]! - ei * or[k]!;
      }
      return s;
    }));
    kinds.push(kindOf(f));
  }
  const ofKind = (kind: SegmentKind): number[] => kinds.flatMap((k, f) => k === kind ? [f] : []);
  const silence = ofKind("silence"), far = ofKind("far"), near = ofKind("near"), double = ofKind("double");
  const all = Array.from({ length: frames }, (_, f) => f);
  // Noise floors per band from the silent stretches (or the quietest tenth when the script has none).
  const floor = (band: number, key: "eIn" | "eIdeal"): number =>
    (silence.length ? percentile(silence.map(f => stats[f]![band]![key]), 50) : percentile(all.map(f => stats[f]![band]![key]), 10)) ?? 0;
  const time = (frame: number): number => frame * FRAME / RATE;

  BANDS.forEach((band, b) => {
    const inFloor = floor(b, "eIn"), idealFloor = floor(b, "eIdeal");
    // ERLE where the far end is alone and audible in the input (10 dB over the floor), once settled.
    const active = far.filter(f => stats[f]![b]!.eIn > inFloor * 10);
    const onset = active.length ? time(active[0]!) : undefined;
    const settled = active.filter(f => onset !== undefined && time(f) >= onset + SETTLE_SECONDS &&
      !events.some(e => time(f) + FRAME / RATE > e.at && time(f) < e.at + SETTLE_SECONDS));
    // The input's noise floor is taken off both sides: it is not echo, and left in it caps what can be read.
    // A fixed positive bound below it keeps the ratio finite on noiseless material.
    const least = Math.max(inFloor, 1e-12) * 1e-3;
    const erleOf = (eIn: number, eOut: number): number => db(Math.max(eIn - inFloor, least) / Math.max(eOut - inFloor, least));
    const erle = settled.map(f => erleOf(stats[f]![b]!.eIn, stats[f]![b]!.eOut));
    report.erle[band.name] = { frames: erle.length, median: percentile(erle, 50), p5: percentile(erle, 5) };

    const nearFrames = near.map(f => stats[f]![b]!);
    const sum = (key: keyof Stats): number => nearFrames.reduce((total, s) => total + (s[key] as number), 0);
    report.nearEnd[band.name] = nearFrames.length && sum("eIn") > 0
      ? { frames: nearFrames.length, changeDb: Math.max(-120, db(sum("eChange") / sum("eIn"))), levelDb: db(sum("eOut") / sum("eIn")) }
      : { frames: nearFrames.length, changeDb: null, levelDb: null };

    // The voice in double-talk: frames where the ideal is 15 dB over its floor and within 30 dB of its loud frames.
    const loud = percentile(double.map(f => stats[f]![b]!.eIdeal), 95) ?? 0;
    const voiced = double.filter(f => stats[f]![b]!.eIdeal > Math.max(idealFloor * 31.6, loud * 1e-3));
    const losses = voiced.map(f => {
      // Output ≈ g·ideal + h·echo, solved per frame: residual echo correlated with the input's echo is not read as voice.
      const s = stats[f]![b]!, det = s.eIdeal * s.eEcho - (s.xe[0] ** 2 + s.xe[1] ** 2);
      let g: number;
      if (s.eEcho < s.eIdeal * 1e-9 || det < s.eIdeal * s.eEcho * 1e-6) g = s.xy[0] / s.eIdeal;
      else {
        // g = (xy·eEcho − xe·ey) / det, real part.
        g = (s.xy[0] * s.eEcho - (s.xe[0] * s.ey[0] - s.xe[1] * s.ey[1])) / det;
      }
      return Math.min(MAX_LOSS_DB, -20 * Math.log10(Math.max(g, 10 ** (-MAX_LOSS_DB / 20))));
    });
    report.doubleTalk[band.name] = losses.length >= MIN_FRAMES
      ? { frames: losses.length, medianLossDb: percentile(losses, 50), p95LossDb: percentile(losses, 95), dropoutFraction: losses.filter(l => l > PROPOSED_GATES.g3DropoutDb).length / losses.length }
      : { frames: losses.length, medianLossDb: null, p95LossDb: null, dropoutFraction: null };

    if (band.name === "full") {
      const mean = (list: number[], key: "eIn"): number => list.reduce((t, f) => t + stats[f]![b]![key], 0) / Math.max(1, list.length);
      const nearActive = near.filter(f => stats[f]![b]!.eIn > inFloor * 31.6);
      report.raw.echoToVoiceDb = active.length && nearActive.length ? db(mean(active, "eIn") / mean(nearActive, "eIn")) : null;
      // Convergence: from the first far-end sound and each volume change, the time after which every complete 100 ms
      // window (five consecutive frames) with far-end sound, to the end of that far-end stretch, keeps ERLE above the
      // threshold. A window's ERLE is over its frames with far-end sound; a window without any is skipped.
      const starts = [
        ...(onset !== undefined ? [{ from: "first far-end sound" as const, at: onset }] : []),
        ...events.map(e => ({ from: "volume change" as const, at: e.at })),
      ];
      for (const start of starts) {
        const segment = script.find(s => s.kind === "far" && start.at >= s.start && start.at < s.end);
        const audible = new Set(active);
        // Frames of one far-end stretch are consecutive: kindOf excludes only its edges.
        const stretch = far.filter(f => time(f) >= start.at && segment !== undefined && time(f) + FRAME / RATE <= segment.end);
        let seconds: number | null = null;
        for (let w = stretch.length - 5; w >= 0; w--) {
          const group = stretch.slice(w, w + 5).filter(f => audible.has(f));
          if (!group.length) continue;
          const value = erleOf(group.reduce((t, f) => t + stats[f]![b]!.eIn, 0) / group.length, group.reduce((t, f) => t + stats[f]![b]!.eOut, 0) / group.length);
          if (value < PROPOSED_GATES.g1cErleDb) break;
          seconds = Math.max(0, time(stretch[w]!) - start.at);
        }
        report.convergence.push({ ...start, seconds });
      }
    }
  });

  const g = PROPOSED_GATES, checks = report.checks;
  const add = (gate: string, metric: string, value: number | null, expected: string, test: (v: number) => boolean, applies = true): void => {
    checks.push({ gate, metric, value, expected, pass: !applies ? null : value === null ? false : test(value) });
  };
  const echoPresent = report.erle.full.frames > 0;
  add("G1a", "ERLE full band, settled median (dB)", report.erle.full.median, `>= ${g.g1aErleDb}`, v => v >= g.g1aErleDb, echoPresent);
  for (const name of g.g1bBands) {
    add("G1b", `ERLE ${name}, settled median (dB)`, report.erle[name].median, `>= ${g.g1bErleDb}`, v => v >= g.g1bErleDb, report.erle[name].frames > 0);
  }
  for (const c of report.convergence) add("G1c", `Above ${g.g1cErleDb} dB after the ${c.from} at ${c.at.toFixed(2)} s (s)`, c.seconds, `<= ${g.g1cSeconds}`, v => v <= g.g1cSeconds);
  add("G2", "Change without echo, full band (dB)", report.nearEnd.full.changeDb, `<= ${g.g2ChangeDb}`, v => v <= g.g2ChangeDb);
  add("G2", "Level without echo, full band (dB)", report.nearEnd.full.levelDb, `±${g.g2LevelDb}`, v => Math.abs(v) <= g.g2LevelDb);
  // G3 per band as well as over the whole band: a voice cut above 4 kHz barely moves the full band's figure.
  for (const band of BANDS) {
    const d = report.doubleTalk[band.name], applies = band.name === "full" || d.frames >= MIN_FRAMES;
    add("G3", `Voice loss ${band.name}, median (dB)`, d.medianLossDb, `<= ${g.g3MedianLossDb}`, v => v <= g.g3MedianLossDb, applies);
    add("G3", `Voice loss ${band.name}, 95th percentile (dB)`, d.p95LossDb, `<= ${g.g3P95LossDb}`, v => v <= g.g3P95LossDb, applies);
  }
  add("G3", `Voice frames down more than ${g.g3DropoutDb} dB, full band`, report.doubleTalk.full.dropoutFraction, `<= ${g.g3DropoutFraction}`, v => v <= g.g3DropoutFraction);
  report.verdict = checks.every(c => c.pass !== false) ? "pass" : "fail";
  return report;
}
