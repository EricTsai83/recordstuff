import { describe, expect, it } from "vitest";
import { isPixelRect, isSystemUiChoice, systemUiCrop, type SystemUiChoice } from "./system-ui";

const all: SystemUiChoice = { menuBar: true, dock: true, desktop: true };
const none: SystemUiChoice = { menuBar: false, dock: false, desktop: false };
const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe("systemUiCrop (plan 099)", () => {
  it("cuts the strips measured on the reference Mac (2026-10-29): a 1920 x 1080 display at 1x, menu bar 30 pt, the Dock 57 pt on the right", () => {
    expect(systemUiCrop(rect(0, 0, 1920, 1080), rect(0, 30, 1920, 1050), 1, all)).toEqual(rect(0, 30, 1920, 1050));
    expect(systemUiCrop(rect(0, 0, 1920, 1080), rect(0, 30, 1863, 1050), 1, all)).toEqual(rect(0, 30, 1862, 1050));
    expect(systemUiCrop(rect(0, 0, 1920, 1080), rect(0, 30, 1863, 1050), 1, { ...none, dock: true })).toEqual(rect(0, 0, 1862, 1080));
    // The portrait display beside it, with Displays have separate Spaces on: a menu bar of its own.
    expect(systemUiCrop(rect(-1080, -147, 1080, 1920), rect(-1080, -117, 1080, 1890), 1, all)).toEqual(rect(0, 30, 1080, 1890));
  });

  it("cuts nothing for a part that is recorded, nor when nothing keeps a strip", () => {
    expect(systemUiCrop(rect(0, 0, 1920, 1080), rect(0, 30, 1920, 1050), 1, none)).toBeUndefined();
    expect(systemUiCrop(rect(0, 0, 1920, 1080), rect(0, 30, 1920, 1050), 1, { ...none, dock: true, desktop: true })).toBeUndefined();
    // A menu bar and a Dock set to hide automatically: the work area is the whole display.
    expect(systemUiCrop(rect(0, 0, 1920, 1080), rect(0, 0, 1920, 1080), 1, all)).toBeUndefined();
    // A display with no strip of either: nothing to cut on it.
    expect(systemUiCrop(rect(-1080, -147, 1080, 1920), rect(-1080, -147, 1080, 1920), 1, all)).toBeUndefined();
  });

  it("cuts a notched MacBook's menu bar to a 16:10 picture at 2x", () => {
    expect(systemUiCrop(rect(0, 0, 1512, 982), rect(0, 37, 1512, 945), 2, { ...none, menuBar: true })).toEqual(rect(0, 74, 3024, 1890));
  });

  it("cuts a Dock kept on screen on its edge, only when it is hidden", () => {
    const bounds = rect(0, 0, 2560, 1440);
    const bottom = rect(0, 25, 2560, 1340);
    expect(systemUiCrop(bounds, bottom, 1, { ...none, dock: true })).toEqual(rect(0, 0, 2560, 1364));
    expect(systemUiCrop(bounds, bottom, 1, { ...none, menuBar: true })).toEqual(rect(0, 25, 2560, 1414));
    expect(systemUiCrop(bounds, bottom, 1, all)).toEqual(rect(0, 25, 2560, 1340));
    expect(systemUiCrop(bounds, rect(64, 25, 2496, 1415), 1, all)).toEqual(rect(64, 25, 2496, 1414));
    expect(systemUiCrop(bounds, rect(0, 25, 2496, 1415), 1, all)).toEqual(rect(0, 25, 2496, 1414));
  });

  it("works in the display's own corner for a display away from the origin", () => {
    expect(systemUiCrop(rect(1920, -200, 1440, 900), rect(1920, -175, 1440, 820), 2, all)).toEqual(rect(0, 50, 2880, 1640));
  });

  it("rounds a fractional strip inwards and keeps both sides even", () => {
    const crop = systemUiCrop(rect(0, 0, 1710, 1107), rect(0, 37.5, 1710, 1069.5), 1.5, { ...none, menuBar: true })!;
    expect(crop).toEqual(rect(0, 57, 2564, 1604));
    expect(crop.y + crop.height).toBeLessThanOrEqual(Math.round(1107 * 1.5));
    expect(crop.width % 2 + crop.height % 2).toBe(0);
  });

  it("records the whole display for a work area that cannot be a menu bar's or a Dock's", () => {
    expect(systemUiCrop(rect(0, 0, 1920, 1080), rect(0, 600, 1920, 480), 1, all)).toBeUndefined();
    expect(systemUiCrop(rect(0, 0, 1920, 1080), rect(0, 30, 1920, 1050), 0, all)).toBeUndefined();
    expect(systemUiCrop(rect(0, 0, 1920, 1080), rect(0, -30, 1920, 1200), 1, all)).toBeUndefined();
  });

  it("checks the shapes crossing the protocol", () => {
    expect(isSystemUiChoice(all)).toBe(true);
    expect(isSystemUiChoice({ menuBar: true, dock: 1, desktop: false })).toBe(false);
    expect(isSystemUiChoice(true)).toBe(false);
    expect(isPixelRect(rect(0, 30, 1920, 1050))).toBe(true);
    expect(isPixelRect(rect(-1, 30, 1920, 1050))).toBe(false);
    expect(isPixelRect(rect(0, 30, 1, 1050))).toBe(false);
    expect(isPixelRect(rect(0, 30.5, 1920, 1050))).toBe(false);
  });
});
