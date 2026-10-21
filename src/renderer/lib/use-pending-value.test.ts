import { describe, expect, it } from "vitest";
import { LatestSave } from "./use-pending-value";

describe("LatestSave", () => {
  it("saves a value equal to the saved one only while another save is pending", () => {
    const saves = new LatestSave();
    expect(saves.needed(true)).toBe(false);
    expect(saves.needed(false)).toBe(true);
    const first = saves.begin();
    // 100 → 105 pending, then back to 100: the step back is the newer intent.
    expect(saves.needed(true)).toBe(true);
    saves.end(first);
    expect(saves.needed(true)).toBe(false);
  });

  it("lets only the latest save's end show the saved value again, even when an older one carried the same value", () => {
    const saves = new LatestSave();
    const first = saves.begin(), second = saves.begin();
    expect(saves.end(first)).toBe(false);
    expect(saves.needed(true)).toBe(true);
    expect(saves.end(second)).toBe(true);
    expect(saves.needed(true)).toBe(false);
  });

  it("leaves a value the user moved to while a save was pending shown when that save ends", () => {
    const saves = new LatestSave();
    const first = saves.begin();
    saves.moved();
    expect(saves.end(first)).toBe(false);
    // The drag's value is then committed and saved, even if it ends where the saved value is.
    expect(saves.needed(true)).toBe(true);
    expect(saves.end(saves.begin())).toBe(true);
  });

  it("does nothing on a move with no save pending", () => {
    const saves = new LatestSave();
    saves.moved();
    expect(saves.needed(true)).toBe(false);
    expect(saves.end(saves.begin())).toBe(true);
  });
});
