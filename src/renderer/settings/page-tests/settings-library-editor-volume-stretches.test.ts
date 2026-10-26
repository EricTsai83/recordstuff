// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click, menu } from "../../testing/test-interactions";
import type { LibraryItemView, SettingsView } from "../../../shared/settings-panel";
import type { EditorChoice, EditorView } from "../../../shared/editing";
import type { EditScene } from "../../../shared/editable";

const item: LibraryItemView = { id: "a", day: "Today", title: "Talk", name: "Talk.mp4", time: "2:02 PM", duration: "0:10", size: "18 MB",
  thumbnail: "recordstuff-media://thumb/a?v=1", video: "recordstuff-media://video/a?v=1" };

const START: EditScene = { volumes: { system: 100, microphone: 80 } };

const ready = (scene: EditScene, revision: number): EditorView => ({
  id: "a", state: "ready", timescale: 90_000, duration: 900_000, seconds: 10, frameRate: 30, removed: [], skipped: [], revision, notes: [],
  outputSeconds: 10, exportable: true, export: { phase: "idle" },
  editable: { sounds: ["system", "microphone"], scene, recorded: START, preview: {} },
});

/**
 * An input's volume over stretches (2026-10-26, the maintainer's request): a lane for each input; V and the Volume button
 * open a popup over the selection whose Mute, slider and Back to the overall volume save the stretches, each a change
 * Undo takes back; with nothing selected, V says what to choose.
 */
it("mutes the microphone over a part from the Volume popup, sets the system's there, and gives it back", async () => {
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
    return { view: view(), applied: true };
  });
  window.settings = { read: async () => view(), capture: async () => view(), choose, ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(1));
  await menu(document.getElementById("clip-a-more")!);
  click(document.getElementById("clip-menu-edit")!);
  await vi.waitFor(() => expect(document.querySelectorAll(".editor-volume-lane")).toHaveLength(2));
  const saves = (): Array<Extract<EditorChoice, { action: "save" }>> => choices.filter((c): c is Extract<EditorChoice, { action: "save" }> => c.action === "save");
  const lane = (input: string): string[] => [...document.querySelectorAll<HTMLButtonElement>(`.editor-camera-lane[data-lane="${input}"] .editor-camera-stretch`)]
    .map((stretch) => stretch.getAttribute("aria-label") ?? "");
  const key = (k: string): void => { document.getElementById("editor-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: `Key${k.toUpperCase()}`, bubbles: true })); };

  // Each input at its own volume; no camera lane, no camera button (the recording has no camera).
  expect(lane("system")).toEqual(["0:00.0 to 0:10.0, System audio at its volume"]);
  expect(lane("microphone")).toEqual(["0:00.0 to 0:10.0, Microphone at its volume"]);
  expect(document.querySelector('.editor-camera-lane[data-lane="camera"]')).toBeNull();
  expect(document.getElementById("editor-camera-toggle")).toBeNull();
  // Nothing selected: the button waits, and V says what to choose.
  expect(document.getElementById("editor-volume")!.getAttribute("aria-disabled")).toBe("true");
  key("v");
  await vi.waitFor(() => expect(document.getElementById("editor-feedback")!.textContent).toBe("Select a part or drag across the timeline, then set its volume (V)"));
  expect(document.getElementById("editor-volume-popup")).toBeNull();

  // Split at 4 s, the part after it selected; V opens the popup over it, the microphone at its own 80%.
  const video = document.querySelector<HTMLVideoElement>("#editor .pc video")!;
  video.currentTime = 4;
  key("s");
  await vi.waitFor(() => expect(document.getElementById("editor-volume")!.getAttribute("aria-disabled")).toBe("false"));
  key("v");
  await vi.waitFor(() => expect(document.getElementById("editor-volume-popup")).not.toBeNull());
  expect(document.getElementById("editor-volume-popup")!.textContent).toContain("Volume from 0:04.0 to 0:10.0");
  expect(document.querySelector('#editor-volume-selection-microphone [role="slider"], #editor-volume-selection-microphone input')?.getAttribute("aria-valuetext")).toBe("80%");

  // Mute: the microphone silent there, one save.
  click(document.getElementById("editor-volume-mute-microphone")!);
  await vi.waitFor(() => expect(saves().at(-1)).toEqual({ action: "save", removed: [], revision: 0, scene: { ...START, volumeStretches: { microphone: [[360_000, 900_000, 0]] } } }));
  await vi.waitFor(() => expect(lane("microphone")).toEqual(["0:00.0 to 0:04.0, Microphone at its volume", "0:04.0 to 0:10.0, Microphone muted"]));
  expect(document.getElementById("editor-feedback")!.textContent).toBe("Microphone muted from 0:04.0 to 0:10.0");
  expect(document.getElementById("editor-volume-mute-microphone")!.getAttribute("aria-pressed")).toBe("true");

  // Back to the overall volume: every input there at once, one change; ⌘Z brings the mute back.
  click(document.getElementById("editor-volume-back")!);
  await vi.waitFor(() => expect(saves().at(-1)).toEqual({ action: "save", removed: [], revision: 1, scene: START }));
  document.getElementById("editor-undo")!.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
  await vi.waitFor(() => expect(saves().at(-1)).toMatchObject({ revision: 2, scene: { volumeStretches: { microphone: [[360_000, 900_000, 0]] } } }));

  // Reset camera and volumes, in Options, clears the stretches too.
  click(document.getElementById("editor-options")!);
  await vi.waitFor(() => expect(document.getElementById("editor-scene-reset")).not.toBeNull());
  click(document.getElementById("editor-scene-reset")!);
  await vi.waitFor(() => expect(saves().at(-1)).toEqual({ action: "save", removed: [], revision: 3, scene: START }));

  // An input silent itself: Mute then Unmute over the part gives it 100% there, so Unmute is always heard (Codex's review).
  click(document.getElementById("editor-options")!);
  await vi.waitFor(() => expect(document.getElementById("editor-volume-system")).not.toBeNull());
  const before = saves().length;
  const thumb = document.querySelector<HTMLElement>('#editor-volume-system [role="slider"], #editor-volume-system input')!;
  thumb.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  await vi.waitFor(() => expect(saves().length).toBeGreaterThan(before));
  await vi.waitFor(() => expect(saves().at(-1)!.scene!.volumes.system).toBe(0));
  key("v");
  await vi.waitFor(() => expect(document.getElementById("editor-volume-mute-system")).not.toBeNull());
  // Muted already (its own volume is 0%): Unmute.
  expect(document.getElementById("editor-volume-mute-system")!.getAttribute("aria-pressed")).toBe("true");
  click(document.getElementById("editor-volume-mute-system")!);
  await vi.waitFor(() => expect(saves().at(-1)!.scene!.volumeStretches).toEqual({ system: [[360_000, 900_000, 100]] }));
});
