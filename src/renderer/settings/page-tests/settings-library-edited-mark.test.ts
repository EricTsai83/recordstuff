// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click, menu } from "../../testing/test-interactions";
import type { LibraryItemView, SettingsView } from "../../../shared/settings-panel";
import type { EditorChoice } from "../../../shared/editing";

const item = (id: string, edited?: string): LibraryItemView => ({ id, day: "Today", title: id, name: `${id}.mp4`, time: "2:02 PM", duration: "0:10",
  size: "18 MB", thumbnail: `recordstuff-media://thumb/${id}?v=1`, video: `recordstuff-media://video/${id}?v=1`, ...(edited ? { edited } : {}) });

/**
 * A recording that holds an edit (2026-10-26, the maintainer's request): its card says Edited, a click on which opens
 * the edit view where it was left, and its menu offers Continue editing… in place of Edit…; a card without one has
 * neither.
 */
it("marks an edited recording, opens its edit from the mark, and offers Continue editing…", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  let revision = 1;
  const view = (): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }], groups: [],
    library: { folder: "~/Movies", summary: "2 recordings", items: [item("a", "Edited"), item("b")] } });
  const choices: Array<[string, EditorChoice]> = [];
  const choose = vi.fn(async (group: string, choice: unknown): Promise<any> => {
    if (group.startsWith("recordingEdit:")) choices.push([group, choice as EditorChoice]);
    return { view: view(), applied: true };
  });
  window.settings = { read: async () => view(), capture: async () => view(), choose, ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(2));
  expect(document.querySelector("#clip-b .clip-edited")).toBeNull();
  expect(document.getElementById("clip-a-open")!.getAttribute("aria-label")).toContain("Edited");
  await menu(document.getElementById("clip-b-more")!);
  expect(document.getElementById("clip-menu-edit")!.textContent).toBe("Edit…");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await vi.waitFor(() => expect(document.getElementById("clip-menu-edit")).toBeNull());
  await menu(document.getElementById("clip-a-more")!);
  expect(document.getElementById("clip-menu-edit")!.textContent).toBe("Continue editing…");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await vi.waitFor(() => expect(document.getElementById("clip-menu-edit")).toBeNull());

  const mark = document.querySelector<HTMLElement>("#clip-a .clip-meta .clip-edited")!;
  expect(mark.textContent).toBe("Edited");
  click(mark);
  await vi.waitFor(() => expect(choices).toEqual([["recordingEdit:a", { action: "open" }]]));
  expect(document.querySelector(".player[data-open]")).toBeNull();
});
