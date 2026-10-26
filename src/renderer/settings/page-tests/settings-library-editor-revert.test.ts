// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click, menu } from "../../testing/test-interactions";
import type { LibraryItemView, SettingsView } from "../../../shared/settings-panel";
import type { EditorChoice, EditorView, EditRange } from "../../../shared/editing";
import type { EditScene } from "../../../shared/editable";

const item: LibraryItemView = { id: "a", day: "Today", title: "Talk", name: "Talk.mp4", time: "2:02 PM", duration: "0:10", size: "18 MB",
  thumbnail: "recordstuff-media://thumb/a?v=1", video: "recordstuff-media://video/a?v=1" };
const RECORDED: EditScene = { camera: { x: 0.97, y: 0.05, width: 0.2, height: 0.3, shown: true }, volumes: { system: 100, microphone: 100 } };
const ready = (removed: EditRange[], scene: EditScene, revision: number): EditorView => ({
  id: "a", state: "ready", timescale: 90_000, duration: 900_000, seconds: 10, frameRate: 30, removed, skipped: removed, revision, notes: [],
  outputSeconds: 10, exportable: true, export: { phase: "idle" },
  editable: { sounds: ["system", "microphone"], camera: { rounding: 0.15, mirror: false }, scene, recorded: RECORDED, preview: {} },
});

/**
 * Revert to original recording (2026-10-26, the maintainer's request): in Options, unavailable while nothing is
 * edited; it asks first, then keeps every part again and puts the camera and volumes back as recorded in one save,
 * which Undo takes back.
 */
it("reverts the whole edit in one change, which Undo takes back", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  let revision = 1;
  const edited: EditScene = { ...RECORDED, volumes: { system: 40, microphone: 100 } };
  let editor: EditorView | undefined;
  const view = (): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }], groups: [],
    library: { folder: "~/Movies", summary: "1 recording", items: [item] }, ...(editor ? { editor } : {}) });
  const saves: EditorChoice[] = [];
  const choose = vi.fn(async (group: string, choice: unknown): Promise<any> => {
    const edit = choice as EditorChoice;
    if (group === "recordingEdit:a" && edit.action === "open") editor = ready([[90_000, 180_000]], edited, 3);
    if (group === "recordingEdit:a" && edit.action === "save") {
      saves.push(edit);
      editor = ready(edit.removed, edit.scene ?? editor!.editable!.scene, edit.revision + 1);
    }
    return { view: view(), applied: true };
  });
  window.settings = { read: async () => view(), capture: async () => view(), choose, ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(1));
  await menu(document.getElementById("clip-a-more")!);
  click(document.getElementById("clip-menu-edit")!);
  await vi.waitFor(() => expect(document.getElementById("editor-options")).not.toBeNull());
  click(document.getElementById("editor-options")!);
  await vi.waitFor(() => expect(document.getElementById("editor-revert")).not.toBeNull());
  expect(document.getElementById("editor-revert")!.getAttribute("aria-disabled")).toBe("false");

  // It asks first (the maintainer's request): Cancel leaves the edit as it is.
  click(document.getElementById("editor-revert")!);
  await vi.waitFor(() => expect(document.getElementById("editor-revert-confirm")).not.toBeNull());
  expect(document.getElementById("editor-revert-confirm")!.getAttribute("role")).toBe("alertdialog");
  expect(document.getElementById("editor-revert-confirm")!.textContent).toContain("Undo (⌘Z) brings them back while this view is open");
  click(document.getElementById("editor-revert-cancel")!);
  await vi.waitFor(() => expect(document.getElementById("editor-revert-confirm")).toBeNull());
  expect(saves).toEqual([]);
  // The dialog took the place of Options, which open again for the second try.
  if (!document.getElementById("editor-revert")) click(document.getElementById("editor-options")!);
  await vi.waitFor(() => expect(document.getElementById("editor-revert")).not.toBeNull());
  click(document.getElementById("editor-revert")!);
  await vi.waitFor(() => expect(document.getElementById("editor-revert-confirm-button")).not.toBeNull());
  click(document.getElementById("editor-revert-confirm-button")!);
  await vi.waitFor(() => expect(saves).toEqual([{ action: "save", removed: [], revision: 3, scene: RECORDED }]));
  if (!document.getElementById("editor-revert")) click(document.getElementById("editor-options")!);
  await vi.waitFor(() => expect(document.getElementById("editor-revert")!.getAttribute("aria-disabled")).toBe("true"));
  expect(document.getElementById("editor-revert-note")!.textContent).toBe("Nothing is edited yet.");
  expect(document.getElementById("editor-feedback")!.textContent).toBe("Back to the original recording");

  document.getElementById("editor-undo")!.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
  await vi.waitFor(() => expect(saves.at(-1)).toEqual({ action: "save", removed: [[90_000, 180_000]], revision: 4, scene: edited }));
});
