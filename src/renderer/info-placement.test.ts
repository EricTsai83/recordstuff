import { describe, expect, it } from "vitest";
import { INFO_GAP, infoPlacement } from "./info-placement";

const viewport = { width: 560, height: 680 };
const box = { width: 180, height: 30 };

describe("an ⓘ explanation's placement", () => {
  it("sits above its button, left-aligned to it, so the row it explains stays in view", () => {
    expect(infoPlacement({ left: 96, right: 116, top: 278, bottom: 298 }, box, viewport)).toEqual({ left: 96, top: 278 - INFO_GAP - 30, side: "above", bridge: { left: 0, width: 20, height: INFO_GAP + 1 } });
  });
  it("goes below a button too close to the top, and against the top when neither side has room", () => {
    expect(infoPlacement({ left: 96, right: 116, top: 30, bottom: 50 }, box, viewport)).toEqual({ left: 96, top: 50 + INFO_GAP, side: "below", bridge: { left: 0, width: 20, height: INFO_GAP + 1 } });
    expect(infoPlacement({ left: 96, right: 116, top: 30, bottom: 50 }, { width: 180, height: 300 }, { width: 560, height: 340 })).toEqual({ left: 96, top: 8, side: "above", bridge: { left: 0, width: 20, height: INFO_GAP + 1 } });
  });
  it("stays inside the window's side edges, its gap bridge still over the button", () => {
    expect(infoPlacement({ left: 500, right: 520, top: 278, bottom: 298 }, box, viewport)).toMatchObject({ left: 560 - 180 - 8, bridge: { left: 500 - 372, width: 20 } });
    expect(infoPlacement({ left: 2, right: 22, top: 278, bottom: 298 }, box, viewport).left).toBe(8);
  });
});
