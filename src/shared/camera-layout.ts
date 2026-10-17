/**
 * The camera bubble's layout (plan 075, step 3): what the user sets, how it is stored, and the geometry the Settings
 * preview draws with. The engine composes with the same formulas (native/capture/src/camera_layout.rs, D2), and
 * camera-layout.cases.json holds the cases both languages' tests check against, so the preview and the recording
 * agree pixel for pixel.
 *
 * Sizes are fractions of the frame's shorter side (D3) and the position a fraction of the free space on each axis, so
 * the same layout fits any display and any resolution cap: no clamping is ever needed after a display or resolution
 * change. The position is kept per display, as a bubble placed clear of one display's content may not be on another's.
 */

export const CAMERA_MIN_SIZE = 0.05;
export const CAMERA_MAX_SIZE = 0.6;
export const CAMERA_PREVIEW_WIDTH = 640;
/** The positions' key for the primary display (DisplayPreference `primary`). */
export const PRIMARY_DISPLAY_KEY = "primary";
/** How close to an edge or the centre, as a fraction of the free space, a dragged bubble snaps to it. */
export const SNAP_DISTANCE = 0.03;
/** At most this many displays' positions are kept; the oldest beyond it are dropped. */
export const MAX_POSITIONS = 16;

export const CAMERA_RATIOS = ["1:1", "4:3", "3:4", "16:9"] as const;
export type CameraRatio = (typeof CAMERA_RATIOS)[number];

export interface CameraPosition {
  /** 0 is the left edge, 1 the right one. */
  x: number;
  /** 0 is the top edge, 1 the bottom one. */
  y: number;
}

/** Where the bubble is on one display: its id, or PRIMARY_DISPLAY_KEY. */
export interface CameraDisplayPosition extends CameraPosition {
  display: string;
}

export interface CameraLayout {
  /** Fractions of the frame's shorter side, CAMERA_MIN_SIZE to CAMERA_MAX_SIZE (D3). */
  width: number;
  height: number;
  /** 0 to 1, 1 being half the bubble's shorter side: a circular arc (D2). */
  rounding: number;
  /** Mirror in recording (D8). */
  mirror: boolean;
  /**
   * Where the bubble is on each display, one entry per display, the most recently set last: a list rather than a map
   * keyed by display, since Electron's display ids are integers, which an object would order by value rather than by
   * age, and a map of strings would also answer for inherited keys such as `constructor`.
   */
  positions: CameraDisplayPosition[];
}

/** A circle a fifth of the shorter side across, near the bottom-right corner, not mirrored (D1, D3, D8). */
export const DEFAULT_CAMERA_POSITION: CameraPosition = { x: 0.97, y: 0.95 };
export const DEFAULT_CAMERA_LAYOUT: CameraLayout = { width: 0.2, height: 0.2, rounding: 1, mirror: false, positions: [] };

/** A rectangle in pixels from the frame's top-left corner. */
export interface Rect { x: number; y: number; width: number; height: number }

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function isCameraPosition(value: unknown): value is CameraPosition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { x, y } = value as Record<string, unknown>;
  return finite(x) && finite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1;
}

/** A display's key: a display id or PRIMARY_DISPLAY_KEY, non-empty and bounded. */
export function isDisplayKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

/** A stored layout: every value a number in its range, at most MAX_POSITIONS positions, one per display. */
export function isCameraLayout(value: unknown): value is CameraLayout {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { width, height, rounding, mirror, positions } = value as Record<string, unknown>;
  const size = (n: unknown): boolean => finite(n) && n >= CAMERA_MIN_SIZE && n <= CAMERA_MAX_SIZE;
  if (!size(width) || !size(height) || !finite(rounding) || rounding < 0 || rounding > 1 || typeof mirror !== "boolean") return false;
  if (!Array.isArray(positions) || positions.length > MAX_POSITIONS) return false;
  const displays = new Set<string>();
  for (const entry of positions as unknown[]) {
    if (!isCameraPosition(entry) || !isDisplayKey((entry as Partial<CameraDisplayPosition>).display)) return false;
    displays.add((entry as CameraDisplayPosition).display);
  }
  return displays.size === positions.length;
}

/** A detached copy, so a caller's later edits never reach what was stored, and the stored one theirs. */
export function copyCameraLayout(layout: CameraLayout): CameraLayout {
  const { width, height, rounding, mirror } = layout;
  return { width, height, rounding, mirror, positions: layout.positions.map(({ display, x, y }) => ({ display, x, y })) };
}

/** The position on `displayKey`'s display, the default where none was set. */
export function cameraPosition(layout: CameraLayout, displayKey: string): CameraPosition {
  const entry = layout.positions.find((position) => position.display === displayKey);
  return entry ? { x: entry.x, y: entry.y } : { ...DEFAULT_CAMERA_POSITION };
}

/**
 * The layout with the bubble at `position` on `displayKey`'s display, which becomes the most recent; at most
 * MAX_POSITIONS displays are kept, the least recently set dropped first.
 */
export function withPosition(layout: CameraLayout, displayKey: string, position: CameraPosition): CameraLayout {
  const copy = copyCameraLayout(layout);
  const others = copy.positions.filter((entry) => entry.display !== displayKey).slice(-(MAX_POSITIONS - 1));
  return { ...copy, positions: [...others, { display: displayKey, x: clamp(position.x, 0, 1), y: clamp(position.y, 0, 1) }] };
}

