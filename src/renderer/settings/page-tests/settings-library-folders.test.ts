// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click, enter, menu } from "../../testing/test-interactions";
import type { LibraryFolderView, LibraryItemView, LibraryView, SettingsView } from "../../../shared/settings-panel";

const item = (id: string, title: string, folder?: string): LibraryItemView => ({ id, day: "Today", title, name: `${title}.mp4`, time: "2:02 PM", duration: "1:23", size: "180 MB",
  thumbnail: `recordstuff-media://thumb/${id}?v=1`, video: `recordstuff-media://video/${id}?v=1`, ...(folder ? { folder } : {}) });

/**
 * The Recordings tab's categories (plan 071, 2026-10-09): the selector with its favorites, the category heading with its
 * star and settings, Move to, search, and the category shown remembered by main.
 */
it("opens on the remembered category, selects, favorites, makes, renames and deletes categories, and moves recordings", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });

  let items = [item("a", "Intro"), item("b", "Product demo", "Demos"), item("c", "Bug report")];
  let folders: LibraryFolderView[] = [{ name: "Demos", empty: false }, { name: "Empty", empty: true }];
  let favorites = ["Demos"];
  let shown: string | null | undefined = "Demos";
  let revision = 1;
  const view = (extra: Partial<SettingsView> = {}): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }, { id: "general", label: "General" }], groups: [],
    library: { folder: "~/Movies/RecordStuff", summary: `${items.length} recordings`, items, folders,
      ...(favorites.length ? { favorites } : {}), ...(shown === undefined ? {} : { shown: { folder: shown } }) } satisfies LibraryView, ...extra });
  let current = view();
  const choose = vi.fn(async (group: string, choice: unknown): Promise<any> => {
    const action = (choice as { action?: string }).action;
    if (group === "libraryFolder" && action === "showFolder") shown = (choice as { folder: string | null }).folder;
    if (group === "libraryFolder" && action === "showAll") shown = undefined;
    if (group === "libraryFolder" && action === "favorite") {
      const { folder, favorite } = choice as { folder: string; favorite: boolean };
      favorites = favorite ? [...favorites.filter(name => name !== folder), folder] : favorites.filter(name => name !== folder);
    }
    if (group === "recordingFile:a" && action === "move") {
      items = [item("a2", "Intro", (choice as { folder: string }).folder), ...items.filter(entry => entry.id !== "a")];
      return { view: current = view(), applied: true, renamed: "a2" };
    }
    if (group === "libraryFolder" && action === "createFolder") {
      const name = (choice as { name: string }).name;
      if (name === "Demos") return { view: current, applied: false, failure: "This name is already in use." };
      folders = [...folders, { name, empty: true }];
      return { view: current = view(), applied: true, folder: name };
    }
    if (group === "libraryFolder" && action === "renameFolder") {
      const { folder, name } = choice as { folder: string; name: string };
      folders = folders.map(entry => entry.name === folder ? { ...entry, name } : entry);
      items = items.map(entry => entry.folder === folder ? { ...entry, folder: name } : entry);
      favorites = favorites.map(entry => entry === folder ? name : entry);
      if (shown === folder) shown = name;
      return { view: current = view(), applied: true, folder: name };
    }
    if (group === "libraryFolder" && action === "removeFolder") {
      const { folder } = choice as { folder: string };
      if (folders.find(entry => entry.name === folder)?.empty === false) return { view: current, applied: false, failure: "Only an empty category can be deleted." };
      folders = folders.filter(entry => entry.name !== folder);
      favorites = favorites.filter(entry => entry !== folder);
      if (shown === folder) shown = undefined;
      return { view: current = view(), applied: true };
    }
    return { view: current = view(), applied: true };
  });
  let push!: (next: SettingsView) => void;
  window.settings = { read: async () => current, capture: async () => current, choose, ready: async () => {}, onChanged: cb => { push = cb; return () => {}; } };
  await import("../settings");
  const cards = () => [...document.querySelectorAll<HTMLElement>(".clip")].map(card => card.dataset.id);
  const picker = () => document.getElementById("library-category")!;
  const heading = () => document.getElementById("library-category-head");
  const options = () => [...document.querySelectorAll<HTMLElement>('#library-category-list [role="option"]')].map(option =>
    [option.closest('[role="group"]')!.getAttribute("aria-label") ?? "", option.querySelector(".library-category-label")!.textContent, option.querySelector(".library-category-count")!.textContent, option.getAttribute("aria-selected")]);
  const filter = () => document.getElementById("library-category-filter") as HTMLInputElement;
  const key = (target: HTMLElement, name: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  const openPicker = async () => {
    click(picker());
    await vi.waitFor(() => expect(document.activeElement).toBe(filter()));
  };
  const pick = async (label: string) => {
    await openPicker();
    click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.querySelector(".library-category-label")?.textContent === label)!);
    await vi.waitFor(() => expect(picker().textContent).toBe(label));
  };

  // The remembered category, as main gave it: its cards, its name on the selector and its heading.
  await vi.waitFor(() => expect(cards()).toEqual(["b"]));
  expect([picker().textContent, picker().getAttribute("aria-label")]).toEqual(["Demos", "Category: Demos"]);
  expect([heading()!.querySelector(".library-category-title")!.textContent, heading()!.querySelector(".library-category-total")!.textContent]).toEqual(["Demos", "1 recording"]);
  // No line of folders or favorites in the head: they live in the selector.
  expect(document.querySelector(".library-folder-list, .settings-head-folders")).toBeNull();

  // The selector: every recording and Uncategorized, then the favorites, then the other categories, the shown one checked.
  await openPicker();
  expect(options()).toEqual([["", "All", "3", "false"], ["", "Uncategorized", "2", "false"], ["Favorites", "Demos", "1", "true"], ["All categories", "Empty", "0", "false"]]);
  // Typing narrows it; Enter takes the first match, which main remembers.
  enter(filter(), "emp");
  expect(options().map(option => option[1])).toEqual(["Empty"]);
  key(filter(), "Enter");
  await vi.waitFor(() => expect(picker().textContent).toBe("Empty"));
  expect(choose).toHaveBeenCalledWith("libraryFolder", { action: "showFolder", folder: "Empty" });
  expect([cards(), document.querySelector("#library-none-shown .library-empty-title")!.textContent]).toEqual([[], "This category is empty."]);
  // A filter that matches nothing says so.
  await openPicker();
  enter(filter(), "zzz");
  expect(document.querySelector(".library-category-none")!.textContent).toBe("No categories match “zzz”.");
  // The arrows move through the list: down once from the top is Uncategorized.
  enter(filter(), "");
  key(filter(), "ArrowDown");
  await vi.waitFor(() => expect(filter().getAttribute("aria-activedescendant")).toBe("library-category-option-1"));
  key(filter(), "Enter");
  await vi.waitFor(() => expect(cards()).toEqual(["a", "c"]));
  expect(choose).toHaveBeenLastCalledWith("libraryFolder", { action: "showFolder", folder: null });
  // Uncategorized has a heading but no star or settings.
  expect([heading()!.querySelector(".library-category-title")!.textContent, document.getElementById("library-category-favorite")]).toEqual(["Uncategorized", null]);

  // A later view does not take the tab back to the category main remembered at first.
  push(current = view());
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(picker().textContent).toBe("Uncategorized");

  // Search narrows the category shown, ignoring case; Escape clears it before it would close the window.
  const search = document.getElementById("library-search") as HTMLInputElement;
  // The field shows the keys at once; the cards follow a deferred copy of the search, a moment later.
  enter(search, "BUG");
  expect(search.value).toBe("BUG");
  await vi.waitFor(() => expect(cards()).toEqual(["c"]));
  const close = vi.spyOn(window, "close").mockImplementation(() => {});
  search.focus();
  key(search, "Escape");
  expect([search.value, close.mock.calls.length]).toEqual(["", 0]);
  await vi.waitFor(() => expect(cards()).toEqual(["a", "c"]));

  // Move to: every category but the card's own place; the moved card leaves Uncategorized and the move is said.
  await menu(document.getElementById("clip-a-more")!);
  const moveItem = document.getElementById("clip-menu-move")!;
  moveItem.focus();
  key(moveItem, "ArrowRight");
  const targets = await vi.waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('[id^="clip-menu-move-"]')].map(entry => entry.textContent);
    if (!found.length) throw new Error("Move to has not opened");
    return found;
  });
  expect(targets).toEqual(["Demos", "Empty"]);
  click(document.getElementById("clip-menu-move-0")!);
  await vi.waitFor(() => expect(cards()).toEqual(["c"]));
  expect(choose).toHaveBeenCalledWith("recordingFile:a", { action: "move", folder: "Demos" });
  expect(document.getElementById("feedback")!.textContent).toBe("Moved Intro.mp4 to Demos");

  // The star adds the category shown to favorites, or takes it out.
  await pick("Empty");
  const star = () => document.getElementById("library-category-favorite")!;
  expect([star().getAttribute("aria-pressed"), star().getAttribute("aria-label")]).toEqual(["false", "Add to favorites"]);
  click(star());
  await vi.waitFor(() => expect(star().getAttribute("aria-pressed")).toBe("true"));
  // A favorite's star is filled in the primary colour.
  expect([star().classList.contains("text-primary"), star().querySelector("svg")!.classList.contains("fill-current")]).toEqual([true, true]);
  expect(document.getElementById("feedback")!.textContent).toBe("Added Empty to favorites");
  await openPicker();
  expect(options().filter(option => option[0] === "Favorites").map(option => option[1])).toEqual(["Demos", "Empty"]);

  // New category, from the selector's foot: a name main would refuse is refused before anything is sent; a taken one says
  // so in the dialog; a made one is shown and remembered.
  click(document.getElementById("library-category-new")!);
  const input = () => document.getElementById("library-folder-input") as HTMLInputElement;
  await vi.waitFor(() => expect(input()).not.toBeNull());
  enter(input(), "Foo.app");
  key(input(), "Enter");
  expect(document.getElementById("library-folder-error")!.textContent).toBe("A category name cannot end in an extension such as .app.");
  expect(choose).not.toHaveBeenCalledWith("libraryFolder", expect.objectContaining({ action: "createFolder" }));
  enter(input(), "Demos");
  key(input(), "Enter");
  await vi.waitFor(() => expect(document.getElementById("library-folder-error")!.textContent).toBe("This name is already in use."));
  enter(input(), "Talks");
  key(input(), "Enter");
  await vi.waitFor(() => expect(picker().textContent).toBe("Talks"));
  expect(choose).toHaveBeenCalledWith("libraryFolder", { action: "showFolder", folder: "Talks" });
  expect(document.getElementById("feedback")!.textContent).toBe("Created Talks");

  // Rename category…, from the heading's settings: still shown, under its new name.
  const settingsItem = async (id: string) => {
    click(document.getElementById("library-category-settings")!);
    await vi.waitFor(() => expect(document.getElementById(id)).not.toBeNull());
    click(document.getElementById(id)!);
  };
  await pick("Demos");
  await settingsItem("library-category-rename");
  await vi.waitFor(() => expect(input()?.value).toBe("Demos"));
  enter(input(), "Final");
  key(input(), "Enter");
  await vi.waitFor(() => expect(picker().textContent).toBe("Final"));
  expect(cards().sort()).toEqual(["a2", "b"]);

  // The settings menu holds rename and delete; the star alone adds or removes the favorite.
  click(document.getElementById("library-category-settings")!);
  await vi.waitFor(() => expect(document.getElementById("library-category-delete")).not.toBeNull());
  expect([...document.querySelectorAll('[id^="library-category-"][role="menuitem"]')].map(entry => entry.id)).toEqual(["library-category-rename", "library-category-delete"]);
  key(document.activeElement as HTMLElement, "Escape");
  // Delete category: one with recordings says why in a toast that leaves by itself, never a line that stays (2026-10-09);
  // the category and its recordings stay.
  const toast = () => document.querySelector<HTMLElement>('.undo-toast:not([data-removed="true"])');
  await settingsItem("library-category-delete");
  await vi.waitFor(() => expect([toast()?.querySelector(".toast-title")?.textContent, toast()?.querySelector(".toast-description")?.textContent])
    .toEqual(["Could not delete “Final”", "“Final” still holds 2 recordings. Move them to another category or to the Trash first."]));
  expect([toast()!.querySelector(".toast-action"), picker().textContent, cards().length, document.querySelector<HTMLElement>(".library-error")!.hidden]).toEqual([null, "Final", 2, true]);
  // An empty one goes to the Trash, says so the same way, and every recording is shown.
  await pick("Talks");
  await settingsItem("library-category-delete");
  await vi.waitFor(() => expect(picker().textContent).toBe("All"));
  expect([heading(), document.getElementById("feedback")!.textContent]).toEqual([null, "Moved Talks to the Trash."]);
  await vi.waitFor(() => expect([toast()?.querySelector(".toast-title")?.textContent, toast()?.querySelector(".toast-description")?.textContent]).toEqual(["Moved to the Trash", "Talks"]));

  // An entry bringing a recording clears the search and shows every recording, which main then remembers.
  await pick("Uncategorized");
  enter(search, "zzz");
  push(current = view({ resultFocus: 1, entryTab: "library", libraryFocus: "b" }));
  await vi.waitFor(() => expect(document.activeElement?.id).toBe("clip-b-open"));
  expect([search.value, picker().textContent]).toEqual(["", "All"]);
  expect(choose).toHaveBeenLastCalledWith("libraryFolder", { action: "showAll" });
});
