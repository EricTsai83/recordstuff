// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click, menu } from "../../testing/test-interactions";
import type { LibraryItemView, SettingsView } from "../../../shared/settings-panel";
import type { EditorChoice, EditorView, EditRange } from "../../../shared/editing";
import type { EditScene } from "../../../shared/editable";

const item: LibraryItemView = { id: "a", day: "Today", title: "Talk", name: "Talk.mp4", time: "2:02 PM", duration: "0:10", size: "18 MB",
  thumbnail: "recordstuff-media://thumb/a?v=1", video: "recordstuff-media://video/a?v=1" };

const START: EditScene = { camera: { x: 0.97, y: 0.05, width: 0.2, height: 0.3, shown: true }, volumes: { system: 100, microphone: 100 } };

const ready = (scene: EditScene, removed: EditRange[], revision: number): EditorView => ({
  id: "a", state: "ready", timescale: 90_000, duration: 900_000, seconds: 10, frameRate: 30, removed, skipped: removed, revision, notes: [],
  outputSeconds: 10, exportable: true, export: { phase: "idle" },
  editable: { sounds: ["system"], camera: { rounding: 0.15, mirror: false }, scene, recorded: START, preview: {} },
});

/**
 * The edit's changes in one order (Codex's second review, 2026-10-26): with saves slow, a camera change pressed while a
 * cut saves goes after it, against the revision and the cuts it brought, as main would otherwise refuse it; and S
 * pressed while a change saves splits where the playhead was when it was pressed, not where it is once the save lands.
 */
it("saves a camera change after the cut saving before it, and splits where S was pressed", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  let revision = 1;
  let editor: EditorView | undefined;
  const view = (): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }], groups: [],
    library: { folder: "~/Movies", summary: "1 recording", items: [item] }, ...(editor ? { editor } : {}) });
  const choices: EditorChoice[] = [];
  // Main as it is: one save at a time, each refused unless it names the revision it changes.
  let release: (() => void) | undefined;
  const choose = vi.fn(async (group: string, choice: unknown): Promise<any> => {
    if (group !== "recordingEdit:a") return { view: view(), applied: true };
    const edit = choice as EditorChoice;
    choices.push(edit);
    if (edit.action === "open") editor = ready(START, [], 0);
    if (edit.action === "save") {
      await new Promise<void>((resolve) => { release = resolve; });
      if (edit.revision !== editor!.revision) return { view: view(), applied: false };
      editor = ready(edit.scene ?? editor!.editable!.scene, edit.removed, edit.revision + 1);
    }
    return { view: view(), applied: true };
  });
  const land = async (): Promise<void> => {
    await vi.waitFor(() => expect(release).toBeDefined());
    const done = release!;
    release = undefined;
    done();
  };
  window.settings = { read: async () => view(), capture: async () => view(), choose, ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(1));
  await menu(document.getElementById("clip-a-more")!);
  click(document.getElementById("clip-menu-edit")!);
  await vi.waitFor(() => expect(document.querySelector(".editor-camera-lane[data-lane=\"camera\"]")).not.toBeNull());
  const video = document.querySelector<HTMLVideoElement>("#editor .pc video")!;
  const key = (k: string): void => { document.getElementById("editor-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: `Key${k.toUpperCase()}`, bubbles: true })); };

  // Split at 6 s, the part after it selected, Remove it; while that saves, C on the same part.
  video.currentTime = 6;
  key("s");
  await vi.waitFor(() => expect(document.getElementById("editor-remove")!.getAttribute("aria-disabled")).toBe("false"));
  click(document.getElementById("editor-remove")!);
  await vi.waitFor(() => expect(choices.filter((c) => c.action === "save")).toHaveLength(1));
  key("c");
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The camera change waits for the cut: nothing more is sent while it saves.
  expect(choices.filter((c) => c.action === "save")).toHaveLength(1);
  await land();
  await vi.waitFor(() => expect(choices.filter((c) => c.action === "save")).toHaveLength(2));
  await land();
  const saves = choices.filter((c): c is Extract<EditorChoice, { action: "save" }> => c.action === "save");
  expect(saves[0]).toMatchObject({ removed: [[540_000, 900_000]], revision: 0 });
  // Against the revision the cut brought, with the cut kept.
  expect(saves[1]).toMatchObject({ removed: [[540_000, 900_000]], revision: 1, scene: { camera: { shown: true, hidden: [[540_000, 900_000]] } } });
  await vi.waitFor(() => expect(editor!.revision).toBe(2));

  // S pressed at 2 s while a change saves; the playhead moves to 3 s before the save lands: the split is at 2 s.
  video.currentTime = 1;
  key("s");
  await vi.waitFor(() => expect(document.querySelectorAll(".editor-part").length).toBeGreaterThan(2));
  const parts = (): string[] => [...document.querySelectorAll<HTMLButtonElement>(".editor-part")].map((part) => part.getAttribute("aria-label") ?? "");
  // A change saving now: the camera shown again over the part after 1 s (its range the selection).
  key("c");
  await vi.waitFor(() => expect(choices.filter((c) => c.action === "save")).toHaveLength(3));
  video.currentTime = 2;
  key("s");
  video.currentTime = 3;
  await land();
  await vi.waitFor(() => expect(parts().some((label) => label.startsWith("0:02.0 to "))).toBe(true));
  expect(parts().some((label) => label.startsWith("0:03.0 to "))).toBe(false);
});
