import { describe, expect, it } from "vitest";
import { parseFrameLog, summarizeFrameLog } from "./frame-log.mts";

const line = (t: number, kind: string, kept: boolean) => JSON.stringify({ t, kind, kept, next: null });

describe("frame log", () => {
  it("finds a long gap and the deliveries around it", () => {
    const text = [
      line(0, "first", true),
      line(33.3, "picture", true),
      line(50, "picture", false),
      line(66.6, "idle", false),
      line(83.3, "picture", true),
      line(116.6, "picture", true),
      line(120, "stop", true),
    ].join("\n");
    const summary = summarizeFrameLog(parseFrameLog(text), 30);
    expect(summary.kept).toBe(5);
    expect(summary.deliveries).toEqual({ picture: 4, idle: 1, blank: 0 });
    expect(summary.long).toHaveLength(1);
    expect(summary.long[0]!.ms).toBeCloseTo(50, 1);
    expect(summary.long[0]!.context.map((l) => l.kind)).toEqual(["first", "picture", "picture", "idle", "picture"]);
    // The stop's frame lands anywhere and is not a short gap.
    expect(summary.short).toHaveLength(0);
  });

  it("refuses a file that is not a frame log", () => {
    expect(() => parseFrameLog('{"a":1}')).toThrow(/line 1/);
  });
});
