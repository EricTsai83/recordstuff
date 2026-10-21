/**
 * Judging for `pnpm acceptance:capture-settings` (2026-10-22): where a recorded frame shows the camera's bubble against
 * the layout the round saved, and how much each saved volume changed the recorded sound against 100%. Pure, so the
 * runner's verdicts are tested on frames and levels made here; the runner records and measures.
 */
import { bubbleRadius, bubbleRect, insideBubble, type CameraLayout, type CameraPosition, type Rect } from "../../../src/shared/camera-layout.ts";
import { volumeDb } from "../../../src/shared/audio-volume.ts";

/** A decoded frame, `rgb24`: three bytes a pixel, rows from the top. */
export interface RgbFrame { width: number; height: number; data: Buffer }

export interface Verdict { check: string; expected: string; actual: string; pass: boolean }

/**
 * The camera material (`scripts/camera-material.html`) is one magenta: a pixel of it, after H.264's 4:2:0 and range
 * conversion, stays strongly red and blue with little green. A camera's picture rarely is.
 */
export function isMaterial(r: number, g: number, b: number): boolean {
  return r > 190 && b > 190 && g < 80;
}

/** Edges may move this far: chroma is shared by 2×2 pixels, and the encoder blurs a hard edge by a pixel or so. */
export const EDGE_TOLERANCE_PX = 3;

/**
 * The rectangle around the largest connected patch of pixels that are not the material: the bubble. Smaller patches
 * are what macOS draws over any recording, such as the green dot it shows while a camera is in use, and are left to
 * the check of what lies outside the bubble.
 */
export function foreignBox(frame: RgbFrame): Rect | undefined {
  const { width, height, data } = frame;
  const seen = new Uint8Array(width * height);
  for (let i = 0; i < seen.length; i++) if (isMaterial(data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!)) seen[i] = 1;
  let best: { size: number; box: Rect } | undefined;
  const stack: number[] = [];
  for (let start = 0; start < seen.length; start++) {
    if (seen[start]) continue;
    seen[start] = 1; stack.push(start);
    let size = 0, left = width, top = height, right = -1, bottom = -1;
    while (stack.length) {
      const i = stack.pop()!, x = i % width, y = (i - x) / width;
      size++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (const next of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1])
        if (next >= 0 && !seen[next]) { seen[next] = 1; stack.push(next); }
    }
    if (!best || size > best.size) best = { size, box: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } };
  }
  return best?.box;
}

/** How much the bubble's picture varies: the standard deviation of its luma, 0 for a flat fill. Reported, not judged. */
export function pictureSpread(frame: RgbFrame, bubble: Rect, radius: number): number {
  let n = 0, sum = 0, squares = 0;
  for (let y = bubble.y; y < bubble.y + bubble.height; y++) for (let x = bubble.x; x < bubble.x + bubble.width; x++) {
    if (!insideBubble(bubble, radius, x + 0.5, y + 0.5)) continue;
    const at = (y * frame.width + x) * 3, luma = 0.2126 * frame.data[at]! + 0.7152 * frame.data[at + 1]! + 0.0722 * frame.data[at + 2]!;
    n++; sum += luma; squares += luma * luma;
  }
  return n ? Math.sqrt(Math.max(0, squares / n - (sum / n) ** 2)) : 0;
}

const grow = (rect: Rect, by: number): Rect => ({ x: rect.x - by, y: rect.y - by, width: rect.width + 2 * by, height: rect.height + 2 * by });

/**
 * The bubble in `frame` against `layout` at `position`: its box, its fill, its rounded corners and the material
 * around it, each with the edge tolerance. The expected bubble is the shared formula the engine composes by.
 */
