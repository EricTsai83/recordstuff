/**
 * Judging for `pnpm acceptance:editor` (plan 087's follow-up, 2026-10-25): an editable recording's description read
 * from its file, where a drag must start and end to put the camera's bubble at a chosen place, what the edit record
 * says after each operation, and whether an export's frame holds the camera's own picture where the scene put it and
 * the screen's everywhere else. Pure, so the verdicts are tested on frames and records made here; the runner records,
 * operates the app and extracts the frames.
 */
import { bubbleRect, cameraCrop, insideBubble, bubbleRadius, type CameraLayout, type CameraPosition, type Rect } from "../../../src/shared/camera-layout.ts";
// Types only: editable.ts imports without extensions, which Node's own TypeScript loading cannot follow.
import type { EditableDescription, EditScene, SceneCamera } from "../../../src/shared/editable.ts";
import type { RgbFrame, Verdict } from "./capture-settings.mts";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A description's JSON as the engine writes it (version 1); the app checks it fully (shared/editable.ts). */
function parseDescription(text: string): EditableDescription | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!isObject(value) || value["version"] !== 1 || !Array.isArray(value["sounds"])) return undefined;
  const sounds = value["sounds"] as unknown[];
  if (!sounds.every((s) => s === "system" || s === "microphone" || s === "silent")) return undefined;
  const camera = value["camera"];
  if (camera === null || camera === undefined) return { sounds: sounds as EditableDescription["sounds"], camera: null };
  if (!isObject(camera) || !["width", "height", "rounding", "x", "y"].every((k) => finite(camera[k])) || typeof camera["mirror"] !== "boolean") return undefined;
  return { sounds: sounds as EditableDescription["sounds"], camera: camera as unknown as NonNullable<EditableDescription["camera"]> };
}

/** An edit record's scene in the shape versions 2 and 3 write (3 adds the camera's hidden stretches, `camera.hidden`). */
function isScene(value: unknown): value is EditScene {
  if (!isObject(value) || !isObject(value["volumes"]) || !finite(value["volumes"]["system"]) || !finite(value["volumes"]["microphone"])) return false;
  const camera = value["camera"];
  return camera === undefined || (isObject(camera) && ["x", "y", "width", "height"].every((k) => finite(camera[k])) && typeof camera["shown"] === "boolean");
}

/**
 * The description an editable recording carries in `moov/udta/rsed` (native/capture/src/editable.rs), or undefined
 * when the file has none: the box's 32-bit size, its type, then the JSON. The last such box wins, as a file is written
 * front to back and its `moov` comes last.
 */
export function readEditableDescription(file: Buffer): EditableDescription | undefined {
  let found: EditableDescription | undefined;
  for (let at = file.indexOf("rsed"); at >= 4; at = file.indexOf("rsed", at + 4)) {
    const size = file.readUInt32BE(at - 4);
    if (size < 8 || at - 4 + size > file.length) continue;
    const parsed = parseDescription(file.subarray(at + 4, at - 4 + size).toString("utf8"));
    if (parsed) found = parsed;
  }
  return found;
}

/** A point on the screen, in the global coordinates CoreGraphics events use. */
export interface Point { x: number; y: number }

/** The camera's layout for the shared formulas: the scene's size and the recording's shape, as the edit view draws it. */
export function sceneLayout(camera: Pick<SceneCamera, "width" | "height">, shape: { rounding: number; mirror: boolean }): CameraLayout {
  return { width: camera.width, height: camera.height, rounding: shape.rounding, mirror: shape.mirror, positions: [] };
}

/**
 * Where to press and let go to drag the bubble, now drawn at `drawn` on the screen for `from` in a `width` × `height`
 * picture, so that it lands at `to`: the picture's scale and origin on the screen follow from the drawn bubble, and
 * the press is the bubble's centre, so the grip keeps its place in the bubble.
 */
export function dragFor(drawn: Rect, layout: CameraLayout, from: CameraPosition, to: CameraPosition, width: number, height: number): { start: Point; end: Point } {
  const now = bubbleRect(layout, from, width, height), next = bubbleRect(layout, to, width, height);
  const scale = drawn.width / now.width;
  const start = { x: drawn.x + drawn.width / 2, y: drawn.y + drawn.height / 2 };
  return { start: { x: Math.round(start.x), y: Math.round(start.y) }, end: { x: Math.round(start.x + (next.x - now.x) * scale), y: Math.round(start.y + (next.y - now.y) * scale) } };
}

/** The scene an edit record holds, or undefined for a record without one or not one at all. */
export function recordScene(text: string): { revision: number; scene: EditScene } | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (typeof value !== "object" || value === null) return undefined;
  const { revision, scene } = value as { revision?: unknown; scene?: unknown };
  return typeof revision === "number" && isScene(scene) ? { revision, scene } : undefined;
}

