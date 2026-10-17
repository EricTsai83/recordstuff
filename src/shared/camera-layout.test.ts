import { describe, expect, it } from "vitest";
import cases from "./camera-layout.cases.json";
import {
  CAMERA_MAX_SIZE, CAMERA_MIN_SIZE, CAMERA_RATIOS, DEFAULT_CAMERA_LAYOUT, DEFAULT_CAMERA_POSITION, MAX_POSITIONS, PRIMARY_DISPLAY_KEY,
  applyRatio, bubbleRadius, bubbleRect, cameraCrop, cameraPosition, copyCameraLayout, insideBubble, isCameraLayout, positionFromRect,
  previewSize, snapPosition, withPosition, type CameraLayout,
} from "./camera-layout";
import { RESOLUTION_CAPS, fitWithinCap } from "./quality";

const layout = (overrides: Partial<CameraLayout> = {}): CameraLayout => ({ ...DEFAULT_CAMERA_LAYOUT, ...overrides });

describe("the cases the engine checks too (camera-layout.cases.json)", () => {
  it("gives every case's rectangle and radius", () => {
    expect(cases.cases.length).toBeGreaterThan(100);
    for (const c of cases.cases) {
      const l = layout(c.layout);
      const rect = bubbleRect(l, c.position, c.frame[0]!, c.frame[1]!);
      expect(rect, `${c.name} at ${JSON.stringify(c.position)} in ${c.frame.join("x")}`).toEqual(c.rect);
      expect(bubbleRadius(l, rect)).toBeCloseTo(c.radius, 9);
    }
    for (const p of cases.previews) expect(previewSize(p.frame[0]!, p.frame[1]!)).toEqual(p.preview);
    for (const c of cases.crops) {
      const crop = cameraCrop(c.camera[0]!, c.camera[1]!, c.bubble[0]!, c.bubble[1]!);
      for (const key of ["x", "y", "width", "height"] as const) expect(crop[key]).toBeCloseTo(c.crop[key], 9);
    }
  });

  it("include a position that lands on half a pixel, where both languages round up", () => {
    expect(cases.cases.some((c) => (c.frame[0]! - c.rect.width) * c.position.x % 1 === 0.5)).toBe(true);
  });
});