/**
 * The bubble in a `frameWidth` × `frameHeight` frame: whole pixels, inside the frame. The same formula as the engine's
 * `Layout::bubble`, which rounds half away from zero; every value here is positive, where `Math.round` agrees.
 */
export function bubbleRect(layout: CameraLayout, position: CameraPosition, frameWidth: number, frameHeight: number): Rect {
  const shorter = Math.min(frameWidth, frameHeight);
  const width = clamp(Math.round(clamp(layout.width, CAMERA_MIN_SIZE, CAMERA_MAX_SIZE) * shorter), 1, frameWidth);
  const height = clamp(Math.round(clamp(layout.height, CAMERA_MIN_SIZE, CAMERA_MAX_SIZE) * shorter), 1, frameHeight);
  return {
    x: Math.round((frameWidth - width) * clamp(position.x, 0, 1)),
    y: Math.round((frameHeight - height) * clamp(position.y, 0, 1)),
    width,
    height,
  };
}

/** The corner radius of `bubble`, in its pixels: a circular arc, at most half its shorter side (D2). */
export function bubbleRadius(layout: CameraLayout, bubble: Rect): number {
  return clamp(layout.rounding, 0, 1) * Math.min(bubble.width, bubble.height) / 2;
}

/** Whether the pixel centre (`px`, `py`) is inside `bubble` with corners of `radius`: D2's formula. */
export function insideBubble(bubble: Rect, radius: number, px: number, py: number): boolean {
  const right = bubble.x + bubble.width, bottom = bubble.y + bubble.height;
  if (px < bubble.x || px >= right || py < bubble.y || py >= bottom) return false;
  const r = Math.max(0, Math.min(radius, bubble.width / 2, bubble.height / 2));
  const dx = px - clamp(px, bubble.x + r, right - r);
  const dy = py - clamp(py, bubble.y + r, bottom - r);
  return dx * dx + dy * dy <= r * r;
}

/** The centred part of a `cameraWidth` × `cameraHeight` picture that covers a bubble of `width` × `height`. */
export function cameraCrop(cameraWidth: number, cameraHeight: number, width: number, height: number): Rect {
  if (cameraWidth <= 0 || cameraHeight <= 0 || width <= 0 || height <= 0) return { x: 0, y: 0, width: cameraWidth, height: cameraHeight };
  const scale = Math.max(width / cameraWidth, height / cameraHeight);
  const cropWidth = width / scale, cropHeight = height / scale;
  return { x: (cameraWidth - cropWidth) / 2, y: (cameraHeight - cropHeight) / 2, width: cropWidth, height: cropHeight };
}

/** The preview's size for a `width` × `height` output: CAMERA_PREVIEW_WIDTH wide or the output's own, even. */
export function previewSize(width: number, height: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 2, height: 2 };
  const target = Math.min(CAMERA_PREVIEW_WIDTH, width);
  const scaled = Math.floor(height * target / width);
  return { width: Math.max(2, target - (target % 2)), height: Math.max(2, scaled - (scaled % 2)) };
}

/**
 * The position that puts a bubble of `width` × `height` with its top-left corner at (`x`, `y`) in the frame: what a
 * drag reports. A bubble as large as the frame on an axis has no free space there and keeps the centre.
 */
export function positionFromRect(x: number, y: number, width: number, height: number, frameWidth: number, frameHeight: number): CameraPosition {
  const free = (frame: number, size: number, at: number): number => (frame - size > 0 ? clamp(at / (frame - size), 0, 1) : 0.5);
  return { x: free(frameWidth, width, x), y: free(frameHeight, height, y) };
}

/** A position near an edge or the centre, within SNAP_DISTANCE of it, moved onto it; each axis on its own. */
export function snapPosition(position: CameraPosition, distance = SNAP_DISTANCE): CameraPosition {
  const snap = (value: number): number => [0, 0.5, 1].find((target) => Math.abs(value - target) <= distance) ?? value;
  return { x: snap(position.x), y: snap(position.y) };
}

/**
 * The layout with the bubble's shape `ratio` (width:height): the width kept and the height made to match, or, where
 * that height is out of range, the height at its bound and the width made to match. Both sizes are fractions of the
 * same shorter side, so the shape is the same on every display.
 */
export function applyRatio(layout: CameraLayout, ratio: CameraRatio): CameraLayout {
  const [w, h] = ratio.split(":").map(Number) as [number, number];
  let width = clamp(layout.width, CAMERA_MIN_SIZE, CAMERA_MAX_SIZE);
  let height = width * h / w;
  if (height > CAMERA_MAX_SIZE) { height = CAMERA_MAX_SIZE; width = height * w / h; }
  if (height < CAMERA_MIN_SIZE) { height = CAMERA_MIN_SIZE; width = height * w / h; }
  return { ...copyCameraLayout(layout), width: clamp(width, CAMERA_MIN_SIZE, CAMERA_MAX_SIZE), height: clamp(height, CAMERA_MIN_SIZE, CAMERA_MAX_SIZE) };
}
