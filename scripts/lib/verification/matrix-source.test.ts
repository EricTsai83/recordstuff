import { describe, expect, it } from "vitest";
import { matrixSourceSettings, matrixSourceSize, type MatrixDisplay } from "./matrix-source.mts";
import { parseSettings, SETTINGS_VERSION } from "../../../src/main/settings/settings";

const primary: MatrixDisplay = { id: "3", bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1050 }, scaleFactor: 1 };

describe("matrix's independent recording source", () => {
  it("matches production settings migration, validation and defaults", () => {
    expect(SETTINGS_VERSION).toBe(5);
    const cases = [
      { version: 5, outputDir: "/tmp/out", hideMenuBar: true, hideDock: false },
      { version: 4, outputDir: "/tmp/out", hideSystemUi: true, hideDock: false },
      { version: 4, outputDir: "/tmp/out", hideSystemUi: "bad", hideMenuBar: true },
      { version: 99, outputDir: "/tmp/out", hideDock: true },
      { version: 5, outputDir: "relative", hideMenuBar: true },
      { version: 5, outputDir: "/tmp/out", display: { kind: "display", id: "2", label: "Portrait" }, hideDock: true },
      { version: 5, outputDir: "/tmp/out", display: { kind: "display", id: "bad", label: "Invalid" }, hideMenuBar: "true" },
    ].map(v => JSON.stringify(v)).concat("malformed", "null", "[]");
    for (const text of cases) {
      const parsed = parseSettings(text, "darwin")?.settings;
      const expected = parsed ? { display: parsed.display, hideMenuBar: parsed.hideMenuBar,
        hideDock: parsed.hideDock, hideDesktop: parsed.hideDesktop } : {};
      expect(matrixSourceSettings(text)).toEqual(expected);
    }
  });
  it("keeps the full screen unless its reserved strip is hidden", () => {
    expect(matrixSourceSize([primary], {})).toEqual({ width: 1920, height: 1080 });
    expect(matrixSourceSize([primary], { hideMenuBar: true })).toEqual({ width: 1920, height: 1050 });
    expect(matrixSourceSize([primary], { hideDock: true })).toEqual({ width: 1920, height: 1080 });
  });
  it("cuts a bottom or side Dock separately from the menu bar at HiDPI scale", () => {
    const bottom = { ...primary, workArea: { x: 0, y: 60, width: 1920, height: 990 }, scaleFactor: 2 };
    expect(matrixSourceSize([bottom], { hideDock: true })).toEqual({ width: 3840, height: 2040 });
    expect(matrixSourceSize([bottom], { hideDock: true, hideMenuBar: true })).toEqual({ width: 3840, height: 1980 });
    expect(matrixSourceSize([{ ...primary, workArea: { x: 70, y: 0, width: 1850, height: 1050 } }],
      { hideDock: true })).toEqual({ width: 1850, height: 1080 });
  });
  it("selects a portrait display at a negative origin, and falls back to primary for a missing id", () => {
    const secondary = { id: "2", bounds: { x: -1080, y: -693, width: 1080, height: 1920 },
      workArea: { x: -1080, y: -693, width: 1080, height: 1920 }, scaleFactor: 1 };
    expect(matrixSourceSize([primary, secondary], { display: { kind: "display", id: "2" }, hideMenuBar: true }))
      .toEqual({ width: 1080, height: 1920 });
    expect(matrixSourceSize([primary], { display: { kind: "display", id: "missing" } })).toEqual({ width: 1920, height: 1080 });
  });
  it("handles auto-hidden chrome, rejects missing/invalid geometry, and shares inward even rounding", () => {
    expect(matrixSourceSize([{ ...primary, workArea: primary.bounds }], { hideMenuBar: true, hideDock: true }))
      .toEqual({ width: 1920, height: 1080 });
    expect(matrixSourceSize([{ ...primary, scaleFactor: 1.5 }], { hideMenuBar: true })).toEqual({ width: 2880, height: 1574 });
    expect(() => matrixSourceSize([], {})).toThrow("no display geometry");
    expect(() => matrixSourceSize([{ ...primary, scaleFactor: NaN }], {})).toThrow("invalid display geometry");
  });
});
