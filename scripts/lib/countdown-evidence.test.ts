import { describe, expect, it } from "vitest";
import { DIGIT_DIFF_THRESHOLD, compareCrops, countdownTimeline, digitRegion } from "./countdown-evidence.mts";

const at = (ms: number, text: string): string => `[${new Date(Date.UTC(2026, 8, 26, 5, 0, 0) + ms).toISOString()}] ${text}`;

describe("countdown timeline", () => {
  it("separates preparation, ticks, dismissal, record → started and the first chunk", () => {
    const lines = [
      at(10, "hotkey: CommandOrControl+Shift+1 pressed"),
      at(15, "state → starting"),
      at(300, "recorder: session s1 prepared after 290 ms; countdown 3 s"),
      at(301, "state → countdown (3)"),
      at(305, "countdown overlay: display 1 at 1408,37 88x88 in display bounds 0,0 1512x982"),
      at(1302, "state → countdown (2)"),
      at(2301, "state → countdown (1)"),
      at(3155, "recorder: session s1 countdown overlay dismissed after 155 ms"),
      at(3301, "recorder: session s1 record sent 3000 ms after the 3 s countdown began"),
      at(3340, "recorder: session s1 started 39 ms after record"),
      at(3341, "state → recording"),
      at(4400, "recorder: session s1 first chunk 812345 bytes"),
    ];
    expect(countdownTimeline(lines, new Date(Date.UTC(2026, 8, 26, 5, 0, 0) + 10))).toEqual({
      countdown: 3, preparationMs: 290,
      ticks: [{ remaining: 3, atMs: 0 }, { remaining: 2, atMs: 1001 }, { remaining: 1, atMs: 2000 }],
      overlay: { window: { x: 1408, y: 37, width: 88, height: 88 }, display: { x: 0, y: 0, width: 1512, height: 982 } },
      dismissal: { outcome: "dismissed", ms: 155 }, recordAfterAnchorMs: 3000, recordToStartedMs: 39, startedToFirstChunkMs: 1059,
    });
  });

  it("reads Off and a dismissal that timed out", () => {
    expect(countdownTimeline([at(100, "recorder: session s2 prepared after 90 ms; countdown 0 s"), at(101, "recorder: session s2 record sent without a countdown")], new Date(Date.UTC(2026, 8, 26, 5))))
      .toMatchObject({ countdown: 0, ticks: [] });
    expect(countdownTimeline([at(0, "recorder: session s3 prepared after 1 ms; countdown 3 s"),
      at(3200, "recorder: session s3 countdown overlay did not confirm dismissal within 500 ms; destroying it")], new Date(Date.UTC(2026, 8, 26, 5))).dismissal)
      .toEqual({ outcome: "timed out" });
  });
});

describe("digit region", () => {
  const overlay = { window: { x: 1408, y: 37, width: 88, height: 88 }, display: { x: 0, y: 0, width: 1512, height: 982 } };
  it("scales points to the recorded frame size", () => {
    expect(digitRegion(overlay, { width: 3024, height: 1964 })).toEqual({ x: 2816, y: 74, width: 176, height: 176 });
    expect(digitRegion(overlay, { width: 1512, height: 982 })).toEqual({ x: 1408, y: 36, width: 88, height: 88 });
  });
  it("uses the display's own origin on a secondary display", () => {
    expect(digitRegion({ window: { x: -104, y: 12, width: 88, height: 88 }, display: { x: -1920, y: 0, width: 1920, height: 1080 } }, { width: 1920, height: 1080 }))
      .toEqual({ x: 1816, y: 12, width: 88, height: 88 });
  });
});

describe("crop comparison", () => {
  const flat = (value: number, size = 64): Uint8Array => new Uint8Array(size).fill(value);
  it("passes a static dark region and skips the material's flash", () => {
    const result = compareCrops([flat(10), flat(250), flat(11)], [flat(10), flat(250), flat(10)]);
    expect(result).toMatchObject({ judged: 2, pass: true, worst: 1 });
    expect(result.comparisons[1]).toEqual({ frame: 1, skipped: "flash" });
  });
  it("fails when an early frame still carries a faint digit", () => {
    const digit = flat(10);
    for (let i = 0; i < 16; i += 1) digit[i] = 10 + 71;
    const result = compareCrops([digit], [flat(10)]);
    expect(result.worst).toBeGreaterThan(DIGIT_DIFF_THRESHOLD);
    expect(result.pass).toBe(false);
  });
  it("is not a pass when nothing could be judged", () => {
    expect(compareCrops([flat(250)], [flat(250)])).toMatchObject({ judged: 0, pass: false });
  });
});
