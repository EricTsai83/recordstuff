// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click, menu } from "../../testing/test-interactions";
import type { LibraryItemView, SettingsView } from "../../../shared/settings-panel";
import type { EditorChoice, EditorView } from "../../../shared/editing";

const item: LibraryItemView = { id: "a", day: "Today", title: "Talk", name: "Talk.mp4", time: "2:02 PM", duration: "0:10", size: "18 MB",
  thumbnail: "recordstuff-media://thumb/a?v=1", video: "recordstuff-media://video/a?v=1" };

const ready = (overrides: Partial<EditorView> = {}): EditorView => ({
  id: "a", state: "ready", timescale: 90_000, duration: 900_000, seconds: 10, frameRate: 30, removed: [], skipped: [], revision: 0, notes: [],
  outputSeconds: 10, exportable: false, export: { phase: "idle" }, ...overrides,
});

/** The edit view (plan 085): opened from a card's menu, a part split off, removed and brought back, exported, closed. */
it("opens from a recording's menu, removes a part and takes it back, exports, and closes", async () => {
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
    switch (edit.action) {
      case "open": editor = ready(); break;
      case "save": editor = ready({ removed: edit.removed, skipped: edit.removed, revision: edit.revision + 1, exportable: edit.removed.length > 0,
        outputSeconds: 10 - edit.removed.reduce((sum, [from, to]) => sum + (to - from), 0) / 90_000 }); break;
      case "export": editor = { ...editor!, exportable: false, export: { phase: "exporting", progress: 0.4, cancelling: false } }; break;
      case "close": editor = undefined; break;
    }
    return { view: view(), applied: true };
  });
  let push!: (next: SettingsView) => void;
  window.settings = { read: async () => view(), capture: async () => view(), choose, ready: async () => {}, onChanged: (cb) => { push = cb; return () => {}; } };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(1));

  // Edit… in the card's menu opens the view on that recording.
  await menu(document.getElementById("clip-a-more")!);
  click(document.getElementById("clip-menu-edit")!);
  await vi.waitFor(() => expect(choices[0]).toEqual({ action: "open" }));
  await vi.waitFor(() => expect(document.querySelectorAll(".editor-part")).toHaveLength(1));
  const parts = (): Array<[string | null, boolean, boolean]> => [...document.querySelectorAll<HTMLButtonElement>(".editor-part")]
    .map((part) => [part.getAttribute("aria-label"), part.dataset.removed !== undefined, part.getAttribute("aria-pressed") === "true"]);
  expect(parts()).toEqual([["0:00.0 to 0:10.0, kept", false, false]]);
  expect(document.getElementById("editor-export")!.getAttribute("aria-disabled")).toBe("true");
  expect(document.getElementById("editor-remove")?.getAttribute("aria-disabled")).toBe("true");

  // S splits at the playhead (3 s); the part after it is selected.
  const video = document.querySelector<HTMLVideoElement>("#editor video")!;
  video.currentTime = 3;
  document.getElementById("editor-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
  await vi.waitFor(() => expect(parts()).toEqual([["0:00.0 to 0:03.0, kept", false, false], ["0:03.0 to 0:10.0, kept", false, true]]));
  expect(document.getElementById("editor-feedback")!.textContent).toBe("Split at 0:03.0");

  // Remove part: saved as one range, snapped to frames, against the revision shown.
  click(document.getElementById("editor-remove")!);
  await vi.waitFor(() => expect(choices.at(-1)).toEqual({ action: "save", removed: [[270_000, 900_000]], revision: 0 }));
  await vi.waitFor(() => expect(parts()[1]).toEqual(["0:03.0 to 0:10.0, removed", true, true]));
  await vi.waitFor(() => expect(document.getElementById("editor-feedback")!.textContent).toBe("Removed 0:03.0 to 0:10.0"));
  expect(document.querySelector(".editor-length")!.textContent).toBe("Export length 0:03.00");
  expect(document.querySelector("#editor-remove [data-shown]")!.textContent).toBe("Keep part");

  // ⌘Z takes it back.
  document.getElementById("editor-remove")!.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
  await vi.waitFor(() => expect(choices.at(-1)).toEqual({ action: "save", removed: [], revision: 1 }));
  await vi.waitFor(() => expect(document.getElementById("editor-feedback")!.textContent).toBe("Undone"));
  // ⇧⌘Z pressed straight after ⌘Z, while the undo still saves: it waits for that save rather than being lost.
  document.getElementById("editor-remove")!.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: true, bubbles: true }));
  document.getElementById("editor-remove")!.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
  await vi.waitFor(() => expect(choices.at(-1)).toEqual({ action: "save", removed: [], revision: 3 }));
  expect(choices.filter((choice) => choice.action === "save").at(-2)).toEqual({ action: "save", removed: [[270_000, 900_000]], revision: 2 });

  // The split is a step of its own (2026-10-25): Undo takes it back without a save, and Redo makes it again.
  expect(document.getElementById("editor-undo")?.getAttribute("aria-disabled")).toBe("false");
  const saves = choices.length;
  document.getElementById("editor-remove")!.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
  await vi.waitFor(() => expect(parts()).toHaveLength(1));
  expect(document.getElementById("editor-undo")?.getAttribute("aria-disabled")).toBe("true");
  document.getElementById("editor-remove")!.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: true, bubbles: true }));
  await vi.waitFor(() => expect(parts()).toHaveLength(2));
  expect(choices.length).toBe(saves);

  // Removed again, then exported: progress, then main's outcome.
  click(document.querySelectorAll<HTMLButtonElement>(".editor-part")[1]!);
  click(document.getElementById("editor-remove")!);
  await vi.waitFor(() => expect(document.getElementById("editor-export")!.getAttribute("aria-disabled")).toBe("false"));
  click(document.getElementById("editor-export")!);
  await vi.waitFor(() => expect(choices.at(-1)).toEqual({ action: "export" }));
  await vi.waitFor(() => expect(document.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("40"));
  // Closing waits for the export: Escape keeps the view, and its close says why.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(document.getElementById("editor")).not.toBeNull();
  expect(choices.some((choice) => choice.action === "close")).toBe(false);
  editor = { ...editor!, export: { phase: "done", name: "Talk (edited).mp4", message: "Exported as Talk (edited).mp4." } };
  push(view());
  await vi.waitFor(() => expect(document.querySelector(".editor-done")!.textContent).toBe("Exported as Talk (edited).mp4."));
  expect(document.getElementById("editor-reveal")!.textContent).toBe("Show in Finder");
  expect(document.getElementById("editor-export")!.textContent).toBe("Export again");

  // Escape closes it now, and the card has the focus back.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await vi.waitFor(() => expect(choices.at(-1)).toEqual({ action: "close" }));
  await vi.waitFor(() => expect(document.activeElement?.id).toBe("clip-a-open"));
});

