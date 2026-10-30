import { describe, expect, it } from "vitest";
import { bubbleRadius, bubbleRect, cameraCrop, insideBubble, type CameraLayout, type CameraPosition } from "../../../src/shared/camera-layout.ts";
import type { RgbFrame } from "./capture-settings.mts";
import { clockSeconds, dragFor, expectedPreviewTracks, judgeComposite, judgePlace, judgeResize, judgeScreenOnly, readEditableDescription, recordScene, sceneLayout } from "./editor-acceptance.mts";

const box = (type: string, payload: Buffer): Buffer => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, payload]);
};
const DESCRIPTION = '{"version":1,"sounds":["system","microphone"],"camera":{"width":0.2,"height":0.3,"rounding":0.5,"x":0.97,"y":0.05,"mirror":true}}';

describe("an editable recording's description", () => {
  it("is read from its udta/rsed box, wherever the moov puts it", () => {
    const file = Buffer.concat([box("ftyp", Buffer.from("isom")), box("mdat", Buffer.alloc(64, 7)), box("moov", box("udta", box("rsed", Buffer.from(DESCRIPTION))))]);
    expect(readEditableDescription(file)).toEqual({ sounds: ["system", "microphone"], camera: { width: 0.2, height: 0.3, rounding: 0.5, x: 0.97, y: 0.05, mirror: true } });
  });

  it("reads version 2's mix (plan 098), and names the preview tracks the edit view copies for each kind", () => {
    const mixed = '{"version":2,"mix":true,"sounds":["system","microphone"],"camera":null}';
    const description = readEditableDescription(Buffer.concat([box("ftyp", Buffer.from("isom")), box("moov", box("udta", box("rsed", Buffer.from(mixed))))]));
    expect(description).toEqual({ sounds: ["system", "microphone"], mix: true, camera: null });
    expect(expectedPreviewTracks(description!)).toEqual(["firstSound", "secondSound"]);
    expect(expectedPreviewTracks(readEditableDescription(box("moov", box("udta", box("rsed", Buffer.from(DESCRIPTION)))))!)).toEqual(["camera", "secondSound"]);
    expect(expectedPreviewTracks({ sounds: ["system"], camera: null })).toEqual([]);
  });

  it("is absent from a plain recording, and the bytes 'rsed' inside media are not one", () => {
    expect(readEditableDescription(Buffer.concat([box("ftyp", Buffer.from("isom")), box("mdat", Buffer.from("xxxxrsedjunk"))]))).toBeUndefined();
  });
});

describe("a drag of the bubble", () => {
  const layout: CameraLayout = { width: 0.25, height: 0.25, rounding: 1, mirror: false, positions: [] };

  it("moves the bubble's centre by the picture's pixels between the two places, scaled as drawn", () => {
    const from = { x: 0.97, y: 0.05 }, to = { x: 0.1, y: 0.85 };
    const now = bubbleRect(layout, from, 1920, 1080), next = bubbleRect(layout, to, 1920, 1080);
    // The picture drawn at half size from (100, 50) on the screen.
    const drawn = { x: 100 + now.x / 2, y: 50 + now.y / 2, width: now.width / 2, height: now.height / 2 };
    const { start, end } = dragFor(drawn, layout, from, to, 1920, 1080);
    expect(start).toEqual({ x: Math.round(drawn.x + drawn.width / 2), y: Math.round(drawn.y + drawn.height / 2) });
    expect(end.x - start.x).toBeCloseTo((next.x - now.x) / 2, 0);
    expect(end.y - start.y).toBeCloseTo((next.y - now.y) / 2, 0);
  });
});

describe("the edit record's scene", () => {
  const scene = { camera: { x: 0.1, y: 0.85, width: 0.2, height: 0.3, shown: true }, volumes: { system: 100, microphone: 50 } };

  it("is read with its revision, and a record without one is not a scene", () => {
    expect(recordScene(JSON.stringify({ version: 2, revision: 3, scene }))).toEqual({ revision: 3, scene });
    expect(recordScene(JSON.stringify({ version: 1, revision: 3, removed: [] }))).toBeUndefined();
    expect(recordScene("{")).toBeUndefined();
  });

  it("judges a drop within the tolerance and a resize that keeps the shape", () => {
    expect(judgePlace(scene.camera, { x: 0.12, y: 0.83 }).pass).toBe(true);
    expect(judgePlace(scene.camera, { x: 0.2, y: 0.85 }).pass).toBe(false);
    expect(judgePlace(undefined, { x: 0.1, y: 0.85 }).pass).toBe(false);
    const smaller = { ...scene.camera, width: 0.2 * 0.25 / 0.3, height: 0.25 };
    expect(judgeResize(scene.camera, smaller, 5).pass).toBe(true);
    expect(judgeResize(scene.camera, { ...scene.camera, width: 0.25, height: 0.25 }, 5).pass).toBe(false);
    expect(judgeResize(scene.camera, scene.camera, 5).pass).toBe(false);
  });
});

