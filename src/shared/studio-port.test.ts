import { describe, expect, it } from "vitest";
import { isStudioDiagnosticsRequest, isStudioDrawn, isStudioLevels, isStudioPreviewDiagnostics, isStudioPreviewSettings, isStudioRate, isStudioStallRequest, isStudioViewMessage, STUDIO_RATES, studioStallOf } from "./studio-port";

describe("the Recording Studio's port (plan 081)", () => {
  it("takes levels from the capture process, with or without the microphone's", () => {
    expect(isStudioLevels({ type: "levels", system: 0.5, microphone: 0 })).toBe(true);
    expect(isStudioLevels({ type: "levels", system: 1.5 })).toBe(true);
    for (const bad of [-0.1, Number.NaN, 17, "0.5"]) expect(isStudioLevels({ type: "levels", system: bad }), String(bad)).toBe(false);
    expect(isStudioLevels({ type: "levels", system: 0.5, microphone: -1 })).toBe(false);
    // A preview chunk has no type: it is never taken for levels.
    expect(isStudioLevels({ width: 640, height: 360, data: new Uint8Array(1), key: true, timestamp: 0, sent: 0, n: 1 })).toBe(false);
  });

  it("takes from the page only the rates the Studio offers, the same as the engine's (plan 092, D1)", () => {
    expect(STUDIO_RATES).toEqual([5, 10, 15]);
    for (const fps of STUDIO_RATES) expect(isStudioRate({ type: "rate", fps }), String(fps)).toBe(true);
    for (const fps of [0, 7.5, 30, "10"]) expect(isStudioRate({ type: "rate", fps }), String(fps)).toBe(false);
    expect(isStudioRate(null)).toBe(false);
  });

  it("takes from the page only the views the Studio offers, and refuses another (plan 092, D3)", () => {
    expect(isStudioViewMessage({ type: "view", view: "composed" })).toBe(true);
    expect(isStudioViewMessage({ type: "view", view: "screen" })).toBe(true);
    expect(isStudioViewMessage({ type: "view", view: "camera" })).toBe(true);
    for (const view of ["Camera", "", 1, undefined]) expect(isStudioViewMessage({ type: "view", view }), String(view)).toBe(false);
    expect(isStudioViewMessage({ type: "rate", fps: 10 })).toBe(false);
  });

  it("reads a stored rate choice only whole (plan 092)", () => {
    expect(isStudioPreviewSettings({ rate: "standard", view: "screen" })).toBe(true);
    expect(isStudioPreviewSettings({ rate: "power", view: "camera" })).toBe(true);
    // Off was a rate until 2026-10-25; settings.ts reads a stored one as Power saving before this check.
    for (const bad of [{ rate: "off", view: "composed" }, { rate: "fast", view: "composed" }, { rate: "power" }, { rate: "power", view: "selfie" }, [], null]) {
      expect(isStudioPreviewSettings(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("takes the capture process's request for the preview's figures, at most once a second (plan 083)", () => {
    expect(isStudioDiagnosticsRequest({ type: "diagnostics", everyMs: 5000 })).toBe(true);
    for (const everyMs of [0, 999, 1500.5, "5000"]) expect(isStudioDiagnosticsRequest({ type: "diagnostics", everyMs }), String(everyMs)).toBe(false);
  });

  it("takes the page's figures only whole and of this schema (plan 083)", () => {
    const figures = { type: "previewDiagnostics", schema: 1, received: 3, drawn: 2, missed: 0, notDecoded: 1, pendingHigh: 1, decodingHigh: 0, heapHigh: 0, restarts: { codec: 1, error: 0 },
      port: { n: 3, sum: 3000, max: 1000, b: { 39: 3 } }, decode: { n: 2, sum: 4000, max: 2000, b: { 43: 2 } }, recover: { n: 0, sum: 0, max: 0, b: {} } };
    expect(isStudioPreviewDiagnostics(figures)).toBe(true);
    expect(isStudioPreviewDiagnostics({ ...figures, schema: 2 })).toBe(false);
    expect(isStudioPreviewDiagnostics({ ...figures, missed: -1 })).toBe(false);
    expect(isStudioPreviewDiagnostics({ ...figures, pendingHigh: undefined })).toBe(false);
    expect(isStudioPreviewDiagnostics({ ...figures, restarts: { codec: 1 } })).toBe(false);
    expect(isStudioPreviewDiagnostics({ ...figures, port: { n: 1 } })).toBe(false);
    // Neither levels nor a rate is taken for figures.
    expect(isStudioPreviewDiagnostics({ type: "levels", system: 0.5 })).toBe(false);
  });

  it("reads the stall switch only whole and bounded, and takes only a bounded stall request (plan 084)", () => {
    expect(studioStallOf("15,30")).toEqual({ atMs: 15_000, forMs: 30_000 });
    expect(studioStallOf(" 0.5 , 2.25 ")).toEqual({ atMs: 500, forMs: 2250 });
    for (const bad of [undefined, "", "30", "15,0", "15,121", "601,5", "-1,5", "a,b", "15,30,1"]) expect(studioStallOf(bad), String(bad)).toBeUndefined();
    expect(isStudioStallRequest({ type: "stall", ms: 30_000 })).toBe(true);
  });

  it("takes the page's acknowledgement only whole: a chunk number and, when its decoder was dropped, the key frame flag (plan 084)", () => {
    expect(isStudioDrawn({ type: "drawn", through: 0 })).toBe(true);
    expect(isStudioDrawn({ type: "drawn", through: 12, key: true })).toBe(true);
    for (const bad of [{ through: -1 }, { through: 1.5 }, { through: "3" }, { through: 3, key: false }, { through: 3, key: 1 }]) {
      expect(isStudioDrawn({ type: "drawn", ...bad }), JSON.stringify(bad)).toBe(false);
    }
    for (const ms of [0, -1, 1.5, 120_001, "30000"]) expect(isStudioStallRequest({ type: "stall", ms }), String(ms)).toBe(false);
  });
});
