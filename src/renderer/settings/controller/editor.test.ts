// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { EditorView } from "../../../shared/editing";
import { clock, partAt, sameScene, timelineParts } from "./editor";

const editor = (removed: Array<[number, number]>): EditorView => ({
  id: "a", state: "ready", timescale: 90_000, duration: 900_000, seconds: 10, frameRate: 30, removed, skipped: removed, revision: 1, notes: [],
  outputSeconds: 10, exportable: true, export: { phase: "idle" },
});

describe("the timeline's parts", () => {
  it("are cut by the removed ranges and the splits, each kept or removed", () => {
    expect(timelineParts(editor([[90_000, 180_000]]), [450_000])).toEqual([
      { from: 0, to: 90_000, removed: false },
      { from: 90_000, to: 180_000, removed: true },
      { from: 180_000, to: 450_000, removed: false },
      { from: 450_000, to: 900_000, removed: false },
    ]);
  });

  it("take no split within a frame of a cut, or at either end", () => {
    // A frame is 3000 ticks at 30 fps.
    expect(timelineParts(editor([[90_000, 180_000]]), [91_500, 0, 900_000, 178_000])).toHaveLength(3);
    expect(timelineParts(editor([]), [])).toEqual([{ from: 0, to: 900_000, removed: false }]);
  });

  it("find the part at a time, the last one past the end", () => {
    const parts = timelineParts(editor([[90_000, 180_000]]));
    expect(partAt(parts, 100_000)).toEqual({ from: 90_000, to: 180_000, removed: true });
    expect(partAt(parts, 900_000)).toEqual({ from: 180_000, to: 900_000, removed: false });
  });
});

describe("a position on the timeline", () => {
  it("reads as minutes, seconds and a tenth, with hours when there are", () => {
    expect(clock(0)).toBe("0:00.0");
    expect(clock(61.26)).toBe("1:01.3");
    expect(clock(3725.05)).toBe("1:02:05.1");
  });
});

describe("whether two scenes are the same", () => {
  const scene = { camera: { x: 0.97, y: 0.05, width: 0.2, height: 0.3, shown: true }, volumes: { system: 100, microphone: 100 } };

  it("does not depend on the order the keys were written in", () => {
    const reordered = { volumes: { microphone: 100, system: 100 }, camera: { shown: true, height: 0.3, width: 0.2, y: 0.05, x: 0.97 } };
    expect(sameScene(scene, reordered)).toBe(true);
    expect(sameScene(scene, { ...scene, volumes: { system: 100, microphone: 50 } })).toBe(false);
  });

  it("holds for no scene on either side only", () => {
    expect(sameScene(undefined, undefined)).toBe(true);
    expect(sameScene(scene, undefined)).toBe(false);
    expect(sameScene(undefined, scene)).toBe(false);
  });
});