describe("bubbleRect", () => {
  it("keeps the bubble inside small, large and portrait frames at every position", () => {
    for (const [w, h] of [[320, 240], [1920, 1080], [3024, 1964], [7680, 4320], [1080, 1920], [3, 2]] as const) {
      for (const size of [CAMERA_MIN_SIZE, 0.2, CAMERA_MAX_SIZE]) {
        for (const position of [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 0.2 }]) {
          const r = bubbleRect(layout({ width: size, height: size }), position, w, h);
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.y).toBeGreaterThanOrEqual(0);
          expect(r.x + r.width).toBeLessThanOrEqual(w);
          expect(r.y + r.height).toBeLessThanOrEqual(h);
          expect(r.width).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it("puts the edges' positions on the edges", () => {
    expect(bubbleRect(layout(), { x: 0, y: 0 }, 1000, 500)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(bubbleRect(layout(), { x: 1, y: 1 }, 1000, 500)).toEqual({ x: 900, y: 400, width: 100, height: 100 });
  });

  it("is the same bubble on the display and in every resolution cap's recording, to within a pixel of each", () => {
    // What the Settings preview draws on the display and where the engine composes it in the capped recording.
    for (const display of [{ width: 3024, height: 1964 }, { width: 3840, height: 2160 }, { width: 5120, height: 2880 }, { width: 1080, height: 1920 }]) {
      for (const cap of RESOLUTION_CAPS) {
        const out = fitWithinCap(display, cap);
        for (const l of [layout(), layout({ width: 0.45, height: 0.15 }), layout({ width: CAMERA_MIN_SIZE, height: CAMERA_MAX_SIZE })]) {
          for (const position of [{ x: 0.97, y: 0.95 }, { x: 0.1, y: 0.6 }]) {
            const shown = bubbleRect(l, position, display.width, display.height);
            const recorded = bubbleRect(l, position, out.width, out.height);
            const scale = display.width / out.width;
            for (const key of ["x", "y", "width", "height"] as const) {
              expect(Math.abs(recorded[key] * scale - shown[key]), `${cap} ${key}`).toBeLessThanOrEqual(scale + 1);
            }
          }
        }
      }
    }
  });
});

describe("rounding (D2)", () => {
  const square = { x: 0, y: 0, width: 100, height: 100 };
  it("is square at 0, rounded at 0.5 and a circle at 1", () => {
    expect(bubbleRadius(layout({ rounding: 0 }), square)).toBe(0);
    expect(bubbleRadius(layout({ rounding: 0.5 }), square)).toBe(25);
    expect(bubbleRadius(layout({ rounding: 1 }), square)).toBe(50);
    expect(insideBubble(square, 0, 0.5, 0.5)).toBe(true);
    expect(insideBubble(square, 25, 2, 2)).toBe(false);
    expect(insideBubble(square, 25, 10, 10)).toBe(true);
    expect(insideBubble(square, 50, 0.5, 0.5)).toBe(false);
    expect(insideBubble(square, 50, 50, 0.5)).toBe(true);
    expect(insideBubble(square, 50, 100, 50)).toBe(false);
  });

  it("follows the shorter side of a wide bubble", () => {
    const wide = { x: 0, y: 0, width: 400, height: 100 };
    expect(bubbleRadius(layout({ rounding: 1 }), wide)).toBe(50);
    expect(insideBubble(wide, 50, 200, 1)).toBe(true);
    expect(insideBubble(wide, 50, 1, 1)).toBe(false);
  });
});

describe("applyRatio", () => {
  it("keeps the width and matches the height for each ratio button", () => {
    for (const ratio of CAMERA_RATIOS) {
      const [w, h] = ratio.split(":").map(Number) as [number, number];
      const shaped = applyRatio(layout({ width: 0.3, height: 0.1 }), ratio);
      expect(shaped.width / shaped.height).toBeCloseTo(w / h, 9);
      expect(shaped.width).toBeCloseTo(0.3, 9);
    }
  });

  it("brings the width in where the height would leave the range", () => {
    const tall = applyRatio(layout({ width: 0.5 }), "3:4");
    expect(tall.height).toBe(CAMERA_MAX_SIZE);
    expect(tall.width / tall.height).toBeCloseTo(3 / 4, 9);
    const flat = applyRatio(layout({ width: CAMERA_MIN_SIZE }), "16:9");
    expect(flat.height).toBe(CAMERA_MIN_SIZE);
    expect(flat.width / flat.height).toBeCloseTo(16 / 9, 9);
  });
});

describe("dragging", () => {
  it("turns a dragged rectangle back into the position it came from", () => {
    const l = layout({ width: 0.3, height: 0.2 });
    for (const position of [{ x: 0, y: 0 }, { x: 0.37, y: 0.81 }, { x: 1, y: 1 }]) {
      const r = bubbleRect(l, position, 1920, 1080);
      const back = positionFromRect(r.x, r.y, r.width, r.height, 1920, 1080);
      expect(bubbleRect(l, back, 1920, 1080)).toEqual(r);
    }
    // Dragged past the frame: held at its edge.
    expect(positionFromRect(-50, 2000, 100, 100, 1000, 500)).toEqual({ x: 0, y: 1 });
    // No free space: the centre.
    expect(positionFromRect(10, 0, 1000, 100, 1000, 500)).toEqual({ x: 0.5, y: 0 });
  });

  it("snaps near the edges and the centre, each axis on its own", () => {
    expect(snapPosition({ x: 0.02, y: 0.985 })).toEqual({ x: 0, y: 1 });
    expect(snapPosition({ x: 0.51, y: 0.4 })).toEqual({ x: 0.5, y: 0.4 });
    expect(snapPosition({ x: 0.2, y: 0.8 })).toEqual({ x: 0.2, y: 0.8 });
  });
});

describe("stored layouts", () => {
  const at = (display: string, x = 0, y = 0) => ({ display, x, y });

  it("accepts the default and refuses values out of range or of the wrong type", () => {
    expect(isCameraLayout(DEFAULT_CAMERA_LAYOUT)).toBe(true);
    expect(isCameraLayout(layout({ positions: [at("primary", 0.2, 1), at("69733632")] }))).toBe(true);
    for (const bad of [null, [], "x", layout({ width: 0.01 }), layout({ height: 0.9 }), layout({ rounding: -0.1 }), layout({ rounding: Number.NaN }),
      { ...DEFAULT_CAMERA_LAYOUT, mirror: "yes" }, { ...DEFAULT_CAMERA_LAYOUT, positions: {} }, layout({ positions: [at("primary", 2, 0)] }),
      layout({ positions: [at("")] }), layout({ positions: [{ x: 0, y: 0 } as never] }), layout({ positions: [at("a"), at("a")] }),
      { width: 0.2, height: 0.2, rounding: 1, mirror: false }]) {
      expect(isCameraLayout(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isCameraLayout(layout({ positions: Array.from({ length: MAX_POSITIONS + 1 }, (_, i) => at(`d${i}`)) }))).toBe(false);
  });

  it("keeps a position per display, the default where none was set, even for an inherited key's name", () => {
    let l = withPosition(DEFAULT_CAMERA_LAYOUT, PRIMARY_DISPLAY_KEY, { x: 0.1, y: 0.2 });
    l = withPosition(l, "69733632", { x: 1.5, y: -1 });
    expect(cameraPosition(l, PRIMARY_DISPLAY_KEY)).toEqual({ x: 0.1, y: 0.2 });
    expect(cameraPosition(l, "69733632")).toEqual({ x: 1, y: 0 });
    for (const key of ["other", "constructor", "__proto__", "toString"]) expect(cameraPosition(l, key)).toEqual(DEFAULT_CAMERA_POSITION);
    expect(DEFAULT_CAMERA_LAYOUT.positions).toEqual([]);
  });

  it("drops the least recently set display, numeric ids included, once MAX_POSITIONS are kept", () => {
    // Electron's display ids are integers: an object would order them by value, not by age.
    let l = DEFAULT_CAMERA_LAYOUT;
    for (let i = 0; i < MAX_POSITIONS; i += 1) l = withPosition(l, String(1000 - i), { x: 0, y: 0 });
    // The first, numerically the largest, is set again and becomes the most recent.
    l = withPosition(l, "1000", { x: 0.5, y: 0.5 });
    l = withPosition(l, "5", { x: 0.1, y: 0.1 });
    expect(l.positions).toHaveLength(MAX_POSITIONS);
    expect(isCameraLayout(l)).toBe(true);
    // "999", set second and never again, is the one dropped.
    expect(l.positions.map((p) => p.display)).not.toContain("999");
    expect(cameraPosition(l, "1000")).toEqual({ x: 0.5, y: 0.5 });
    expect(l.positions.at(-1)).toEqual(at("5", 0.1, 0.1));
  });

  it("never shares a position between the layout it was given and the one it returns", () => {
    const original = layout({ positions: [at("a", 0.1, 0.1)] });
    const moved = withPosition(original, "b", { x: 0.5, y: 0.5 });
    moved.positions[0]!.x = 0.9;
    expect(original.positions[0]!.x).toBe(0.1);
    const copy = copyCameraLayout(original);
    copy.positions[0]!.x = 0.9;
    expect(original.positions[0]!.x).toBe(0.1);
  });
});
