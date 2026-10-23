import { describe, expect, it } from "vitest";
import { isStudioDiagnosticsRequest, isStudioLevels, isStudioPreviewDiagnostics, isStudioRate, STUDIO_FPS, STUDIO_RESTING_FPS } from "./studio-port";

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

  it("takes the capture process's request for the preview's figures, at most once a second (plan 083)", () => {
    expect(isStudioDiagnosticsRequest({ type: "diagnostics", everyMs: 5000 })).toBe(true);
    for (const everyMs of [0, 999, 1500.5, "5000"]) expect(isStudioDiagnosticsRequest({ type: "diagnostics", everyMs }), String(everyMs)).toBe(false);
  });

  it("takes the page's figures only whole and of this schema (plan 083)", () => {
    const figures = { type: "previewDiagnostics", schema: 1, received: 3, drawn: 2, missed: 0, notDecoded: 1, restarts: { codec: 1, error: 0 },
      port: { n: 3, sum: 3000, max: 1000, b: { 39: 3 } }, decode: { n: 2, sum: 4000, max: 2000, b: { 43: 2 } } };
    expect(isStudioPreviewDiagnostics(figures)).toBe(true);
    expect(isStudioPreviewDiagnostics({ ...figures, schema: 2 })).toBe(false);
    expect(isStudioPreviewDiagnostics({ ...figures, missed: -1 })).toBe(false);
    expect(isStudioPreviewDiagnostics({ ...figures, restarts: { codec: 1 } })).toBe(false);
    expect(isStudioPreviewDiagnostics({ ...figures, port: { n: 1 } })).toBe(false);
    // Neither levels nor a rate is taken for figures.
    expect(isStudioPreviewDiagnostics({ type: "levels", system: 0.5 })).toBe(false);
  });
});
