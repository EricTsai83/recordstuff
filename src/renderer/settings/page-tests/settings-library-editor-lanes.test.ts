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
  editable: { sounds: ["system", "microphone"], camera: { rounding: 0.15, mirror: false }, scene, recorded: START, preview: {} },
});

/**
 * The lanes under the timeline, each hidden in Options (2026-10-26, the maintainer's request): a hidden lane leaves the
 * timeline, stays hidden in the next edit view, says so in Options when it still holds stretches the export applies, and
 * shows again when a change is made to it.
 */
it("hides a lane from Options, remembers it for the next view, says what it still holds, and shows it again on a change", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  let revision = 1;
  let editor: EditorView | undefined;
  const view = (): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }], groups: [],
    library: { folder: "~/Movies", summary: "1 recording", items: [item] }, ...(editor ? { editor } : {}) });
  let scene = START, saved = 0;
  const choose = vi.fn(async (group: string, choice: unknown): Promise<any> => {
    if (group !== "recordingEdit:a") return { view: view(), applied: true };
    const edit = choice as EditorChoice;
    if (edit.action === "open") editor = ready(scene, saved);
    if (edit.action === "save") { scene = edit.scene ?? scene; saved = edit.revision + 1; editor = ready(scene, saved); }
    if (edit.action === "close") editor = undefined;
    return { view: view(), applied: true };
  });
  window.settings = { read: async () => view(), capture: async () => view(), choose, ready: async () => {}, onChanged: () => () => {} };
  // Hidden in an earlier run of the app: the system's lane, and a lane this version does not know, which is ignored.
  localStorage.setItem("recordstuff.editorHiddenLanes", JSON.stringify(["system", "speaker"]));
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(1));
  const open = async (): Promise<void> => {
    await menu(document.getElementById("clip-a-more")!);
    click(document.getElementById("clip-menu-edit")!);
    await vi.waitFor(() => expect(document.querySelector('.editor-camera-lane[data-lane="camera"]')).not.toBeNull());
  };
  const lanes = (): string[] => [...document.querySelectorAll<HTMLElement>(".editor-camera-lane")].map((lane) => lane.dataset.lane ?? "");
  const key = (k: string): void => { document.getElementById("editor-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: `Key${k.toUpperCase()}`, bubbles: true })); };
  await open();
  expect(lanes()).toEqual(["camera", "microphone"]);
  // Enter on a stretch the edit has not set chooses the part where it starts, not the whole recording it spans.
  document.querySelector<HTMLButtonElement>('.editor-camera-lane[data-lane="camera"] .editor-camera-stretch')!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
  await vi.waitFor(() => expect(document.querySelector(".editor-part")!.getAttribute("aria-pressed")).toBe("true"));
  expect(document.querySelector(".editor-range")).toBeNull();

  // The microphone muted over the part after 4 s, then its lane hidden in Options: off the timeline, and Options says
  // its stretch still applies.
  const video = document.querySelector<HTMLVideoElement>("#editor .pc video")!;
  video.currentTime = 4;
  key("s");
  await vi.waitFor(() => expect(document.getElementById("editor-volume")!.getAttribute("aria-disabled")).toBe("false"));
  key("v");
  await vi.waitFor(() => expect(document.getElementById("editor-volume-mute-microphone")).not.toBeNull());
  click(document.getElementById("editor-volume-mute-microphone")!);
  await vi.waitFor(() => expect(scene.volumeStretches).toEqual({ microphone: [[360_000, 900_000, 0]] }));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  click(document.getElementById("editor-options")!);
  await vi.waitFor(() => expect(document.getElementById("editor-lane-microphone")).not.toBeNull());
  expect(document.getElementById("editor-lane-microphone-note")).toBeNull();
  click(document.getElementById("editor-lane-microphone")!);
  await vi.waitFor(() => expect(lanes()).toEqual(["camera"]));
  // Remembered for the next run of the app.
  expect(JSON.parse(localStorage.getItem("recordstuff.editorHiddenLanes")!)).toEqual(["system", "microphone"]);
  expect(document.getElementById("editor-lane-microphone-note")!.textContent).toBe("Hidden; its one stretch of its own still applies to the export.");
  // Hiding saves nothing: the edit is as it was.
  expect(saved).toBe(1);

  // Closed and opened again: still hidden.
  click(document.getElementById("editor-close")!);
  await vi.waitFor(() => expect(document.getElementById("editor-volume")).toBeNull());
  await open();
  expect(lanes()).toEqual(["camera"]);

  // A change to the hidden input shows its lane again.
  video.currentTime = 2;
  key("s");
  await vi.waitFor(() => expect(document.querySelectorAll(".editor-part")).toHaveLength(2));
  key("v");
  await vi.waitFor(() => expect(document.getElementById("editor-volume-mute-microphone")).not.toBeNull());
  click(document.getElementById("editor-volume-mute-microphone")!);
  await vi.waitFor(() => expect(lanes()).toEqual(["camera", "microphone"]));

  // So does C on a hidden camera lane.
  click(document.getElementById("editor-options")!);
  await vi.waitFor(() => expect(document.getElementById("editor-lane-camera")).not.toBeNull());
  click(document.getElementById("editor-lane-camera")!);
  await vi.waitFor(() => expect(lanes()).toEqual(["microphone"]));
  key("c");
  await vi.waitFor(() => expect(lanes()).toEqual(["camera", "microphone"]));
  await vi.waitFor(() => expect(scene.camera!.hidden).toEqual([[180_000, 900_000]]));
});
