// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click } from "../../testing/test-interactions";
import type { LibraryItemView, SettingsView } from "../../../shared/settings-panel";
import type { EditorChoice } from "../../../shared/editing";

const item = (id: string, editable?: string): LibraryItemView => ({ id, day: "Today", title: id, name: `${id}.mp4`, time: "2:02 PM", duration: "0:10",
  size: "18 MB", thumbnail: `recordstuff-media://thumb/${id}?v=1`, video: `recordstuff-media://video/${id}?v=1`, ...(editable ? { editable } : {}) });

/**
 * An editable recording's card (2026-10-26, the maintainer's request): its Editable mark, a click on which opens the
 * edit view on that recording and does not play it; a card that is not editable has no mark.
 */
it("opens the edit view from an editable card's mark, not the player", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  let revision = 1;
  const view = (): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }], groups: [],
    library: { folder: "~/Movies", summary: "2 recordings", items: [item("a", "Editable"), item("b")] } });
  const choices: Array<[string, EditorChoice]> = [];
  const choose = vi.fn(async (group: string, choice: unknown): Promise<any> => {
    if (group.startsWith("recordingEdit:")) choices.push([group, choice as EditorChoice]);
    return { view: view(), applied: true };
  });
  window.settings = { read: async () => view(), capture: async () => view(), choose, ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(2));
  expect(document.querySelector("#clip-b .clip-editable")).toBeNull();
  const mark = document.querySelector<HTMLElement>("#clip-a .clip-meta .clip-editable")!;
  expect(mark.textContent).toBe("Editable");

  click(mark);
  await vi.waitFor(() => expect(choices).toEqual([["recordingEdit:a", { action: "open" }]]));
  expect(document.querySelector("#editor[data-open]")).not.toBeNull();
  expect(document.querySelector(".player[data-open]")).toBeNull();
});
