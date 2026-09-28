import { describe, expect, it } from "vitest";
import { median, percentile } from "./stats.mts";

describe("stats", () => {
  it("takes nearest-rank percentiles without mutating the input", () => {
    const values = [10, 1, 5, 3, 7];
    expect(percentile(values, 0.5)).toBe(5);
    expect(percentile(values, 0.95)).toBe(10);
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 1)).toBe(10);
    expect(values).toEqual([10, 1, 5, 3, 7]);
    expect(percentile([], 0.5)).toBeUndefined();
    // Twenty samples: p95 is the 19th, not the maximum.
    expect(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 0.95)).toBe(19);
  });

  it("averages the two middle values of an even count", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(median([])).toBeUndefined();
  });
});
