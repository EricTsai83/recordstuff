// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { menu } from "../../testing/test-interactions";
import type { LibraryItemView, SettingsView } from "../../../shared/settings-panel";
import type { EditorChoice } from "../../../shared/editing";

const item = (id: string, edited?: string): LibraryItemView => ({ id, day: "Today", title: id, name: `${id}.mp4`, time: "2:02 PM", duration: "0:10",
  size: "18 MB", thumbnail: `recordstuff-media://thumb/${id}?v=1`, video: `recordstuff-media://video/${id}?v=1`, ...(edited ? { edited } : {}) });

/**
 * A recording that holds an edit (2026-10-26, the maintainer's request): its menu offers Continue editing… in place of
 * Edit…; its card carries no mark (the maintainer's call the same day: shown whether or not it had been exported, it said
 * nothing to act on). A card without one offers Edit….
 */
it("offers Continue editing… for a recording that holds an edit, without a mark on its card", async () => {
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
  expect(document.querySelector("#clip-b .clip-edited-badge")).toBeNull();
  expect(document.getElementById("clip-a-open")!.getAttribute("aria-label")).not.toContain("Edited");
  await menu(document.getElementById("clip-b-more")!);
  expect(document.getElementById("clip-menu-edit")!.textContent).toBe("Edit…");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await vi.waitFor(() => expect(document.getElementById("clip-menu-edit")).toBeNull());
  await menu(document.getElementById("clip-a-more")!);
  expect(document.getElementById("clip-menu-edit")!.textContent).toBe("Continue editing…");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await vi.waitFor(() => expect(document.getElementById("clip-menu-edit")).toBeNull());

  // Not marked on the card (the maintainer's call of 2026-10-26): its words and its picture are as any recording's.
  expect(document.querySelector("#clip-a .clip-edited-badge")).toBeNull();
  expect(document.querySelector("#clip-a .clip-meta")!.textContent).not.toContain("Edited");
  expect(choices).toEqual([]);
});
