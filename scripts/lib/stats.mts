/**
 * The order statistics the measurement tools share, so every report means the
 * same thing by "median" and "p95": nearest-rank percentiles, and the usual
 * midpoint median. Inputs are copied and sorted; callers pass raw samples.
 */

/** Nearest-rank percentile of `values` for a fraction in [0, 1]; undefined for no values. */
export function percentile(values: readonly number[], fraction: number): number | undefined {
  return percentileSorted([...values].sort((a, b) => a - b), fraction);
}

/** Nearest rank for samples already sorted ascending; avoids sorting each requested percentile again. */
export function percentileSorted(sorted: readonly number[], fraction: number): number | undefined {
  if (sorted.length === 0) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

/** The midpoint median (the mean of the two middle values for an even count); undefined for no values. */
export function median(values: readonly number[]): number | undefined {
  return medianSorted([...values].sort((a, b) => a - b));
}

/** Midpoint median for samples already sorted ascending. */
export function medianSorted(sorted: readonly number[]): number | undefined {
  if (sorted.length === 0) return undefined;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
