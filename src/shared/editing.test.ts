import { describe, expect, it } from "vitest";
import { MAX_EDIT_RANGES, isEditorChoice, isExportHostMessage, isExportMainMessage, normalizeRanges } from "./editing";

const plan = {
  timescale: 90_000, duration: 900_000, outputDuration: 600_000, frames: 300,
  removed: [{ from: 90_000, to: 390_000 }], dropped: [],
  parts: [{ requested: 0, start: 0, stop: 90_000, outStart: 0, fellBack: false, reencoded: false }],
  secondDescription: false, hasAudio: true,
};

describe("edit ranges", () => {
  it("are sorted and merged, empty ones dropped", () => {
    expect(normalizeRanges([[50, 60], [10, 20], [15, 30], [40, 40], [60, 70]])).toEqual([[10, 30], [50, 70]]);
    expect(normalizeRanges([])).toEqual([]);
  });
});

describe("the worker's messages", () => {
  it("are taken only in the shapes the worker sends", () => {
    expect(isExportHostMessage({ type: "ready" })).toBe(true);
    expect(isExportHostMessage({ type: "inspected", id: 1, plan })).toBe(true);
    expect(isExportHostMessage({ type: "exported", id: 2, result: { plan, bytes: 10, reencodedFrames: 3, reencodedPackets: 4 } })).toBe(true);
    expect(isExportHostMessage({ type: "progress", id: 2, fraction: 0.5 })).toBe(true);
    expect(isExportHostMessage({ type: "failed", id: 2, code: "disk_full", detail: "no space" })).toBe(true);
    // Out of range, unknown codes, missing fields and other shapes are dropped.
    expect(isExportHostMessage({ type: "progress", id: 2, fraction: 1.5 })).toBe(false);
    expect(isExportHostMessage({ type: "failed", id: 2, code: "rm_rf", detail: "" })).toBe(false);
    expect(isExportHostMessage({ type: "inspected", id: 1, plan: { ...plan, timescale: 0 } })).toBe(false);
    expect(isExportHostMessage({ type: "inspected", id: -1, plan })).toBe(false);
    expect(isExportHostMessage({ type: "exported", id: 2, result: { plan, bytes: -1, reencodedFrames: 0, reencodedPackets: 0 } })).toBe(false);
    expect(isExportHostMessage(null)).toBe(false);
    expect(isExportHostMessage({ type: "shell", command: "ls" })).toBe(false);
  });

  it("from main are checked by the worker too", () => {
    const request = { source: "/a.mp4", removed: [{ from: 0, to: 10 }] };
    expect(isExportMainMessage({ type: "inspect", id: 1, request })).toBe(true);
    expect(isExportMainMessage({ type: "export", id: 1, request: { ...request, output: "/.a.part" } })).toBe(true);
    expect(isExportMainMessage({ type: "cancel" })).toBe(true);
    expect(isExportMainMessage({ type: "export", id: 1, request: { ...request, output: 5 } })).toBe(false);
    const many = Array.from({ length: MAX_EDIT_RANGES + 1 }, (_, n) => ({ from: n * 2, to: n * 2 + 1 }));
    expect(isExportMainMessage({ type: "inspect", id: 1, request: { source: "/a.mp4", removed: many } })).toBe(false);
  });
});

describe("the edit view's choices", () => {
  it("carry whole, increasing ranges and a revision", () => {
    expect(isEditorChoice({ action: "save", removed: [[0, 10], [20, 30]], revision: 3 })).toBe(true);
    expect(isEditorChoice({ action: "export" })).toBe(true);
    expect(isEditorChoice({ action: "save", removed: [[10, 5]], revision: 3 })).toBe(false);
    expect(isEditorChoice({ action: "save", removed: [[0.5, 5]], revision: 3 })).toBe(false);
    expect(isEditorChoice({ action: "save", removed: [[0, 5]] })).toBe(false);
    expect(isEditorChoice({ action: "delete" })).toBe(false);
  });
});
