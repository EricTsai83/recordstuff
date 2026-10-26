import { expect, it } from "vitest";
import { playbackEdit, videoLoad, type PlaybackEdit } from "./video-player";

const edit: PlaybackEdit = { timescale: 90_000, duration: 900_000, frameRate: 30, skipped: [[0, 90_000], [450_000, 540_000]] };
const editable: PlaybackEdit = {
  ...edit,
  editable: {
    sounds: ["system", "microphone"],
    camera: { rounding: 0.15, mirror: true },
    scene: { camera: { x: 0.9, y: 0.1, width: 0.2, height: 0.3, shown: true, hidden: [[90_000, 180_000]] }, volumes: { system: 100, microphone: 50 } },
    preview: { camera: "recordstuff-media://preview/3/camera", secondSound: "recordstuff-media://preview/3/secondSound" },
  },
};

it("reads an edit for the full-screen viewer, a plain recording's cuts and an editable one's scene and preview tracks", () => {
  expect(playbackEdit(edit)).toEqual(edit);
  expect(playbackEdit(editable)).toEqual(editable);
  expect(playbackEdit({ ...edit, skipped: [] })).toEqual({ ...edit, skipped: [] });
});

it("refuses an edit with a number out of range, a range out of order or a URL that is not a preview track's", () => {
  expect(playbackEdit(undefined)).toBeUndefined();
  expect(playbackEdit({ ...edit, timescale: 0 })).toBeUndefined();
  expect(playbackEdit({ ...edit, frameRate: Number.NaN })).toBeUndefined();
  expect(playbackEdit({ ...edit, skipped: [[90_000, 0]] })).toBeUndefined();
  expect(playbackEdit({ ...edit, skipped: [[-1, 10]] })).toBeUndefined();
  expect(playbackEdit({ ...edit, skipped: Array.from({ length: 513 }, (_, n) => [n * 10, n * 10 + 5]) })).toBeUndefined();
  const preview = (url: string): unknown => ({ ...editable, editable: { ...editable.editable, preview: { camera: url } } });
  expect(playbackEdit(preview("file:///etc/passwd"))).toBeUndefined();
  expect(playbackEdit(preview("recordstuff-media://preview/3/other"))).toBeUndefined();
  expect(playbackEdit({ ...editable, editable: { ...editable.editable, sounds: ["speaker"] } })).toBeUndefined();
  expect(playbackEdit({ ...editable, editable: { ...editable.editable, scene: { volumes: "loud" } } })).toBeUndefined();
});

it("loads a recording with or without an edit, and refuses one whose edit is unreadable", () => {
  const load = { src: "recordstuff-media://file/a", state: { time: 1, playing: true, volume: 1, muted: false }, language: "en" };
  expect(videoLoad(load)).toEqual(load);
  expect(videoLoad({ ...load, edit })).toEqual({ ...load, edit });
  expect(videoLoad({ ...load, edit: { ...edit, skipped: "all" } })).toBeUndefined();
});
