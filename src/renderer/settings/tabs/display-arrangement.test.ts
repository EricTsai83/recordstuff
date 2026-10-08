import { describe, expect, it } from "vitest";
import { placeLabels } from "./display-arrangement";

describe("screen labels", () => {
  it("writes side-by-side screens' names under them, each up to halfway to its neighbour's", () => {
    // A portrait screen at the left, standing higher than the landscape primary beside it (the preview's pair).
    const labels = placeLabels([{ x: 0, y: 0, w: 0.36, h: 1 }, { x: 0.36, y: 0.32, w: 0.64, h: 0.56 }]);
    expect(labels.map((label) => label.place)).toEqual(["below", "below"]);
    // The centres are 0.18 and 0.68 apart by 0.5: each label may take 0.5 less a small gap, in its own screen's widths.
    expect(labels[0]!.maxWidth).toBeCloseTo(0.48 / 0.36);
    expect(labels[1]!.maxWidth).toBeCloseTo(0.48 / 0.64);
  });
  it("writes a screen's name above it when another stands right below, and inside it when boxed in", () => {
    const stacked = placeLabels([{ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 1, h: 0.5 }]);
    expect(stacked.map((label) => label.place)).toEqual(["above", "below"]);
    const boxed = placeLabels([{ x: 0, y: 0, w: 1, h: 0.3 }, { x: 0, y: 0.3, w: 1, h: 0.3 }, { x: 0, y: 0.6, w: 1, h: 0.4 }]);
    expect(boxed.map((label) => label.place)).toEqual(["above", "inside", "below"]);
    expect(boxed[1]!.maxWidth).toBeUndefined();
  });
  it("lets a lone screen's label reach a little past it, and ignores labels on another line", () => {
    const [alone] = placeLabels([{ x: 0, y: 0, w: 1, h: 1 }]);
    expect(alone).toEqual({ place: "below", maxWidth: expect.closeTo(1.18) });
    // A screen far below another: their labels are on different lines and do not narrow each other.
    const apart = placeLabels([{ x: 0, y: 0, w: 0.5, h: 0.2 }, { x: 0.3, y: 0.8, w: 0.5, h: 0.2 }]);
    expect(apart.map((label) => label.place)).toEqual(["below", "below"]);
    expect(apart[0]!.maxWidth).toBeCloseTo((2 * 0.35 - 0.02) / 0.5);
  });
});