it("says why an edit cannot be used and offers to discard it", async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="root"></div>';
  let editor: EditorView | undefined;
  let revision = 1;
  const view = (): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }], groups: [],
    library: { folder: "~/Movies", summary: "1 recording", items: [item] }, ...(editor ? { editor } : {}) });
  const choose = vi.fn(async (_group: string, choice: unknown): Promise<any> => {
    const edit = choice as EditorChoice;
    if (edit.action === "open") editor = ready({ state: "stale", message: "This recording has changed since it was edited, so its edit no longer fits it. Discard the edit to start again." });
    if (edit.action === "discard") editor = ready({ blocked: "Export is unavailable while recording." });
    return { view: view(), applied: true };
  });
  window.settings = { read: async () => view(), capture: async () => view(), choose, ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(1));
  await menu(document.getElementById("clip-a-more")!);
  click(document.getElementById("clip-menu-edit")!);
  await vi.waitFor(() => expect(document.querySelector(".editor-message")?.textContent).toMatch(/has changed since it was edited/));
  expect(document.querySelector(".editor-timeline")).toBeNull();
  click(document.getElementById("editor-discard")!);
  await vi.waitFor(() => expect(choose).toHaveBeenLastCalledWith("recordingEdit:a", { action: "discard" }));
  await vi.waitFor(() => expect(document.querySelector(".editor-timeline")).not.toBeNull());
  expect(document.querySelector(".editor-notes")!.textContent).toBe("Export is unavailable while recording.");
});
