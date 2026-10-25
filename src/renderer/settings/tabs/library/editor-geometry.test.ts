import { describe, expect, it } from "vitest";
import { bubbleRect } from "../../../../shared/camera-layout";
import { resized, resizeTo, smallestLonger } from "./editor-geometry";

const shape = { rounding: 0.5, mirror: false };
const rectOf = (camera: { x: number; y: number; width: number; height: number }) =>
  bubbleRect({ width: camera.width, height: camera.height, ...shape, positions: [] }, camera, 1920, 1080);

describe("the resize handles", () => {
  it("keeps the shape within the size bounds", () => {
    expect(resized(0.2, 0.3, 0.45)).toEqual({ width: 0.3, height: 0.45 });
    expect(resized(0.2, 0.3, 5)).toEqual({ width: 0.4, height: 0.6 });
    expect(Math.max(...Object.values(resized(0.2, 0.3, 0)))).toBeCloseTo(smallestLonger(0.2, 0.3), 4);
  });

  it("grows the bubble from the corner opposite the handle, which stays where it was", () => {
    const camera = { x: 0.97, y: 0.05, width: 0.2, height: 0.3 };
    const before = rectOf(camera);
    // The bottom-left corner's handle, dragged 100 px left and down from it, past the shape: the width rules.
    const next = resizeTo(camera, shape, before.x - 100, before.y + before.height + 50, 1920, 1080, { right: false, bottom: true });
    const after = rectOf(next);
    expect(next.width / next.height).toBeCloseTo(camera.width / camera.height, 3);
    expect(Math.abs(after.x + after.width - (before.x + before.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
    expect(after.width).toBeGreaterThan(before.width + 90);
  });

  it("shrinks the bubble from any corner, the opposite one staying where it was", () => {
    const camera = { x: 0.5, y: 0.5, width: 0.3, height: 0.3 };
    const before = rectOf(camera);
    // The top-left corner's handle, dragged 60 px in towards the middle.
    const next = resizeTo(camera, shape, before.x + 60, before.y + 60, 1920, 1080, { right: false, bottom: false });
    const after = rectOf(next);
    expect(after.width).toBeLessThan(before.width - 50);
    expect(Math.abs(after.x + after.width - (before.x + before.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(after.y + after.height - (before.y + before.height))).toBeLessThanOrEqual(1);
  });
});
