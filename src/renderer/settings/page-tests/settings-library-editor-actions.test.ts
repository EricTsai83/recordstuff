// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click, menu } from "../../testing/test-interactions";
import type { LibraryItemView, SettingsView } from "../../../shared/settings-panel";
import type { EditorChoice, EditorView } from "../../../shared/editing";

const item: LibraryItemView = { id: "a", day: "Today", title: "Talk", name: "Talk.mp4", time: "2:02 PM", duration: "0:10", size: "18 MB",
  thumbnail: "recordstuff-media://thumb/a?v=1", video: "recordstuff-media://video/a?v=1" };
const ready: EditorView = { id: "a", state: "ready", timescale: 90_000, duration: 900_000, seconds: 10, frameRate: 30, removed: [], skipped: [],
  revision: 0, notes: [], outputSeconds: 10, exportable: false, export: { phase: "idle" } };

/**
 * The edit view's toolbar and its line over the timeline (2026-10-26, the maintainer's choice of layouts, B′): Split and
 * Remove in words in the toolbar, no times there; the line over the timeline holds the playhead's time and the export's
 * length, and a selection's actions float on it while a part or range is chosen, its length first, Remove with its key.
 */
it("keeps the toolbar to the edits and floats a selection's actions over the timeline", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  let revision = 1;
  let editor: EditorView | undefined;
  const view = (): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }], groups: [],
    library: { folder: "~/Movies", summary: "1 recording", items: [item] }, ...(editor ? { editor } : {}) });
  const choose = vi.fn(async (group: string, choice: unknown): Promise<any> => {
    if (group === "recordingEdit:a" && (choice as EditorChoice).action === "open") editor = ready;
    return { view: view(), applied: true };
  });
  window.settings = { read: async () => view(), capture: async () => view(), choose, ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(1));
  await menu(document.getElementById("clip-a-more")!);
  click(document.getElementById("clip-menu-edit")!);
  await vi.waitFor(() => expect(document.getElementById("editor-split")).not.toBeNull());

  const toolbar = document.querySelector("#editor .editor-toolbar")!;
  expect(toolbar.querySelector("#editor-split")!.textContent).toBe("Split");
  expect(toolbar.querySelector("#editor-remove")!.textContent).toBe("Remove");
  expect(toolbar.querySelector("#editor-remove")!.getAttribute("aria-disabled")).toBe("true");
  expect(toolbar.textContent).not.toContain("Export length");
  const row = document.querySelector("#editor .editor-action-row")!;
  expect(row.querySelector(".editor-length")!.textContent).toBe("Export length 0:10.00");
  expect(row.querySelector(".editor-position")!.textContent).toBe("Playhead 0:00.00");
  expect(document.getElementById("editor-selection-actions")).toBeNull();

  // Split at 4 s: the part after it is chosen, and its actions float with its length; Escape lets it go, and them.
  const video = document.querySelector<HTMLVideoElement>("#editor .pc video")!;
  video.currentTime = 4;
  document.getElementById("editor-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", bubbles: true }));
  await vi.waitFor(() => expect(document.getElementById("editor-selection-actions")).not.toBeNull());
  const actions = document.getElementById("editor-selection-actions")!;
  expect(actions.getAttribute("role")).toBe("toolbar");
  expect(actions.querySelector(".editor-selection-length")!.textContent).toBe("0:06.00");
  expect(actions.querySelector("#editor-remove-selection")!.textContent).toBe("Remove⌫");
  expect(row.querySelector(".editor-position")!.hasAttribute("data-covered")).toBe(true);
  expect(toolbar.querySelector("#editor-remove")!.getAttribute("aria-disabled")).toBe("false");
});
