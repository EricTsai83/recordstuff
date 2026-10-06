import { describe, expect, it } from "vitest";
import type { RecordingState } from "../../shared/state";
import { preferencesUnlocked } from "./recording-lock";

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
