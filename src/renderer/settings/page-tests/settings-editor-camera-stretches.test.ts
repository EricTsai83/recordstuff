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
  editable: { sounds: ["system", "microphone"], camera: { rounding: 0.15, mirror: false }, scene, recorded: START,
    preview: { camera: "recordstuff-media://preview/1/camera" } },
});

/**
 * The camera hidden over stretches of an editable recording (2026-10-26): the lane under the pictures, the camera button
 * and C over a split part and a stretch of the lane, the preview's bubble following the playhead, Undo, and the options'
 * switch hiding or showing it throughout.
 */
it("hides the camera over a part, shows it there again from the lane, and follows the playhead in the preview", async () => {
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
  await vi.waitFor(() => expect(document.querySelector(".editor-camera-lane[data-lane=\"camera\"]")).not.toBeNull());
  const saves = (): EditorChoice[] => choices.filter((c) => c.action === "save");
  const lane = (): Array<[string | null, boolean]> => [...document.querySelectorAll<HTMLButtonElement>(".editor-camera-lane[data-lane=\"camera\"] .editor-camera-stretch")]
    .map((stretch) => [stretch.getAttribute("aria-label"), stretch.dataset.hidden !== undefined]);
  const toggle = (): HTMLElement => document.getElementById("editor-camera-toggle")!;

  // The lane: the camera shown throughout. Nothing is chosen, so the camera button is not there (it floats over a
  // selection, 2026-10-26, B′) and C does nothing yet.
  expect(lane()).toEqual([["0:00.0 to 0:10.0, camera shown", false]]);
  expect(document.getElementById("editor-camera-toggle")).toBeNull();
  document.getElementById("editor-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(saves()).toEqual([]);

  // The bubble, once the picture's size is known.
  const video = document.querySelector<HTMLVideoElement>("#editor .pc video")!;
  Object.defineProperty(video, "videoWidth", { value: 1920, configurable: true });
  Object.defineProperty(video, "videoHeight", { value: 1080, configurable: true });
  video.dispatchEvent(new Event("loadedmetadata"));
  await vi.waitFor(() => expect(document.getElementById("editor-camera")).not.toBeNull());

  // Split at 4 s, then C: the camera is hidden from there to the end, saved with the cuts as they are.
  video.currentTime = 4;
  document.getElementById("editor-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", bubbles: true }));
  await vi.waitFor(() => expect(document.getElementById("editor-camera-toggle")?.getAttribute("aria-disabled")).toBe("false"));
  expect(toggle().getAttribute("aria-label")).toBe("Hide camera in selection");
  document.getElementById("editor-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", bubbles: true }));
  await vi.waitFor(() => expect(saves()).toEqual([
    { action: "save", removed: [], revision: 0, scene: { ...START, camera: { ...START.camera!, hidden: [[360_000, 900_000]] } } },
  ]));
  await vi.waitFor(() => expect(lane()).toEqual([["0:00.0 to 0:04.0, camera shown", false], ["0:04.0 to 0:10.0, camera hidden", true]]));
  expect(document.getElementById("editor-feedback")!.textContent).toBe("Camera hidden from 0:04.0 to 0:10.0");
  // The part is still selected, all of it hidden: the button now shows the camera there again.
  expect(toggle().getAttribute("aria-label")).toBe("Show camera in selection");

  // The preview: at 6 s (paused) the bubble is not drawn, its place an outline that says so; at 1 s it is back.
  video.currentTime = 6;
  video.dispatchEvent(new Event("seeked"));
  await vi.waitFor(() => expect(document.getElementById("editor-camera")!.dataset.hidden).toBe("true"));
  expect(document.querySelector(".editor-camera-ghost")).not.toBeNull();
  expect(document.getElementById("editor-camera")!.getAttribute("tabindex")).toBe("-1");
  video.currentTime = 1;
  video.dispatchEvent(new Event("seeked"));
  await vi.waitFor(() => expect(document.getElementById("editor-camera")!.dataset.hidden).toBeUndefined());
  expect(document.querySelector(".editor-camera-ghost")).toBeNull();
  // Played to its very end, the preview reports the end itself, where the stretch ends: the camera stays hidden, as
  // the export's last picture has it (Codex's computer-use round of 2026-10-26 saw it come back there).
  video.currentTime = 10;
  video.dispatchEvent(new Event("ended"));
  await vi.waitFor(() => expect(document.getElementById("editor-camera")!.dataset.hidden).toBe("true"));
  expect(document.querySelector(".editor-camera-ghost")).not.toBeNull();
  video.currentTime = 1;
  video.dispatchEvent(new Event("seeked"));
  await vi.waitFor(() => expect(document.getElementById("editor-camera")!.dataset.hidden).toBeUndefined());

  // The lane's hidden stretch, chosen from the keyboard, then the camera button: shown there again, nothing hidden.
  const hiddenStretch = document.querySelectorAll<HTMLButtonElement>(".editor-camera-lane[data-lane=\"camera\"] .editor-camera-stretch")[1]!;
  hiddenStretch.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
  await vi.waitFor(() => expect(hiddenStretch.getAttribute("aria-pressed")).toBe("true"));
  // Chosen on the lane, it is one stretch of time, framed once across the pictures and every lane, its actions over the
  // timeline as for any other (the maintainer's review of 2026-10-26).
  const frames = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("#editor .editor-selection")];
  await vi.waitFor(() => expect(frames()).toHaveLength(1));
  expect(frames()[0]!.style.getPropertyValue("--from")).toBe(String(360_000 / 900_000));
  expect(document.querySelector("#editor .editor-camera-range, #editor .editor-range")).toBeNull();
  expect(document.getElementById("editor-selection-actions")!.dataset.lane).toBeUndefined();
  click(document.querySelectorAll<HTMLButtonElement>(".editor-part")[0]!);
  await vi.waitFor(() => expect(frames()[0]!.style.getPropertyValue("--from")).toBe("0"));
  expect(frames()).toHaveLength(1);
  const shownStretch = document.querySelectorAll<HTMLButtonElement>(".editor-camera-lane[data-lane=\"camera\"] .editor-camera-stretch")[0]!;
  shownStretch.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
  await vi.waitFor(() => expect(frames()).toHaveLength(1));
  // A split chooses the part after it.
  video.currentTime = 2;
  document.getElementById("editor-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", bubbles: true }));
  await vi.waitFor(() => expect(frames()[0]!.style.getPropertyValue("--from")).not.toBe("0"));
  hiddenStretch.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
  await vi.waitFor(() => expect(hiddenStretch.getAttribute("aria-pressed")).toBe("true"));
  click(toggle());
  await vi.waitFor(() => expect(saves().at(-1)).toEqual({ action: "save", removed: [], revision: 1, scene: START }));
  await vi.waitFor(() => expect(lane()).toEqual([["0:00.0 to 0:10.0, camera shown", false]]));

  // ⌘Z hides it over the stretch again.
  document.getElementById("editor-undo")!.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
  await vi.waitFor(() => expect(saves().at(-1)).toMatchObject({ revision: 2, scene: { camera: { shown: true, hidden: [[360_000, 900_000]] } } }));

  // More options: Hide camera view, off, says how many stretches hide it. On, nothing of the camera is in the
  // export, the stretches kept, and the camera button waits; off again, the stretches are back (the maintainer's choice).
  click(document.getElementById("editor-options")!);
  await vi.waitFor(() => expect(document.getElementById("editor-camera-hidden")).not.toBeNull());
  expect(document.getElementById("editor-camera-hidden")!.getAttribute("aria-checked")).toBe("false");
  expect(document.getElementById("editor-camera-note")!.textContent).toBe("Hidden over one stretch of the timeline. Select a stretch and press C to hide or show the camera there.");
  click(document.getElementById("editor-camera-hidden")!);
  const stretch = { ...START.camera!, hidden: [[360_000, 900_000]] as Array<[number, number]> };
  await vi.waitFor(() => expect(saves().at(-1)).toEqual({ action: "save", removed: [], revision: 3, scene: { ...START, camera: { ...stretch, shown: false } } }));
  await vi.waitFor(() => expect(lane()).toEqual([["0:00.0 to 0:10.0, camera hidden", true]]));
  expect(document.getElementById("editor-camera-note")!.textContent).toBe("The video holds no camera. Switched off, the camera follows the timeline again.");
  // The camera button waits: not there without a selection, unavailable over one.
  expect(document.getElementById("editor-camera-toggle")?.getAttribute("aria-disabled") ?? "true").toBe("true");
  document.getElementById("editor-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", bubbles: true }));
  await vi.waitFor(() => expect(document.getElementById("editor-feedback")!.textContent).toBe("Turn off Hide camera view in More options to hide or show it over a stretch."));
  expect(saves()).toHaveLength(4);
  click(document.getElementById("editor-camera-hidden")!);
  await vi.waitFor(() => expect(saves().at(-1)).toEqual({ action: "save", removed: [], revision: 4, scene: { ...START, camera: stretch } }));
  await vi.waitFor(() => expect(lane()).toEqual([["0:00.0 to 0:04.0, camera shown", false], ["0:04.0 to 0:10.0, camera hidden", true]]));

  // − by its key's place: with Zhuyin on, the key reports another character, and still resizes the bubble (2026-10-26,
  // a native round).
  video.currentTime = 1;
  video.dispatchEvent(new Event("seeked"));
  await vi.waitFor(() => expect(document.getElementById("editor-camera")!.dataset.hidden).toBeUndefined());
  document.getElementById("editor-camera")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ㄦ", code: "Minus", bubbles: true }));
  await vi.waitFor(() => expect((saves().at(-1) as { scene: EditScene }).scene.camera!.height).toBeCloseTo(0.29, 4));
});
