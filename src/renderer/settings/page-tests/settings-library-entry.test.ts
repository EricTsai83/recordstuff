// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click } from "../../testing/test-interactions";
import type { LibraryItemView, SettingsView } from "../../../shared/settings-panel";

const item = (id: string, title: string, folder?: string): LibraryItemView => ({ id, day: "Today", title, name: `${title}.mp4`, time: "2:02 PM", duration: "1:23", size: "180 MB",
  thumbnail: `recordstuff-media://thumb/${id}?v=1`, video: `recordstuff-media://video/${id}?v=1`, ...(folder ? { folder } : {}) });

/**
 * The selector's own edges (2026-10-09 review): an entry in a new window wins over the remembered category, Uncategorized
 * stays shown with no category left, Escape gives the focus back to the selector, and the arrows keep their option in view.
 */
it("lets an entry override the remembered category, keeps Uncategorized, and keeps the selector's focus and scroll", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  let revision = 1;
  let folders = [{ name: "Demos", empty: false }];
  const items = [item("a", "Intro"), item("b", "Product demo", "Demos")];
  const view = (extra: Partial<SettingsView> = {}, shown: { folder: string | null } | undefined = { folder: "Demos" }): SettingsView => ({
    language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }, { id: "general", label: "General" }], groups: [],
    library: { folder: "~/Movies", summary: "2 recordings", items, folders, ...(shown ? { shown } : {}) }, ...extra });
  // A new window opened by a saved notification for the recording in Uncategorized, while Demos is remembered.
  let current = view({ resultFocus: 1, entryTab: "library", libraryFocus: "a" });
  const choose = vi.fn(async (): Promise<any> => ({ view: current, applied: true }));
  let push!: (next: SettingsView) => void;
  window.settings = { read: async () => current, capture: async () => current, choose, ready: async () => {}, onChanged: cb => { push = cb; return () => {}; } };
  await import("../settings");
  const picker = () => document.getElementById("library-category")!;
  await vi.waitFor(() => expect(document.activeElement?.id).toBe("clip-a-open"));
  expect(picker().textContent).toBe("All");
  expect(choose).toHaveBeenCalledWith("libraryFolder", { action: "showAll" });

  // Uncategorized stays shown when no category is left (review F2), on this view and the next.
  click(picker());
  const filter = () => document.getElementById("library-category-filter") as HTMLInputElement;
  await vi.waitFor(() => expect(document.activeElement).toBe(filter()));
  // The arrows bring their option into view inside the list (review F5).
  const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
  filter().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(scrolled.mock.contexts.some(element => (element as Element).id === "library-category-option-1")).toBe(true));
  filter().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(picker().textContent).toBe("Uncategorized"));
  folders = [];
  push(current = view({}, { folder: null }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(picker().textContent).toBe("Uncategorized");

  // An input method's Enter while composing chooses its characters, not a category (review pass 2, F2).
  click(picker());
  await vi.waitFor(() => expect(document.activeElement).toBe(filter()));
  filter().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect([document.activeElement, picker().textContent]).toEqual([filter(), "Uncategorized"]);
  // Leaving the list by Tab or a click keeps the focus where it went (review pass 2, F1).
  const search = document.getElementById("library-search") as HTMLInputElement;
  search.focus();
  search.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  click(search);
  await vi.waitFor(() => expect(document.querySelector(".library-category-popup[data-open]")).toBeNull());
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.activeElement).toBe(search);

  // Escape closes the list and gives the focus back to the selector (review F4).
  click(picker());
  await vi.waitFor(() => expect(document.activeElement).toBe(filter()));
  filter().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(document.activeElement).toBe(picker()));
  await vi.waitFor(() => expect(document.querySelector(".library-category-popup[data-open]")).toBeNull());
});