/** How far a dragged position may land from the one aimed at: a drag moves by whole pixels of a scaled-down picture. */
export const POSITION_TOLERANCE = 0.03;

/** The dragged bubble against the place aimed at, each axis within the tolerance. */
export function judgePlace(camera: SceneCamera | undefined, aimed: CameraPosition): Verdict {
  const actual = camera ? `${camera.x.toFixed(3)}, ${camera.y.toFixed(3)}` : "no camera in the scene";
  const pass = Boolean(camera && Math.abs(camera.x - aimed.x) <= POSITION_TOLERANCE && Math.abs(camera.y - aimed.y) <= POSITION_TOLERANCE);
  return { check: "Drag: the bubble saved where it was dropped", expected: `${aimed.x.toFixed(3)}, ${aimed.y.toFixed(3)} (±${POSITION_TOLERANCE})`, actual, pass };
}

/** A resize by the size slider: smaller by about the steps pressed, its shape kept. */
export function judgeResize(before: SceneCamera, after: SceneCamera | undefined, steps: number): Verdict {
  const longer = (c: Pick<SceneCamera, "width" | "height">): number => Math.max(c.width, c.height);
  const ratio = (c: Pick<SceneCamera, "width" | "height">): number => c.height / c.width;
  if (!after) return { check: "Resize: the size slider", expected: "a camera in the scene", actual: "none", pass: false };
  const change = Math.round((longer(before) - longer(after)) * 100);
  const shape = Math.abs(ratio(after) / ratio(before) - 1);
  return {
    check: `Resize: ${steps} steps down on the size slider`,
    expected: `the longer side ${steps} points smaller (±1), the shape kept within 1%`,
    actual: `${Math.round(longer(before) * 100)}% → ${Math.round(longer(after) * 100)}%, shape ${(shape * 100).toFixed(2)}% off`,
    pass: Math.abs(change - steps) <= 1 && shape <= 0.01,
  };
}

const luma = (frame: RgbFrame, x: number, y: number): number => {
  const at = (y * frame.width + x) * 3;
  return 0.2126 * frame.data[at]! + 0.7152 * frame.data[at + 1]! + 0.0722 * frame.data[at + 2]!;
};
const grow = (rect: Rect, by: number): Rect => ({ x: rect.x - by, y: rect.y - by, width: rect.width + 2 * by, height: rect.height + 2 * by });

/** Below this standard deviation of its luma a camera's picture is too flat (a covered lens, a dark room) to recognise. */
export const MIN_CAMERA_SPREAD = 8;
/** The export's bubble against the camera's own picture, cropped and scaled as composed: Pearson's r at least this. */
export const MIN_CAMERA_CORRELATION = 0.6;
/** Outside the bubble the export is the screen's picture encoded again: the mean luma difference at most this. */
export const MAX_SCREEN_DIFFERENCE = 6;
/** Pixels this far either side of the bubble's edge are left out: the encoder blurs a hard edge. */
export const EDGE_MARGIN_PX = 4;

export interface Composite { bubble: Rect; cameraSpread: number; correlation?: number; screenDifference: number; verdicts: Array<Verdict & { judged: boolean }> }

/**
 * An export's frame against the source's screen and camera pictures of the same time, for a bubble of `layout` at
 * `position`: inside it the camera's picture, centre-cropped to the bubble's shape (mirrored when the recording
 * mirrors it) as the compositor draws it, recognised by correlation; outside it the screen's. A camera too flat to
 * recognise leaves the inside unjudged, said so, rather than passed or failed.
 */
