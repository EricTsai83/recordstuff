/**
 * The edit view's bubble geometry (2026-10-25, at the maintainer's request), in the recording's own pixels: the size
 * and place a corner handle gives the bubble. A dragged bubble does not snap; it stays where it is dropped. Pure, so the page draws and the tests check
 * the same numbers; the shared formulas (camera-layout.ts) place the bubble as the export composes it.
 */
import { bubbleRect, CAMERA_MAX_SIZE, CAMERA_MIN_SIZE, positionFromRect, type Rect } from "../../../../shared/camera-layout";

/** A corner of the bubble's box: where a resize handle is. */
export interface Corner { right: boolean; bottom: boolean }

/** The bubble's four corners, each with a resize handle while the bubble is selected (2026-10-25). */
export const CORNERS: readonly Corner[] = [
  { right: false, bottom: false }, { right: true, bottom: false }, { right: false, bottom: true }, { right: true, bottom: true },
];


/** The smallest longer side a bubble of this shape can have: its shorter side still the layout's minimum. */
export function smallestLonger(width: number, height: number): number {
  const ratio = height / width;
  return CAMERA_MIN_SIZE * Math.max(ratio, 1 / ratio);
}

/** A bubble of `width` × `height` (layout fractions) with its longer side `longer`, its shape kept and within the bounds. */
export function resized(width: number, height: number, longer: number): { width: number; height: number } {
  const ratio = height / width;
  const side = Math.min(CAMERA_MAX_SIZE, Math.max(smallestLonger(width, height), longer));
  const w = ratio >= 1 ? side / ratio : side, h = ratio >= 1 ? side : side * ratio;
  return { width: +w.toFixed(4), height: +h.toFixed(4) };
}

/**
 * The bubble the handle on `corner` dragged to (`px`, `py`) makes: the opposite corner stays where it is, the size
 * follows the pointer with the shape kept, and the place is the one that keeps that corner.
 */
export function resizeTo(
  camera: { x: number; y: number; width: number; height: number },
  shape: { rounding: number; mirror: boolean },
  px: number, py: number, frameWidth: number, frameHeight: number, corner: Corner,
): { x: number; y: number; width: number; height: number } {
  const layout = { width: camera.width, height: camera.height, rounding: shape.rounding, mirror: shape.mirror, positions: [] };
  const now: Rect = bubbleRect(layout, camera, frameWidth, frameHeight);
  const anchor = { x: corner.right ? now.x : now.x + now.width, y: corner.bottom ? now.y : now.y + now.height };
  const grow = Math.max(Math.abs(px - anchor.x) / now.width, Math.abs(py - anchor.y) / now.height);
  const size = resized(camera.width, camera.height, Math.max(camera.width, camera.height) * grow);
  const next = bubbleRect({ ...layout, ...size }, { x: 0, y: 0 }, frameWidth, frameHeight);
  const left = corner.right ? anchor.x : anchor.x - next.width, top = corner.bottom ? anchor.y : anchor.y - next.height;
  const position = positionFromRect(left, top, next.width, next.height, frameWidth, frameHeight);
  return { x: +position.x.toFixed(4), y: +position.y.toFixed(4), ...size };
}
