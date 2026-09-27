import { describe, expect, it } from "vitest";
import type { RecordingState } from "../shared/state";
import { abbreviateHome, compactPath, preferencesUnlocked } from "./ui-model";

describe("compactPath", () => {
  it("keeps short paths and shortens long ones to their start, an ellipsis and the last folder", () => {
    expect(compactPath("~/Movies/RecordStuff")).toBe("~/Movies/RecordStuff");
    expect(compactPath("~/personal-project/recordstuff/docs/verification/measurements/run/recordings")).toBe("~/personal-project/…/recordings");
    expect(compactPath("/Volumes/External Drive/Projects/2026/Client/Screen Recordings")).toBe("/Volumes/…/Screen Recordings");
    expect(compactPath("/Volumes/Backup/Projects/2026/Client/September/RecordStuff")).toBe("/Volumes/Backup/…/RecordStuff");
    expect(compactPath("~/a-very-long-first-folder-name-here/b/c/recordings")).toBe("~/…/recordings");
    expect(compactPath("C:\\Users\\eric\\Videos\\Clients\\2026\\September\\RecordStuff")).toBe("C:\\Users\\…\\RecordStuff");
    expect(compactPath("~/personal-project/recordstuff/docs/verification/recordings/")).toBe("~/personal-project/…/recordings");
    expect(compactPath("C:\\Users\\eric\\Videos\\Clients\\2026\\September\\RecordStuff\\")).toBe("C:\\Users\\…\\RecordStuff");
    const long = `~/${"x".repeat(60)}`;
    expect(compactPath(long).length).toBeLessThanOrEqual(40);
    expect(compactPath(long).startsWith("…")).toBe(true);
    for (const value of ["~/personal-project/recordstuff/docs/verification/measurements/run/recordings", long]) expect(compactPath(value).length).toBeLessThanOrEqual(40);
  });
});

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
