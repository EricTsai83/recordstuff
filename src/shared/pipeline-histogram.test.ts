import { describe, expect, it } from "vitest";
import { Histogram, PIPELINE_BUCKETS, bucketMidpointUs, bucketOf, isHistogramJson, mergeHistograms, percentileUs, summarizeHistogram } from "./pipeline-histogram";

describe("pipeline histograms (plan 083)", () => {
  it("puts a value in the engine's bucket (core/diagnostics.rs's own cases)", () => {
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(1)).toBe(0);
    expect(bucketOf(2)).toBe(4);
    expect(bucketOf(3)).toBe(6);
    expect(bucketOf(1000)).toBe(39);
    expect(bucketOf(1024)).toBe(40);
    expect(bucketOf(1279)).toBe(40);
    expect(bucketOf(1280)).toBe(41);
    expect(bucketOf(2 ** 32 - 1)).toBe(PIPELINE_BUCKETS - 1);
    expect(bucketOf(2 ** 40)).toBe(PIPELINE_BUCKETS - 1);
  });

  it("reads a bucket's midpoint within an eighth of the values it holds", () => {
    for (const us of [3, 17, 999, 1000, 33_333, 250_000, 4_000_000]) {
      const mid = bucketMidpointUs(bucketOf(us));
      expect(Math.abs(mid - us) / us, String(us)).toBeLessThanOrEqual(0.125 + 1e-9);
    }
  });

  it("reads the engine's report as it is written", () => {
    // core/diagnostics.rs's test: 1 ms twice and 3 µs.
    const engine: unknown = JSON.parse(`{"n":3,"sum":2003,"max":1000,"b":{"6":1,"39":2}}`);
    expect(isHistogramJson(engine)).toBe(true);
    const page = new Histogram();
    page.recordMs(1);
    page.recordMs(1);
    page.recordMs(0.003);
    expect(page.toJSON()).toEqual(engine);
    expect(isHistogramJson({ n: 1, sum: 1, max: 1, b: { 128: 1 } })).toBe(false);
    expect(isHistogramJson({ n: -1, sum: 1, max: 1, b: {} })).toBe(false);
  });

  it("merges intervals by adding their counts and keeps the larger maximum", () => {
    const a = new Histogram();
    const b = new Histogram();
    for (let i = 0; i < 90; i += 1) a.recordMs(10);
    for (let i = 0; i < 10; i += 1) b.recordMs(100);
    const merged = mergeHistograms(a.take(), b.take());
    expect(merged.n).toBe(100);
    expect(merged.max).toBe(100_000);
    // p50 in 10 ms's bucket, p95 in 100 ms's, capped at the maximum.
    expect(percentileUs(merged, 0.5)! / 10_000).toBeCloseTo(1, 0);
    expect(percentileUs(merged, 0.95)).toBeLessThanOrEqual(100_000);
    expect(percentileUs(merged, 0.95)! / 100_000).toBeGreaterThan(0.875);
    expect(a.count).toBe(0);
  });

  it("summarizes in milliseconds, and an empty histogram as its count alone", () => {
    const h = new Histogram();
    h.recordMs(2);
    h.recordMs(4);
    h.recordMs(-3);
    const summary = summarizeHistogram(h.toJSON());
    expect(summary.n).toBe(3);
    expect(summary.meanMs).toBe(2);
    expect(summary.maxMs).toBe(4);
    expect(summarizeHistogram(new Histogram().toJSON())).toEqual({ n: 0 });
  });
});
