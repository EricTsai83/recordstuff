import { describe, expect, it } from "vitest";
import { isShareChoice } from "./settings-panel";

describe("Share…'s choices (plan 100 step 3)", () => {
  it("takes an action and at most every version, named as the model names them", () => {
    expect(isShareChoice({ action: "open" })).toBe(true);
    expect(isShareChoice({ action: "copy", kinds: ["video", "sources"] })).toBe(true);
    expect(isShareChoice({ action: "drag", kinds: [] })).toBe(false);
    expect(isShareChoice({ action: "copy", kinds: ["everything"] })).toBe(false);
    expect(isShareChoice({ action: "delete" })).toBe(false);
    expect(isShareChoice("copy")).toBe(false);
  });
});
