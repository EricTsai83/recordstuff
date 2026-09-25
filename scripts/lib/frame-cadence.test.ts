import { describe, expect, it } from "vitest";
import { cadenceStats, classifyCadence, counterDelta, type CadenceStats } from "./frame-cadence.mts";

/** Evenly spaced timestamps in seconds. */
const ticks = (count: number, intervalMs: number): number[] => Array.from({ length: count }, (_, i) => (i * intervalMs) / 1000);

describe("cadenceStats", () => {
  it("measures a floor-plus-latency cadence as late but not dropped", () => {
    const stats = cadenceStats(ticks(301, 33.9), 30)!;
    expect(stats.averageFps).toBeCloseTo(29.5, 1);
    expect(stats.medianIntervalMs).toBeCloseTo(33.9, 6);
    expect(stats.short).toBe(0);
    expect(stats.onPeriod).toBe(0);
    expect(stats.doubled).toBe(0);
  });

  it("counts on-period, short and doubled intervals against the nominal period", () => {
    // 0, 33.3, 50 (short 16.7), 116.7 (doubled 66.7), 150 (on period 33.3)
    const stats = cadenceStats([0, 0.0333, 0.05, 0.1167, 0.15].reverse(), 30)!;
    expect(stats.frames).toBe(5);
    expect(stats.onPeriod).toBe(2);
    expect(stats.short).toBe(1);
    expect(stats.doubled).toBe(1);
    expect(stats.minIntervalMs).toBeCloseTo(16.7, 6);
    expect(stats.maxIntervalMs).toBeCloseTo(66.7, 6);
  });

  it("needs two timestamps", () => {
    expect(cadenceStats([], 30)).toBeUndefined();
    expect(cadenceStats([1], 30)).toBeUndefined();
  });
});

describe("classifyCadence", () => {
  const late = cadenceStats(ticks(301, 33.9), 30);
  const onTime = cadenceStats(ticks(301, 33.34), 30);
  const base = { nominalFps: 30, discardedFrames: 0, totalFrames: 300 };

  it("names the source floor when frames already reach the track late and none is discarded", () => {
    expect(classifyCadence({ ...base, delivered: late, file: late }).layer).toBe("source-floor");
  });

  it("names the track limiter when the track discards frames", () => {
    expect(classifyCadence({ ...base, delivered: late, file: late, discardedFrames: 20, totalFrames: 320 }).layer).toBe("track-limiter");
  });

  it("names the recorder timestamps when frames arrive on time but the file is late", () => {
    expect(classifyCadence({ ...base, delivered: onTime, file: late }).layer).toBe("recorder-timestamps");
  });

  it("reports on-time cadence and missing evidence", () => {
    expect(classifyCadence({ ...base, delivered: onTime, file: onTime }).layer).toBe("on-time");
    expect(classifyCadence({ ...base, delivered: undefined, file: onTime }).layer).toBe("undetermined");
  });

  it("refuses to classify when the frame tap missed frames the file holds (review F1)", () => {
    // A stalled tap that kept every other frame looks like a slow source.
    const missed = cadenceStats(ticks(151, 66.7), 30);
    const result = classifyCadence({ ...base, delivered: missed, file: onTime });
    expect(result.layer).toBe("undetermined");
    expect(result.reason).toContain("151 of the file's 301 frames");
    // A frame or two at the recording's edges is not a loss.
    expect(classifyCadence({ ...base, delivered: cadenceStats(ticks(299, 33.9), 30), file: late }).layer).toBe("source-floor");
  });

  it("still classifies without track counters", () => {
    const result = classifyCadence({ nominalFps: 30, delivered: late as CadenceStats, file: late, discardedFrames: undefined, totalFrames: undefined });
    expect(result.layer).toBe("source-floor");
    expect(result.reason).toContain("track.stats unavailable");
  });
});

describe("counterDelta", () => {
  // The 10-second run that exposed the start-up window: 4 discards before the first sample after the recorder started.
  const samples = [
    { at: 282, delivered: 1, discarded: 0, total: 1 },
    { at: 1288, delivered: 30, discarded: 4, total: 34 },
    { at: 2288, delivered: 59, discarded: 4, total: 63 },
    { at: 10284, delivered: 298, discarded: 4, total: 302 },
  ];

  it("counts from the first sample after the recorder started to the last one before it stopped", () => {
    expect(counterDelta(samples, 331, 10337)).toEqual({ delivered: 268, discarded: 0, total: 268 });
    expect(counterDelta(samples, 0, 2300)).toEqual({ delivered: 58, discarded: 4, total: 62 });
  });

  it("omits counters the platform did not report and needs two samples inside the recording", () => {
    expect(counterDelta([{ at: 10, delivered: 1 }, { at: 1010, delivered: 31 }], 0, 2000)).toEqual({ delivered: 30 });
    expect(counterDelta(samples, 2000, 2500)).toBeUndefined();
    expect(counterDelta([], 0, 1000)).toBeUndefined();
  });
});
