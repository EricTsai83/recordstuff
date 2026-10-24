/**
 * The edit view's bubble geometry (2026-10-25, at the maintainer's request), in the recording's own pixels: where a
 * dragged bubble snaps, and the size and place a corner handle gives it. Pure, so the page draws and the tests check
 * the same numbers; the shared formulas (camera-layout.ts) place the bubble as the export composes it.
 */
import { bubbleRect, CAMERA_MAX_SIZE, CAMERA_MIN_SIZE, positionFromRect, type CameraPosition, type Rect } from "../../../../shared/camera-layout";

/** The margin a snapped bubble keeps from the picture's edges, as a fraction of its shorter side. */
export const SNAP_MARGIN = 0.04;
/** How near a snap place a bubble's edge or centre must come to be pulled onto it, as a fraction of the shorter side. */
export const SNAP_DISTANCE = 0.02;

/**
 * A bubble whose top-left corner is dropped at (`x`, `y`): on each axis pulled onto the nearer edge's margin or the
 * centre when within the snap distance, then as the position the layout keeps. Holding ⌥ (`free`) places it exactly.
 */
export function snapPlace(x: number, y: number, width: number, height: number, frameWidth: number, frameHeight: number, free = false): CameraPosition {
  if (!free) {
    const shorter = Math.min(frameWidth, frameHeight);
    const margin = Math.round(SNAP_MARGIN * shorter), reach = SNAP_DISTANCE * shorter;
    const snap = (at: number, size: number, frame: number): number => {
      const places = [margin, (frame - size) / 2, frame - size - margin];
      const nearest = places.reduce((best, place) => (Math.abs(place - at) < Math.abs(best - at) ? place : best));
      return Math.abs(nearest - at) <= reach ? nearest : at;
    };
    x = snap(x, width, frameWidth);
    y = snap(y, height, frameHeight);
  }
  return positionFromRect(x, y, width, height, frameWidth, frameHeight);
}

/** Which corner of the bubble its resize handle takes: the one facing the picture's middle, so it grows into the picture. */
export function handleCorner(position: CameraPosition): { right: boolean; bottom: boolean } {
  return { right: position.x <= 0.5, bottom: position.y <= 0.5 };
}

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
 * The bubble a corner handle dragged to (`px`, `py`) makes: the opposite corner stays where it is, the size follows
 * the pointer with the shape kept, and the place is the one that keeps that corner.
 */
export function resizeTo(
  camera: { x: number; y: number; width: number; height: number },
  shape: { rounding: number; mirror: boolean },
  px: number, py: number, frameWidth: number, frameHeight: number,
): { x: number; y: number; width: number; height: number } {
  const layout = { width: camera.width, height: camera.height, rounding: shape.rounding, mirror: shape.mirror, positions: [] };
  const now: Rect = bubbleRect(layout, camera, frameWidth, frameHeight);
  const corner = handleCorner(camera);
  const anchor = { x: corner.right ? now.x : now.x + now.width, y: corner.bottom ? now.y : now.y + now.height };
  const grow = Math.max(Math.abs(px - anchor.x) / now.width, Math.abs(py - anchor.y) / now.height);
  const size = resized(camera.width, camera.height, Math.max(camera.width, camera.height) * grow);
  const next = bubbleRect({ ...layout, ...size }, { x: 0, y: 0 }, frameWidth, frameHeight);
  const left = corner.right ? anchor.x : anchor.x - next.width, top = corner.bottom ? anchor.y : anchor.y - next.height;
  const position = positionFromRect(left, top, next.width, next.height, frameWidth, frameHeight);
  return { x: +position.x.toFixed(4), y: +position.y.toFixed(4), ...size };
}
