import { describe, expect, it } from "vitest";
import { exportsOf, recordingName, roundWindowFrame } from "./edit-view-prep.mts";

describe("the window's place for an edit-view round", () => {
  it("goes on the display that is not the main one, converted from Cocoa's bottom-up coordinates", () => {
    // The maintainer's displays: a 1920×1080 main one, a 1080×1920 portrait one to its left reaching 693 below it.
    const frame = roundWindowFrame([
      { x: 0, y: 0, width: 1920, height: 1080, main: true },
      { x: -1080, y: -693, width: 1080, height: 1920, main: false },
    ]);
    // Its top is 147 above the main display's top: the window 30 under that, 10 in from its left.
    expect(frame).toEqual({ x: -1070, y: -117, width: 1060, height: 1400 });
  });

  it("stays on the main display when it is the only one, within it", () => {
    expect(roundWindowFrame([{ x: 0, y: 0, width: 1440, height: 900, main: true }])).toEqual({ x: 10, y: 30, width: 1060, height: 860 });
  });
});

describe("a round's leftovers", () => {
  it("are a copy's exports in either language, numbered or not, and nothing else", () => {
    const names = ["2026-10-26 14-40-00.mp4", "2026-10-26 14-40-00（已編輯）.mp4", "2026-10-26 14-40-00（已編輯 2）.mp4",
      "2026-10-26 14-40-00 (edited).mp4", "2026-10-26 14-40-00 (edited 3).mp4", "2026-10-26 14-40-001.mp4", "2026-10-26 14-40-00 talk.mp4"];
    expect(exportsOf("2026-10-26 14-40-00", names)).toEqual(names.slice(1, 5));
    // A name with characters a pattern would read otherwise.
    expect(exportsOf("a+b (1)", ["a+b (1) (edited).mp4", "aab (1) (edited).mp4"])).toEqual(["a+b (1) (edited).mp4"]);
  });

  it("names a copy as the recorder names a recording", () => {
    expect(recordingName(new Date(2026, 9, 26, 9, 5, 7))).toBe("2026-10-26 09-05-07.mp4");
  });
});
