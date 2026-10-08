import { describe, expect, it } from "vitest";
import { displayLabel, isDisplayInfo, isDisplayPreference } from "./display";
describe("display vocabulary", () => {
  it("accepts primary and exact ids with empty presentation labels", () => {
    expect(isDisplayPreference({ kind: "primary" })).toBe(true);
    expect(isDisplayPreference({ kind: "display", id: "123", label: "" })).toBe(true);
  });
  it.each([undefined, {}, { kind: "other" }, ...[undefined, "", 1, "-1", "-10", "1.5", "abc", "01", "Infinity"].map((id) => ({ kind: "display", id, label: "" })), { kind: "display", id: "1", label: 1 }])("rejects malformed preference %j", (value) => {
    expect(isDisplayPreference(value)).toBe(false);
  });
  it("validates live dimensions and uses deterministic localized names", () => {
    const d = { id: "1", label: "", logicalWidth: 100, logicalHeight: 100, scaleFactor: 2, internal: true, primary: true };
    expect(isDisplayInfo(d)).toBe(true);
    for (const key of ["logicalWidth", "logicalHeight", "scaleFactor"]) for (const n of [0, -1, NaN, Infinity]) expect(isDisplayInfo({ ...d, [key]: n })).toBe(false);
    // A place on the desktop may be negative (left of or above the primary) but must be a finite number.
    expect(isDisplayInfo({ ...d, x: -1080, y: -400 })).toBe(true);
    for (const key of ["x", "y"]) for (const n of [NaN, Infinity, "0"]) expect(isDisplayInfo({ ...d, [key]: n })).toBe(false);
    expect(displayLabel(d, "en")).toBe("Display 1 (Primary)");
    expect(displayLabel(d, "zh-TW")).toBe("螢幕 1（主螢幕）");
  });
});
