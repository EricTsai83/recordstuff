import { describe, expect, it } from "vitest";
import { DEFAULT_CAMERA_LAYOUT, DEFAULT_CAMERA_POSITION, bubbleRadius, bubbleRect, insideBubble, type CameraLayout, type CameraPosition } from "../../../src/shared/camera-layout.ts";
import { judgeBubble, judgeVolumes, parseOverallPeak, type RgbFrame } from "./capture-settings.mts";

/** A magenta frame with a grey "camera" bubble drawn by the shared formula, as the engine composes it. */
function frameWith(layout: CameraLayout, position: CameraPosition, width = 640, height = 360, shift = { x: 0, y: 0 }): RgbFrame {
  const data = Buffer.alloc(width * height * 3);
  const bubble = bubbleRect(layout, position, width, height), radius = bubbleRadius(layout, bubble);
  const moved = { ...bubble, x: bubble.x + shift.x, y: bubble.y + shift.y };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 3, inside = insideBubble(moved, radius, x + 0.5, y + 0.5);
    data[at] = inside ? 90 : 250; data[at + 1] = inside ? 110 : 10; data[at + 2] = inside ? 100 : 248;
  }
  return { width, height, data };
}
const passed = (frame: RgbFrame, layout: CameraLayout, position: CameraPosition) => judgeBubble(frame, layout, position).verdicts.map((v) => [v.check, v.pass]);

describe("the camera bubble in a recorded frame", () => {
  const circle: CameraLayout = { width: 0.3, height: 0.3, rounding: 1, mirror: false, positions: [] };
  const bottomLeft = { x: 0.03, y: 0.95 };

  it("passes a bubble drawn where and as the layout says, rounded or nearly square", () => {
    for (const [layout, position] of [[DEFAULT_CAMERA_LAYOUT, DEFAULT_CAMERA_POSITION], [circle, bottomLeft]] as const) {
      const result = judgeBubble(frameWith(layout, position), layout, position);
      expect(result.verdicts.every((v) => v.pass), JSON.stringify(result.verdicts)).toBe(true);
    }
  });

  it("finds the bubble beside the small marks macOS draws over a recording, such as the camera's green dot", () => {
    const frame = frameWith(circle, bottomLeft);
    for (let y = 2; y < 6; y++) for (let x = 630; x < 634; x++) { const at = (y * frame.width + x) * 3; frame.data[at] = 40; frame.data[at + 1] = 200; frame.data[at + 2] = 60; }
    expect(judgeBubble(frame, circle, bottomLeft).verdicts.every((v) => v.pass)).toBe(true);
  });

  it("judges the corners of a well-rounded bubble", () => {
    expect(judgeBubble(frameWith(circle, bottomLeft), circle, bottomLeft).verdicts.some((v) => v.check.startsWith("Corners rounded"))).toBe(true);
  });

  it("fails a bubble elsewhere, a square one where a circle was saved, and a frame without one", () => {
    expect(passed(frameWith(circle, bottomLeft, 640, 360, { x: 12, y: 0 }), circle, bottomLeft)).toContainEqual(["Bubble position and size", false]);
    // The layout the frame was drawn with is square-cornered; the saved one is a circle.
    const square = { ...circle, rounding: 0 };
    expect(passed(frameWith(square, bottomLeft), circle, bottomLeft)).toContainEqual([expect.stringMatching(/^Corners rounded/), false]);
    const empty: RgbFrame = { width: 64, height: 36, data: Buffer.alloc(64 * 36 * 3, 0) };
    for (let i = 0; i < empty.data.length; i += 3) { empty.data[i] = 250; empty.data[i + 2] = 250; }
    expect(passed(empty, circle, bottomLeft)).toContainEqual(["Bubble position and size", false]);
  });

  it("fails a picture drawn beyond the bubble", () => {
    const frame = frameWith(circle, bottomLeft);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) frame.data.fill(0, (y * frame.width + x) * 3, (y * frame.width + x) * 3 + 3);
    expect(passed(frame, circle, bottomLeft)).toContainEqual(["Nothing drawn outside the bubble", false]);
  });
});

describe("the recorded volumes", () => {
  it("reads astats's overall peak, including digital silence", () => {
    const stderr = "[Parsed_astats_0 @ 0x1] Channel: 1\n[Parsed_astats_0 @ 0x1] Peak level dB: -30.0\n[Parsed_astats_0 @ 0x1] Overall\n[Parsed_astats_0 @ 0x1] Peak level dB: -26.123\n";
    expect(parseOverallPeak(stderr)).toBeCloseTo(-26.123);
    expect(parseOverallPeak("[x] Overall\n[x] Peak level dB: -inf\n")).toBe(-Infinity);
    expect(parseOverallPeak("nothing")).toBeUndefined();
  });

  it("passes each volume's change against 100% and fails one that missed it", () => {
    const good = judgeVolumes(new Map([[100, -26], [50, -32.1], [600, -10.3], [0, -Infinity]]));
    expect(good.map((v) => v.pass)).toEqual([true, true, true]);
    // 50% recorded as loud as 100%, and 0% still audible.
    const bad = judgeVolumes(new Map([[100, -26], [50, -26.2], [0, -40]]));
    expect(bad.map((v) => v.pass)).toEqual([false, false]);
    expect(judgeVolumes(new Map([[100, -Infinity], [50, -32]]))[0]!.pass).toBe(false);
  });
});
