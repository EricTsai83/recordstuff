// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click, menu } from "../../testing/test-interactions";
import type { LibraryItemView, SettingsView } from "../../../shared/settings-panel";
import type { EditorChoice, EditorView } from "../../../shared/editing";
import { MAX_CAMERA_HIDDEN, type EditScene } from "../../../shared/editable";

const item: LibraryItemView = { id: "a", day: "Today", title: "Talk", name: "Talk.mp4", time: "2:02 PM", duration: "0:10", size: "18 MB",
  thumbnail: "recordstuff-media://thumb/a?v=1", video: "recordstuff-media://video/a?v=1" };

const place = { x: 0.97, y: 0.05, width: 0.2, height: 0.3 };
// As many stretches as a scene holds, 3000 ticks long and 3000 apart: the first from 0.1 s to 0.133 s.
const FULL: EditScene = {
  camera: { ...place, shown: true, hidden: Array.from({ length: MAX_CAMERA_HIDDEN }, (_, n): [number, number] => [9_000 + n * 6_000, 12_000 + n * 6_000]) },
  volumes: { system: 100, microphone: 100 },
};

/**
 * The camera's stretches at their limit (Codex's review, 2026-10-26): a change that would need one more is refused and
 * said, never saved with a stretch dropped, which would show the camera where the user had hidden it.
 */
it("refuses a camera change past the most stretches a scene holds, and says so", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  let revision = 1;
  let editor: EditorView | undefined;
  const ready: EditorView = {
    id: "a", state: "ready", timescale: 90_000, duration: 1_800_000, seconds: 20, frameRate: 30, removed: [], skipped: [], revision: 0, notes: [],
    outputSeconds: 20, exportable: true, export: { phase: "idle" },
    editable: { sounds: ["system"], camera: { rounding: 0.15, mirror: false }, scene: FULL, recorded: { camera: { ...place, shown: true }, volumes: FULL.volumes }, preview: {} },
  };
  const view = (): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }], groups: [],
    library: { folder: "~/Movies", summary: "1 recording", items: [item] }, ...(editor ? { editor } : {}) });
  const choices: EditorChoice[] = [];
  const choose = vi.fn(async (group: string, choice: unknown): Promise<any> => {
    if (group !== "recordingEdit:a") return { view: view(), applied: true };
    const edit = choice as EditorChoice;
    choices.push(edit);
    if (edit.action === "open") editor = ready;
    if (edit.action === "close") editor = undefined;
    return { view: view(), applied: true };
  });
  window.settings = { read: async () => view(), capture: async () => view(), choose, ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(1));
  await menu(document.getElementById("clip-a-more")!);
  click(document.getElementById("clip-menu-edit")!);
  await vi.waitFor(() => expect(document.querySelectorAll(".editor-camera-stretch").length).toBeGreaterThan(MAX_CAMERA_HIDDEN));

  // The part from the end of the last stretch to the recording's end, split off at 18 s: hiding it would need one more.
  const video = document.querySelector<HTMLVideoElement>("#editor .pc video")!;
  video.currentTime = 18;
  document.getElementById("editor-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", bubbles: true }));
  await vi.waitFor(() => expect(document.getElementById("editor-camera-toggle")!.getAttribute("aria-disabled")).toBe("false"));
  click(document.getElementById("editor-camera-toggle")!);
  await vi.waitFor(() => expect(document.getElementById("editor-feedback")!.textContent).toBe(`The camera can be hidden over at most ${MAX_CAMERA_HIDDEN} stretches.`));
  expect(choices.filter((c) => c.action === "save")).toEqual([]);
});
