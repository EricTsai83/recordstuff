// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click, menu } from "../../testing/test-interactions";
import type { LibraryItemView, SettingsView } from "../../../shared/settings-panel";
import type { EditorChoice, EditorView } from "../../../shared/editing";
import { MAX_CAMERA_HIDDEN, type EditScene } from "../../../shared/editable";

const item: LibraryItemView = { id: "a", day: "Today", title: "Talk", name: "Talk.mp4", time: "2:02 PM", duration: "1:00", size: "18 MB",
  thumbnail: "recordstuff-media://thumb/a?v=1", video: "recordstuff-media://video/a?v=1" };

// The microphone silent over as many stretches as an input holds, each 6 frames (18,000 ticks at 30 fps) with a frame
// between: the first from 0.033 s to 0.233 s.
const FULL: EditScene = {
  volumes: { system: 100, microphone: 100 },
  volumeStretches: { microphone: Array.from({ length: MAX_CAMERA_HIDDEN }, (_, n): [number, number, number] => [3_000 + n * 21_000, 21_000 + n * 21_000, 0]) },
};

/**
 * An input's stretches at their limit (Codex's review, 2026-10-26): Back to the overall volume inside a stretch would
 * split it in two, one more than an input holds: the change is refused and said, never saved and refused by main.
 */
it("refuses giving the volume back inside a stretch when that would pass the most stretches an input holds", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  let revision = 1;
  let editor: EditorView | undefined;
  const ready: EditorView = {
    id: "a", state: "ready", timescale: 90_000, duration: 5_400_000, seconds: 60, frameRate: 30, removed: [], skipped: [], revision: 0, notes: [],
    outputSeconds: 60, exportable: true, export: { phase: "idle" },
    editable: { sounds: ["microphone"], scene: FULL, recorded: { volumes: FULL.volumes }, preview: {} },
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
    return { view: view(), applied: true };
  });
  window.settings = { read: async () => view(), capture: async () => view(), choose, ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(1));
  await menu(document.getElementById("clip-a-more")!);
  click(document.getElementById("clip-menu-edit")!);
  await vi.waitFor(() => expect(document.querySelector('.editor-camera-lane[data-lane="microphone"]')).not.toBeNull());

  // The part from frame 3 to frame 4 (0.1–0.133 s), strictly inside the first stretch: S at each end selects it.
  const video = document.querySelector<HTMLVideoElement>("#editor .pc video")!;
  const key = (k: string): void => { document.getElementById("editor-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: `Key${k.toUpperCase()}`, bubbles: true })); };
  video.currentTime = 4 / 30;
  key("s");
  await vi.waitFor(() => expect(document.querySelectorAll(".editor-part")).toHaveLength(2));
  video.currentTime = 3 / 30;
  key("s");
  await vi.waitFor(() => expect(document.querySelectorAll(".editor-part")).toHaveLength(3));
  key("v");
  await vi.waitFor(() => expect(document.getElementById("editor-volume-popup")).not.toBeNull());
  expect(document.getElementById("editor-volume-popup")!.textContent).toContain("Volume from 0:00.1 to 0:00.1");
  click(document.getElementById("editor-volume-back")!);
  await vi.waitFor(() => expect(document.getElementById("editor-feedback")!.textContent).toBe(`An input can be at a volume of its own over at most ${MAX_CAMERA_HIDDEN} stretches.`));
  expect(choices.filter((c) => c.action === "save")).toEqual([]);
});
