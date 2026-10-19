import { describe, expect, it } from "vitest";
import { isStudioLevels, isStudioRate, STUDIO_FPS, STUDIO_RESTING_FPS } from "./studio-port";

describe("the Recording Studio's port (plan 081)", () => {
  it("takes levels from the capture process, with or without the microphone's", () => {
    expect(isStudioLevels({ type: "levels", system: 0.5, microphone: 0 })).toBe(true);
    expect(isStudioLevels({ type: "levels", system: 1.5 })).toBe(true);
    for (const bad of [-0.1, Number.NaN, 17, "0.5"]) expect(isStudioLevels({ type: "levels", system: bad }), String(bad)).toBe(false);
    expect(isStudioLevels({ type: "levels", system: 0.5, microphone: -1 })).toBe(false);
    // A preview chunk has no type: it is never taken for levels.
    expect(isStudioLevels({ width: 640, height: 360, data: new Uint8Array(1), key: true, timestamp: 0, sent: 0, n: 1 })).toBe(false);
  });

  it("takes from the page only the two rates the Studio shows", () => {
    expect(isStudioRate({ type: "rate", fps: STUDIO_FPS })).toBe(true);
    expect(isStudioRate({ type: "rate", fps: STUDIO_RESTING_FPS })).toBe(true);
    for (const fps of [0, 7.5, 30, "10"]) expect(isStudioRate({ type: "rate", fps }), String(fps)).toBe(false);
    expect(isStudioRate(null)).toBe(false);
  });
});
