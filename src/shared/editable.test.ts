import { describe, expect, it } from "vitest";
import { cameraHidden, cameraShownAt, defaultScene, exportRender, fitScene, isEditScene, isExportRender, MAX_CAMERA_HIDDEN, parseEditableDescription, withCameraHidden } from "./editable";
import { isEditorChoice, isExportMainMessage } from "./editing";

const camera = { width: 0.2, height: 0.3, rounding: 0.15, x: 0.97, y: 0.05, mirror: false };

describe("an editable recording's description (plan 087)", () => {
  it("is read as the engine writes it, and anything else is not one", () => {
    expect(parseEditableDescription(JSON.stringify({ version: 1, sounds: ["system", "microphone"], camera }))).toEqual({ sounds: ["system", "microphone"], camera });
    expect(parseEditableDescription(JSON.stringify({ version: 1, sounds: ["silent"], camera: null }))).toEqual({ sounds: ["silent"], camera: null });
    for (const text of [
      undefined, null, "", "{", JSON.stringify({ version: 2, sounds: ["system"] }), JSON.stringify({ version: 1, sounds: [] }),
      JSON.stringify({ version: 1, sounds: ["system", "microphone", "system"] }), JSON.stringify({ version: 1, sounds: ["speaker"] }),
      JSON.stringify({ version: 1, sounds: ["system"], camera: { ...camera, width: 2 } }), JSON.stringify({ version: 1, sounds: ["system"], camera: { ...camera, mirror: 1 } }),
      `{"version":1,"sounds":["system"],"pad":"${"x".repeat(5000)}"}`,
    ]) {
      expect(parseEditableDescription(text)).toBeUndefined();
    }
  });
});