export function judgeBubble(frame: RgbFrame, layout: CameraLayout, position: CameraPosition): { expected: Rect; radius: number; found?: Rect; spread: number; verdicts: Verdict[] } {
  const expected = bubbleRect(layout, position, frame.width, frame.height);
  const radius = bubbleRadius(layout, expected);
  const found = foreignBox(frame);
  const t = EDGE_TOLERANCE_PX;
  const box = (r: Rect): string => `${r.x},${r.y} ${r.width}×${r.height}`;
  const verdicts: Verdict[] = [];
  const edges = found && [found.x - expected.x, found.y - expected.y, found.x + found.width - expected.x - expected.width, found.y + found.height - expected.y - expected.height];
  verdicts.push({ check: "Bubble position and size", expected: `${box(expected)} (±${t} px each edge)`,
    actual: found ? `${box(found)}` : "no camera picture in the frame", pass: Boolean(edges?.every((d) => Math.abs(d) <= t)) });
  // Pixels well inside the bubble, well outside it, and in the rectangle's corners beyond the rounding.
  const inner = { rect: grow(expected, -t), radius: Math.max(0, radius - t) }, outer = { rect: grow(expected, t), radius: radius + t };
  let fill = 0, fillForeign = 0, corner = 0, cornerMaterial = 0, around = 0, aroundMaterial = 0;
  for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
    const at = (y * frame.width + x) * 3, material = isMaterial(frame.data[at]!, frame.data[at + 1]!, frame.data[at + 2]!);
    const px = x + 0.5, py = y + 0.5;
    if (insideBubble(inner.rect, inner.radius, px, py)) { fill++; if (!material) fillForeign++; continue; }
    if (insideBubble(outer.rect, outer.radius, px, py)) continue;
    const inRect = px >= expected.x && px < expected.x + expected.width && py >= expected.y && py < expected.y + expected.height;
    if (inRect) { corner++; if (material) cornerMaterial++; } else { around++; if (material) aroundMaterial++; }
  }
  const share = (n: number, of: number): string => of ? `${(100 * n / of).toFixed(2)}% of ${of} px` : "no pixels";
  verdicts.push({ check: "Bubble filled with the camera's picture", expected: "≥ 98% of the pixels inside it are not the material",
    actual: share(fillForeign, fill), pass: fill > 0 && fillForeign / fill >= 0.98 });
  // A rounding too small to leave a pixel beyond the tolerance is not judged.
  if (corner >= 10) verdicts.push({ check: `Corners rounded (radius ${radius.toFixed(1)} px)`, expected: "≥ 95% of the rectangle's corner pixels beyond the rounding show the material",
    actual: share(cornerMaterial, corner), pass: cornerMaterial / corner >= 0.95 });
  verdicts.push({ check: "Nothing drawn outside the bubble", expected: "≥ 99.9% of the pixels around it show the material",
    actual: share(aroundMaterial, around), pass: around > 0 && aroundMaterial / around >= 0.999 });
  return { expected, radius, ...(found ? { found } : {}), spread: pictureSpread(frame, expected, radius), verdicts };
}

/** `astats`'s overall `Peak level dB`, or -Infinity for digital silence (`-inf`). */
export function parseOverallPeak(stderr: string): number | undefined {
  const lines = stderr.split("\n");
  const overall = lines.findIndex((line) => /\bOverall\b/.test(line));
  for (const line of overall >= 0 ? lines.slice(overall) : lines) {
    const match = /Peak level dB:\s*(-?inf|-?\d+(?:\.\d+)?)/.exec(line);
    if (match) return /inf/.test(match[1]!) ? -Infinity : Number(match[1]);
  }
  return undefined;
}

/** How far a volume's recording may land from its expected change against 100%: beeps of one level, a dB either way. */
export const VOLUME_TOLERANCE_DB = 1;
/** At or below this, a recording is silent: the engine's silence is −60 dB under material peaking near −26 dBFS. */
export const SILENT_PEAK_DBFS = -70;

/** Each volume's peak against 100%'s: 0% silent, any other the change `volumeDb` gives within the tolerance. */
export function judgeVolumes(peaks: ReadonlyMap<number, number>): Verdict[] {
  const base = peaks.get(100);
  if (base === undefined || !Number.isFinite(base)) return [{ check: "100% recording", expected: "the material's beeps", actual: "silent or missing", pass: false }];
  return [...peaks].filter(([volume]) => volume !== 100).map(([volume, peak]): Verdict => {
    if (volume === 0) return { check: "0%", expected: `peak ≤ ${SILENT_PEAK_DBFS} dBFS (silent)`, actual: Number.isFinite(peak) ? `${peak.toFixed(1)} dBFS` : "digital silence",
      pass: peak <= SILENT_PEAK_DBFS };
    const want = volumeDb(volume), got = peak - base;
    return { check: `${volume}%`, expected: `${want >= 0 ? "+" : ""}${want.toFixed(1)} dB against 100% (±${VOLUME_TOLERANCE_DB})`,
      actual: Number.isFinite(got) ? `${got >= 0 ? "+" : ""}${got.toFixed(1)} dB (peak ${peak.toFixed(1)} dBFS)` : "silent", pass: Math.abs(got - want) <= VOLUME_TOLERANCE_DB };
  });
}