/** A textured picture: luma varies along both axes, so a crop or a mirror of it is recognisable. */
function picture(width: number, height: number, seed: number): RgbFrame {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = 128 + 60 * Math.sin((x + seed) / 23) + 50 * Math.cos((y * 1.7 + seed) / 31);
    const at = (y * width + x) * 3;
    data[at] = data[at + 1] = data[at + 2] = Math.max(0, Math.min(255, Math.round(v)));
  }
  return { width, height, data };
}
const flat = (width: number, height: number, value: number): RgbFrame => ({ width, height, data: Buffer.alloc(width * height * 3, value) });

/** The screen with the camera composed into the bubble as the engine does: centre-cropped, scaled, mirrored if asked. */
function composed(screen: RgbFrame, camera: RgbFrame, layout: CameraLayout, position: CameraPosition): RgbFrame {
  const out = { ...screen, data: Buffer.from(screen.data) };
  const bubble = bubbleRect(layout, position, screen.width, screen.height), radius = bubbleRadius(layout, bubble);
  const crop = cameraCrop(camera.width, camera.height, bubble.width, bubble.height);
  for (let y = bubble.y; y < bubble.y + bubble.height; y++) for (let x = bubble.x; x < bubble.x + bubble.width; x++) {
    if (!insideBubble(bubble, radius, x + 0.5, y + 0.5)) continue;
    let u = (x + 0.5 - bubble.x) / bubble.width;
    if (layout.mirror) u = 1 - u;
    const cx = Math.floor(crop.x + u * crop.width), cy = Math.floor(crop.y + (y + 0.5 - bubble.y) / bubble.height * crop.height);
    const from = (cy * camera.width + cx) * 3, to = (y * screen.width + x) * 3;
    out.data[to] = camera.data[from]!; out.data[to + 1] = camera.data[from + 1]!; out.data[to + 2] = camera.data[from + 2]!;
  }
  return out;
}

describe("an export's frame", () => {
  const screen = picture(640, 360, 0), camera = picture(320, 180, 500);
  const layout = sceneLayout({ width: 0.4, height: 0.5 }, { rounding: 0.6, mirror: true });
  const placed = { x: 0.1, y: 0.85 };

  it("passes with the camera's picture where the scene put it and the screen's elsewhere", () => {
    const result = judgeComposite(composed(screen, camera, layout, placed), screen, camera, layout, placed);
    expect(result.verdicts.every((v) => v.pass && v.judged), JSON.stringify(result.verdicts)).toBe(true);
    expect(result.correlation).toBeGreaterThan(0.95);
  });

  it("fails a bubble left where the recording had it, or a camera not mirrored as recorded", () => {
    const stayed = judgeComposite(composed(screen, camera, layout, { x: 0.97, y: 0.05 }), screen, camera, layout, placed);
    expect(stayed.verdicts.map((v) => v.pass)).toEqual([false, false]);
    const unmirrored = { ...layout, mirror: false };
    const wrong = judgeComposite(composed(screen, camera, unmirrored, placed), screen, camera, layout, placed);
    expect(wrong.verdicts[0]!.pass).toBe(false);
  });

  it("passes a frame the camera is hidden in only when the bubble's place holds the screen's picture (2026-10-26)", () => {
    expect(judgeScreenOnly(screen, screen, layout, placed, 5).pass).toBe(true);
    expect(judgeScreenOnly(composed(screen, camera, layout, placed), screen, layout, placed, 5).pass).toBe(false);
  });

  it("leaves a flat camera's picture unjudged instead of passing or failing it", () => {
    const dark = flat(320, 180, 16);
    const result = judgeComposite(composed(screen, dark, layout, placed), screen, dark, layout, placed);
    expect(result.verdicts[0]).toMatchObject({ judged: false, pass: false });
    expect(result.verdicts[1]!.pass).toBe(true);
  });
});

describe("the edit view's texts", () => {
  it("reads its clocks, to the hundredth or as the player's whole seconds", () => {
    expect(clockSeconds("Video length 0:11.89")).toBeCloseTo(11.89, 5);
    expect(clockSeconds("影片從 1:02.50 開始")).toBeCloseTo(62.5, 5);
    expect(clockSeconds("0:06 / 0:11")).toBe(6);
    expect(clockSeconds("no time")).toBeUndefined();
  });
});
