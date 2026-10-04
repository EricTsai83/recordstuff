import { describe, expect, it } from "vitest";
import type { RecordingState } from "../shared/state";
import { abbreviateHome, preferencesUnlocked } from "./ui-model";

describe("abbreviateHome", () => {
  it("replaces the home prefix on both path styles", () => {
    expect(abbreviateHome("/Users/eric/Movies/RecordStuff", "/Users/eric")).toBe("~/Movies/RecordStuff");
    expect(abbreviateHome("C:\\Users\\eric\\Videos\\RecordStuff", "C:\\Users\\eric")).toBe("~\\Videos\\RecordStuff");
    expect(abbreviateHome("/Volumes/Ext/Rec", "/Users/eric")).toBe("/Volumes/Ext/Rec");
    expect(abbreviateHome("/Users/eric", "/Users/eric")).toBe("~");
    expect(abbreviateHome("/Users/erica/x", "/Users/eric")).toBe("/Users/erica/x");
    expect(abbreviateHome("/Users/eric/x", "")).toBe("/Users/eric/x");
  });
});

describe("preferencesUnlocked", () => {
  it("is the one rule both interfaces and the action handler share", () => {
    const unlocked: RecordingState[] = [{ type: "idle" }, { type: "needsPermission", needsRelaunch: true }];
    const locked: RecordingState[] = [
      { type: "starting" },
      { type: "recording", startedAt: "2026-09-20T00:00:00Z" },
      { type: "stopping" },
    ];
    for (const state of unlocked) expect(preferencesUnlocked(state), state.type).toBe(true);
    for (const state of locked) expect(preferencesUnlocked(state), state.type).toBe(false);
  });
});
