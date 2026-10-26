// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click, menu } from "../../testing/test-interactions";
import type { LibraryItemView, SettingsView } from "../../../shared/settings-panel";
import type { EditorChoice, EditorView } from "../../../shared/editing";
import type { EditScene } from "../../../shared/editable";

const item: LibraryItemView = { id: "a", day: "Today", title: "Talk", name: "Talk.mp4", time: "2:02 PM", duration: "0:10", size: "18 MB",
  thumbnail: "recordstuff-media://thumb/a?v=1", video: "recordstuff-media://video/a?v=1" };

const START: EditScene = { camera: { x: 0.97, y: 0.05, width: 0.2, height: 0.3, shown: true }, volumes: { system: 100, microphone: 100 } };

const ready = (scene: EditScene, revision: number): EditorView => ({
  id: "a", state: "ready", timescale: 90_000, duration: 900_000, seconds: 10, frameRate: 30, removed: [], skipped: [], revision, notes: [],
  outputSeconds: 10, exportable: true, export: { phase: "idle" },
  editable: { sounds: ["system", "microphone"], camera: { rounding: 0.15, mirror: true }, scene, recorded: START,
    preview: { camera: "recordstuff-media://preview/1/camera", secondSound: "recordstuff-media://preview/1/secondSound" } },
});

/**
 * An editable recording's edit view (plan 087): the camera's bubble over the picture and the scene's controls; each
 * change is saved with the scene, and Undo brings the last scene back.
 */
it("places the camera with the arrow keys, hides it, and takes the change back, saving the scene each time", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  let revision = 1;
  let editor: EditorView | undefined;
  const view = (): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }], groups: [],
    library: { folder: "~/Movies", summary: "1 recording", items: [item] }, ...(editor ? { editor } : {}) });
  const choices: EditorChoice[] = [];
  const choose = vi.fn(async (group: string, choice: unknown): Promise<any> => {
    if (group !== "recordingEdit:a") return { view: view(), applied: true };
    const edit = choice as EditorChoice;
    choices.push(edit);
    if (edit.action === "open") editor = ready(START, 0);
    if (edit.action === "save") editor = ready(edit.scene ?? editor!.editable!.scene, edit.revision + 1);
    if (edit.action === "close") editor = undefined;
    return { view: view(), applied: true };
  });
  window.settings = { read: async () => view(), capture: async () => view(), choose, ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(1));
  await menu(document.getElementById("clip-a-more")!);
  click(document.getElementById("clip-menu-edit")!);
  await vi.waitFor(() => expect(document.getElementById("editor-options")).not.toBeNull());

  // The controls, behind the toolbar's Options button (2026-10-26, with Skimming): the camera shown, then a volume for each sound the
  // recording holds. The camera's size is its corner handles (2026-10-25: no slider).
  expect(document.getElementById("editor-options")!.textContent).toBe("Options");
  click(document.getElementById("editor-options")!);
  await vi.waitFor(() => expect(document.querySelector("#editor-options-popup .editor-scene")).not.toBeNull());
  expect(document.getElementById("editor-skim")!.getAttribute("aria-checked")).toBe("false");
  expect(document.getElementById("editor-camera-hidden")!.getAttribute("aria-checked")).toBe("false");
  expect(document.getElementById("editor-camera-size")).toBeNull();
  expect(document.getElementById("editor-volume-system")).not.toBeNull();
  expect(document.getElementById("editor-volume-microphone")).not.toBeNull();
  // An editable recording can be exported with no cut, and says what its export writes.
  expect(document.getElementById("editor-export")!.getAttribute("aria-disabled")).toBe("false");

  // The bubble appears once the picture's size is known, holding the camera's own track, mirrored as recorded.
  const video = document.querySelector<HTMLVideoElement>("#editor .pc video")!;
  expect(video.crossOrigin).toBe("anonymous");
  Object.defineProperty(video, "videoWidth", { value: 1920, configurable: true });
  Object.defineProperty(video, "videoHeight", { value: 1080, configurable: true });
  video.dispatchEvent(new Event("loadedmetadata"));
  await vi.waitFor(() => expect(document.getElementById("editor-camera")).not.toBeNull());
  const bubble = document.getElementById("editor-camera")!;
  expect(bubble.getAttribute("aria-label")).toBe("Camera: 97% across, 5% down, 30% in size. Drag it or use the arrow keys to move it; drag a corner, or press + or −, to resize it.");
  expect(bubble.querySelector("video")!.getAttribute("src")).toBe("recordstuff-media://preview/1/camera");
  expect(bubble.querySelector("video")!.style.transform).toBe("scaleX(-1)");
  expect(document.querySelector<HTMLAudioElement>(".editor-overlay audio")!.getAttribute("src")).toBe("recordstuff-media://preview/1/secondSound");

  // Its followers go where the recording goes: a seek of a single frame moves the camera exactly, and the player's mute
  // reaches the second sound (Codex's review of plan 087).
  const camera = bubble.querySelector("video")!;
  const sound = document.querySelector<HTMLAudioElement>(".editor-overlay audio")!;
  video.currentTime = 2.0333;
  video.dispatchEvent(new Event("seeked"));
  expect([camera.currentTime, sound.currentTime]).toEqual([2.0333, 2.0333]);
  video.muted = true;
  video.dispatchEvent(new Event("volumechange"));
  expect(sound.muted).toBe(true);

  // An arrow key moves it a step and saves the scene with the cuts as they are; a second, pressed while the first
  // saves, is kept, and saved after it against the revision it brought (a held key, found by plan 087's desktop round).
  bubble.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  bubble.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  await vi.waitFor(() => expect(choices.filter((c) => c.action === "save")).toEqual([
    { action: "save", removed: [], revision: 0, scene: { ...START, camera: { ...START.camera!, x: 0.96 } } },
    { action: "save", removed: [], revision: 1, scene: { ...START, camera: { ...START.camera!, x: 0.95 } } },
  ]));
  // The controls were never disabled meanwhile, so the keyboard's focus stays where it was.
  expect(document.getElementById("editor-camera-hidden")!.hasAttribute("data-disabled")).toBe(false);
  await vi.waitFor(() => expect(document.getElementById("editor-camera")!.getAttribute("aria-label")).toContain("95% across"));

  // + grows it a step, its shape kept: the sliders' keyboard counterpart now the slider is gone.
  document.getElementById("editor-camera")!.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true }));
  await vi.waitFor(() => expect(choices.at(-1)).toMatchObject({ action: "save", revision: 2 }));
  const grown = (choices.at(-1) as { scene: EditScene }).scene.camera!;
  expect(grown.height).toBeCloseTo(0.31, 4);
  expect(grown.width / grown.height).toBeCloseTo(0.2 / 0.3, 2);

  // Hidden throughout: saved, and the bubble goes.
  click(document.getElementById("editor-camera-hidden")!);
  await vi.waitFor(() => expect(choices.at(-1)).toMatchObject({ action: "save", revision: 3, scene: { camera: { x: 0.95, shown: false } } }));
  await vi.waitFor(() => expect(document.getElementById("editor-camera")).toBeNull());

  // ⌘Z brings the shown camera back.
  document.getElementById("editor-undo")!.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
  await vi.waitFor(() => expect(choices.at(-1)).toMatchObject({ action: "save", revision: 4, scene: { camera: { x: 0.95, shown: true } } }));
  await vi.waitFor(() => expect(document.getElementById("editor-camera")).not.toBeNull());
});
