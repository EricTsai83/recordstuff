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

/** The X clicked while a cut still saves: the view waits for the save, then closes (main drops a save of a closed view). */
it("closes only once the change still saving is saved", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  let revision = 1;
  let editor: EditorView | undefined;
  const view = (): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }], groups: [],
    library: { folder: "~/Movies", summary: "1 recording", items: [item] }, ...(editor ? { editor } : {}) });
  const choices: EditorChoice[] = [];
  let release!: () => void;
  const choose = vi.fn(async (group: string, choice: unknown): Promise<any> => {
    if (group !== "recordingEdit:a") return { view: view(), applied: true };
    const edit = choice as EditorChoice;
    choices.push(edit);
    switch (edit.action) {
      case "open": editor = ready(); break;
      case "save":
        await new Promise<void>((resolve) => { release = resolve; });
        editor = ready({ removed: edit.removed, skipped: edit.removed, revision: edit.revision + 1, exportable: true, outputSeconds: 3 });
        break;
      case "close": editor = undefined; break;
    }
    return { view: view(), applied: true };
  });
  window.settings = { read: async () => view(), capture: async () => view(), choose, ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(1));

  await menu(document.getElementById("clip-a-more")!);
  click(document.getElementById("clip-menu-edit")!);
  await vi.waitFor(() => expect(document.querySelectorAll(".editor-part")).toHaveLength(1));
  document.querySelector<HTMLVideoElement>("#editor video")!.currentTime = 3;
  document.getElementById("editor-split")!.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
  await vi.waitFor(() => expect(document.querySelectorAll(".editor-part")).toHaveLength(2));

  // Remove part, then the X straight away, while the save is unanswered: the view stays and close is not sent.
  click(document.getElementById("editor-remove")!);
  await vi.waitFor(() => expect(choices.at(-1)?.action).toBe("save"));
  click(document.getElementById("editor-close")!);
  click(document.getElementById("editor-close")!);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(choices.map((choice) => choice.action)).toEqual(["open", "save"]);
  expect(document.getElementById("editor")).not.toBeNull();

  // Once saved, it closes, once, and the card has the focus back.
  release();
  await vi.waitFor(() => expect(choices.map((choice) => choice.action)).toEqual(["open", "save", "close"]));
  await vi.waitFor(() => expect(document.activeElement?.id).toBe("clip-a-open"));
});