export function judgeComposite(output: RgbFrame, screen: RgbFrame, camera: RgbFrame, layout: CameraLayout, position: CameraPosition): Composite {
  const bubble = bubbleRect(layout, position, output.width, output.height);
  const radius = bubbleRadius(layout, bubble);
  const crop = cameraCrop(camera.width, camera.height, bubble.width, bubble.height);
  const inner = { rect: grow(bubble, -EDGE_MARGIN_PX), radius: Math.max(0, radius - EDGE_MARGIN_PX) };
  const outer = { rect: grow(bubble, EDGE_MARGIN_PX), radius: radius + EDGE_MARGIN_PX };
  const pairs: Array<[number, number]> = [];
  let cameraSum = 0, cameraSquares = 0;
  for (let y = Math.max(0, inner.rect.y); y < Math.min(output.height, inner.rect.y + inner.rect.height); y += 2) {
    for (let x = Math.max(0, inner.rect.x); x < Math.min(output.width, inner.rect.x + inner.rect.width); x += 2) {
      if (!insideBubble(inner.rect, inner.radius, x + 0.5, y + 0.5)) continue;
      let u = (x + 0.5 - bubble.x) / bubble.width;
      const v = (y + 0.5 - bubble.y) / bubble.height;
      if (layout.mirror) u = 1 - u;
      const cx = Math.min(camera.width - 1, Math.max(0, Math.floor(crop.x + u * crop.width)));
      const cy = Math.min(camera.height - 1, Math.max(0, Math.floor(crop.y + v * crop.height)));
      const c = luma(camera, cx, cy);
      cameraSum += c; cameraSquares += c * c;
      pairs.push([luma(output, x, y), c]);
    }
  }
  const n = pairs.length;
  const cameraSpread = n ? Math.sqrt(Math.max(0, cameraSquares / n - (cameraSum / n) ** 2)) : 0;
  let correlation: number | undefined;
  if (n && cameraSpread >= MIN_CAMERA_SPREAD) {
    const mean = (k: 0 | 1): number => pairs.reduce((s, p) => s + p[k], 0) / n;
    const ma = mean(0), mb = mean(1);
    let ab = 0, aa = 0, bb = 0;
    for (const [a, b] of pairs) { ab += (a - ma) * (b - mb); aa += (a - ma) ** 2; bb += (b - mb) ** 2; }
    correlation = aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
  }
  let outside = 0, difference = 0;
  for (let y = 0; y < output.height; y += 2) for (let x = 0; x < output.width; x += 2) {
    if (insideBubble(outer.rect, outer.radius, x + 0.5, y + 0.5)) continue;
    outside++; difference += Math.abs(luma(output, x, y) - luma(screen, x, y));
  }
  const screenDifference = outside ? difference / outside : Infinity;
  const box = `${bubble.x},${bubble.y} ${bubble.width}×${bubble.height}`;
  const verdicts: Composite["verdicts"] = [
    correlation === undefined
      ? { check: `Export: the camera's picture in the bubble at ${box}`, expected: `correlation with the camera track ≥ ${MIN_CAMERA_CORRELATION}`,
        actual: `not judged: the camera's picture is flat (luma spread ${cameraSpread.toFixed(1)} < ${MIN_CAMERA_SPREAD}); a covered lens or a dark room`, pass: false, judged: false }
      : { check: `Export: the camera's picture in the bubble at ${box}`, expected: `correlation with the camera track ≥ ${MIN_CAMERA_CORRELATION}`,
        actual: `r = ${correlation.toFixed(3)} over ${n} px (camera spread ${cameraSpread.toFixed(1)})`, pass: correlation >= MIN_CAMERA_CORRELATION, judged: true },
    { check: "Export: the screen's picture everywhere else", expected: `mean luma difference from the screen track ≤ ${MAX_SCREEN_DIFFERENCE}`,
      actual: `${screenDifference.toFixed(2)} over ${outside} px`, pass: screenDifference <= MAX_SCREEN_DIFFERENCE, judged: true },
  ];
  return { bubble, cameraSpread, ...(correlation === undefined ? {} : { correlation }), screenDifference, verdicts };
}

/**
 * A frame the camera is hidden in (2026-10-26): the screen's picture everywhere, the bubble's place included, so no
 * camera picture was composed there.
 */
export function judgeScreenOnly(output: RgbFrame, screen: RgbFrame, layout: CameraLayout, position: CameraPosition, at: number): Verdict & { judged: boolean } {
  const bubble = grow(bubbleRect(layout, position, output.width, output.height), -EDGE_MARGIN_PX);
  let inside = 0, insideDifference = 0, all = 0, difference = 0;
  for (let y = 0; y < output.height; y += 2) for (let x = 0; x < output.width; x += 2) {
    const d = Math.abs(luma(output, x, y) - luma(screen, x, y));
    all++; difference += d;
    if (x >= bubble.x && x < bubble.x + bubble.width && y >= bubble.y && y < bubble.y + bubble.height) { inside++; insideDifference += d; }
  }
  const whole = all ? difference / all : Infinity, place = inside ? insideDifference / inside : Infinity;
  return { check: `Export: the camera left out at ${at.toFixed(2)} s, in a stretch it is hidden over`, expected: `the screen's picture in the bubble's place and everywhere else, mean luma difference ≤ ${MAX_SCREEN_DIFFERENCE}`,
    actual: `${place.toFixed(2)} in the bubble's place over ${inside} px, ${whole.toFixed(2)} over the frame`, pass: place <= MAX_SCREEN_DIFFERENCE && whole <= MAX_SCREEN_DIFFERENCE, judged: true };
}

/** Seconds from the edit view's clock, `m:ss.ss` or `m:ss` (as the player shows it), or undefined. */
export function clockSeconds(text: string): number | undefined {
  const match = /(\d+):(\d{2}(?:\.\d+)?)/.exec(text);
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}
