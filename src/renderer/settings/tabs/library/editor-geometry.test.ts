import { describe, expect, it } from "vitest";
import { bubbleRect } from "../../../../shared/camera-layout";
import { handleCorner, resized, resizeTo, snapPlace, smallestLonger } from "./editor-geometry";

const shape = { rounding: 0.5, mirror: false };
const rectOf = (camera: { x: number; y: number; width: number; height: number }) =>
  bubbleRect({ width: camera.width, height: camera.height, ...shape, positions: [] }, camera, 1920, 1080);

describe("a dragged bubble", () => {
  // A 300 × 200 bubble in a 1920 × 1080 picture: the margin is 43 px, the snap reach 21.6 px.
  it("snaps onto an edge's margin or the centre when dropped near it", () => {
    const corner = snapPlace(50, 1080 - 200 - 30, 300, 200, 1920, 1080);
    expect(corner.x).toBeCloseTo(43 / (1920 - 300), 6);
    expect(corner.y).toBeCloseTo((1080 - 200 - 43) / (1080 - 200), 6);
    const centre = snapPlace((1920 - 300) / 2 + 15, 300, 300, 200, 1920, 1080);
    expect(centre.x).toBeCloseTo(0.5, 6);
  });

  it("stays where it is dropped away from them, or with ⌥ held", () => {
    expect(snapPlace(400, 300, 300, 200, 1920, 1080)).toEqual({ x: 400 / 1620, y: 300 / 880 });
    expect(snapPlace(50, 30, 300, 200, 1920, 1080, true)).toEqual({ x: 50 / 1620, y: 30 / 880 });
  });
});

describe("the resize handle", () => {
  it("takes the corner facing the picture's middle", () => {
    expect(handleCorner({ x: 0.97, y: 0.05 })).toEqual({ right: false, bottom: true });
    expect(handleCorner({ x: 0.1, y: 0.9 })).toEqual({ right: true, bottom: false });
  });

  it("keeps the shape within the size bounds", () => {
    expect(resized(0.2, 0.3, 0.45)).toEqual({ width: 0.3, height: 0.45 });
    expect(resized(0.2, 0.3, 5)).toEqual({ width: 0.4, height: 0.6 });
    expect(Math.max(...Object.values(resized(0.2, 0.3, 0)))).toBeCloseTo(smallestLonger(0.2, 0.3), 4);
  });

  it("grows the bubble from the corner opposite the handle, which stays where it was", () => {
    const camera = { x: 0.97, y: 0.05, width: 0.2, height: 0.3 };
    const before = rectOf(camera);
    // The handle is the bottom-left corner; dragged 100 px left and down from it, past the shape: the width rules.
    const next = resizeTo(camera, shape, before.x - 100, before.y + before.height + 50, 1920, 1080);
    const after = rectOf(next);
    expect(next.width / next.height).toBeCloseTo(camera.width / camera.height, 3);
    expect(Math.abs(after.x + after.width - (before.x + before.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
    expect(after.width).toBeGreaterThan(before.width + 90);
  });
});
