/**
 * The media pipeline's stage histograms (plan 083): the buckets of the capture engine's `core/diagnostics.rs`, so the
 * engine's and the Studio page's figures read and merge alike. A value in microseconds `v` falls in octave
 * `o = floor(log2 v)` and its quarter `q = floor(4 (v - 2^o) / 2^o)`: bucket `4 o + q`, 0 for `v <= 1` and the last
 * from 2^32 µs on. A percentile is read as its bucket's midpoint, within about 12.5% of the value, and never above the
 * exact maximum. Counts merge by adding, so intervals and sessions combine without the samples.
 */

/** The development switch that makes each session keep its figures (the engine's `diagnostics::ENV`). */
export const DIAGNOSTICS_ENV = "RECORDSTUFF_DIAGNOSTICS";
/** The diagnostics' version, in every engine and page report; another is refused. */
export const PIPELINE_SCHEMA = 1;
export const PIPELINE_BUCKETS = 128;

/** A histogram as reported: count, sum and maximum in microseconds, and the counts of its filled buckets. */
export interface HistogramJson { n: number; sum: number; max: number; b: Record<string, number> }

export interface HistogramSummary {
  n: number;
  /** In milliseconds; absent without samples. */
  meanMs?: number; p50Ms?: number; p95Ms?: number; maxMs?: number;
}

/** The bucket of `us` microseconds. */
export function bucketOf(us: number): number {
  const value = Math.max(0, Math.floor(us));
  if (value <= 1) return 0;
  if (value >= 2 ** 32) return PIPELINE_BUCKETS - 1;
  const octave = 31 - Math.clz32(value);
  const start = 2 ** octave;
  return octave * 4 + Math.floor(((value - start) * 4) / start);
}

/** The middle of bucket `index`, in microseconds. */
export function bucketMidpointUs(index: number): number {
  if (index < 4) return 1;
  const octave = Math.floor(index / 4);
  const width = 2 ** octave / 4;
  return 2 ** octave + (index % 4) * width + width / 2;
}

export const emptyHistogram = (): HistogramJson => ({ n: 0, sum: 0, max: 0, b: {} });

/** Collects durations; `toJSON` is what the engine's histograms report. */
export class Histogram {
  private value = emptyHistogram();

  /** A duration in milliseconds; a negative one (clocks that moved) counts as zero. */
  recordMs(ms: number): void {
    if (!Number.isFinite(ms)) return;
    const us = Math.max(0, Math.round(ms * 1000));
    const key = String(bucketOf(us));
    this.value.b[key] = (this.value.b[key] ?? 0) + 1;
    this.value.n += 1;
    this.value.sum += us;
    this.value.max = Math.max(this.value.max, us);
  }

  get count(): number { return this.value.n; }

  toJSON(): HistogramJson {
    return { n: this.value.n, sum: this.value.sum, max: this.value.max, b: { ...this.value.b } };
  }

  /** What was collected, and a fresh start. */
  take(): HistogramJson {
    const taken = this.value;
    this.value = emptyHistogram();
    return taken;
  }
}

const count = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

export function isHistogramJson(value: unknown): value is HistogramJson {
  const h = value as Partial<HistogramJson> | null;
  if (!h || typeof h !== "object" || !count(h.n) || !count(h.sum) || !count(h.max) || !h.b || typeof h.b !== "object") return false;
  return Object.entries(h.b).every(([key, n]) => /^\d+$/.test(key) && Number(key) < PIPELINE_BUCKETS && count(n));
}

export function mergeHistograms(...histograms: readonly HistogramJson[]): HistogramJson {
  const merged = emptyHistogram();
  for (const h of histograms) {
    merged.n += h.n;
    merged.sum += h.sum;
    merged.max = Math.max(merged.max, h.max);
    for (const [key, n] of Object.entries(h.b)) merged.b[key] = (merged.b[key] ?? 0) + n;
  }
  return merged;
}

/** The `p` quantile (0–1) in microseconds: its bucket's midpoint, capped at the maximum; none without samples. */
export function percentileUs(h: HistogramJson, p: number): number | undefined {
  if (h.n === 0) return undefined;
  const rank = Math.max(1, Math.ceil(p * h.n));
  let seen = 0;
  for (const index of Object.keys(h.b).map(Number).sort((a, b) => a - b)) {
    seen += h.b[String(index)]!;
    if (seen >= rank) return Math.min(bucketMidpointUs(index), h.max);
  }
  return h.max;
}

export function summarizeHistogram(h: HistogramJson): HistogramSummary {
  if (h.n === 0) return { n: 0 };
  const ms = (us: number | undefined): number => Math.round((us ?? 0) / 10) / 100;
  return { n: h.n, meanMs: ms(h.sum / h.n), p50Ms: ms(percentileUs(h, 0.5)), p95Ms: ms(percentileUs(h, 0.95)), maxMs: ms(h.max) };
}