describe("an edit's scene", () => {
  const description = { sounds: ["system", "microphone"] as const, camera };

  it("starts where the recording left the camera, shown, every track as recorded", () => {
    expect(defaultScene({ ...description, sounds: [...description.sounds] })).toEqual({ camera: { x: 0.97, y: 0.05, width: 0.2, height: 0.3, shown: true }, volumes: { system: 100, microphone: 100 } });
    expect(defaultScene({ sounds: ["system"], camera: null })).toEqual({ volumes: { system: 100, microphone: 100 } });
  });

  it("fits the recording: no camera without one, its own camera kept with one", () => {
    const scene = { camera: { x: 0, y: 0, width: 0.1, height: 0.1, shown: false }, volumes: { system: 50, microphone: 0 } };
    expect(fitScene(scene, { sounds: ["system"], camera: null })).toEqual({ volumes: { system: 50, microphone: 0 } });
    expect(fitScene({ volumes: scene.volumes }, { sounds: ["system"], camera })).toMatchObject({ camera: { x: 0.97, shown: true } });
  });

  it("becomes the engine's request: the bubble in the recording's shape, each track's volume in dB in the file's order", () => {
    const scene = { camera: { x: 0.1, y: 0.9, width: 0.3, height: 0.3, shown: true }, volumes: { system: 0, microphone: 200 } };
    expect(exportRender({ sounds: ["microphone", "system"], camera: { ...camera, mirror: true } }, scene)).toEqual({
      camera: { width: 0.3, height: 0.3, rounding: 0.15, x: 0.1, y: 0.9, mirror: true }, volumesDb: [20 * Math.log10(2), -60],
    });
    expect(exportRender({ sounds: ["silent"], camera: null }, scene)).toEqual({ volumesDb: [0] });
    expect(isExportRender(exportRender({ sounds: ["system", "microphone"], camera }, scene))).toBe(true);
    expect(isExportRender({ volumesDb: [99] })).toBe(false);
    expect(isExportRender({ camera: { ...camera, x: 2 }, volumesDb: [] })).toBe(false);
  });

  it("is checked wherever it crosses a boundary", () => {
    const scene = { camera: { x: 0.5, y: 0.5, width: 0.2, height: 0.2, shown: true }, volumes: { system: 100, microphone: 100 } };
    expect(isEditScene(scene)).toBe(true);
    expect(isEditScene({ ...scene, volumes: { system: 601, microphone: 0 } })).toBe(false);
    expect(isEditScene({ ...scene, camera: { ...scene.camera, width: 0.01 } })).toBe(false);
    expect(isEditorChoice({ action: "save", removed: [], revision: 0, scene })).toBe(true);
    expect(isEditorChoice({ action: "save", removed: [], revision: 0, scene: { volumes: {} } })).toBe(false);
    const request = { source: "/a.mp4", removed: [], render: { volumesDb: [0, -6] } };
    expect(isExportMainMessage({ type: "export", id: 1, request })).toBe(true);
    expect(isExportMainMessage({ type: "export", id: 1, request: { ...request, render: { volumesDb: ["loud"] } } })).toBe(false);
    expect(isExportMainMessage({ type: "extract", id: 2, request: { source: "/a.mp4", track: "camera", output: "/p.mp4" } })).toBe(true);
    expect(isExportMainMessage({ type: "extract", id: 2, request: { source: "/a.mp4", track: "screen", output: "/p.mp4" } })).toBe(false);
  });

  it("keeps the camera's stretches sorted, merged and within the recording, apart from hiding it throughout (2026-10-26)", () => {
    const place = { x: 0.5, y: 0.5, width: 0.2, height: 0.2, shown: true };
    expect(withCameraHidden(place, [], 900)).toEqual(place);
    expect(withCameraHidden({ ...place, hidden: [[1, 2]] }, [], 900)).toEqual(place);
    expect(withCameraHidden(place, [[0, 900]], 900)).toEqual({ ...place, hidden: [[0, 900]] });
    expect(withCameraHidden(place, [[-5, 300], [200, 2000]], 900)).toEqual({ ...place, hidden: [[0, 900]] });
    expect(withCameraHidden(place, [[600, 700], [100, 200], [150, 250], [800, 1200], [400, 400]], 900)).toEqual({ ...place, hidden: [[100, 250], [600, 700], [800, 900]] });
    expect(withCameraHidden(place, Array.from({ length: 300 }, (_, n): [number, number] => [n * 3, n * 3 + 1]), 10_000).hidden).toHaveLength(MAX_CAMERA_HIDDEN);
    // Hidden throughout keeps its stretches, for when it is shown again.
    expect(withCameraHidden({ ...place, shown: false }, [[100, 250]], 900)).toEqual({ ...place, shown: false, hidden: [[100, 250]] });
    // Read back: hidden throughout is the whole recording; shown, only its stretches.
    expect(cameraHidden({ ...place, shown: false, hidden: [[100, 250]] }, 900)).toEqual([[0, 900]]);
    expect(cameraHidden({ ...place, hidden: [[100, 250]] }, 900)).toEqual([[100, 250]]);
    expect([cameraShownAt({ ...place, hidden: [[100, 250]] }, 99), cameraShownAt({ ...place, hidden: [[100, 250]] }, 100), cameraShownAt({ ...place, hidden: [[100, 250]] }, 250)]).toEqual([true, false, true]);
    expect(cameraShownAt({ ...place, shown: false }, 0)).toBe(false);
    expect(fitScene({ camera: { ...place, hidden: [[0, 2000]] }, volumes: { system: 100, microphone: 100 } }, description_(), 900).camera).toEqual({ ...place, hidden: [[0, 900]] });
  });

  it("asks the engine to leave the camera out over its stretches, and none when it is hidden throughout", () => {
    const scene = { camera: { x: 0.1, y: 0.9, width: 0.3, height: 0.3, shown: true, hidden: [[90_000, 180_000]] as Array<[number, number]> }, volumes: { system: 100, microphone: 100 } };
    const render = exportRender({ sounds: ["system"], camera }, scene);
    expect(render.cameraHidden).toEqual([{ from: 90_000, to: 180_000 }]);
    expect(isExportRender(render)).toBe(true);
    expect(exportRender({ sounds: ["system"], camera }, { ...scene, camera: { ...scene.camera, shown: false } })).toEqual({ volumesDb: [0] });
    expect(exportRender({ sounds: ["system"], camera }, { ...scene, camera: { ...scene.camera, hidden: [] } })).not.toHaveProperty("cameraHidden");
    expect(isExportRender({ ...render, cameraHidden: [{ from: 5, to: 2 }] })).toBe(false);
    expect(isExportRender({ ...render, cameraHidden: [{ from: 1.5, to: 2 }] })).toBe(false);
    expect(isEditScene(scene)).toBe(true);
    expect(isEditScene({ ...scene, camera: { ...scene.camera, hidden: [[3, 3]] } })).toBe(false);
    expect(isEditScene({ ...scene, camera: { ...scene.camera, hidden: "all" } })).toBe(false);
    expect(isExportMainMessage({ type: "export", id: 1, request: { source: "/a.mp4", removed: [], render } })).toBe(true);
  });
});

function description_() {
  return { sounds: ["system" as const], camera };
}
