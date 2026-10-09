// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click, enter, menu } from "../../testing/test-interactions";
import type { LibraryFolderView, LibraryItemView, LibraryView, SettingsView } from "../../../shared/settings-panel";

const item = (id: string, title: string, folder?: string): LibraryItemView => ({ id, day: "Today", title, name: `${title}.mp4`, time: "2:02 PM", duration: "1:23", size: "180 MB",
  thumbnail: `recordstuff-media://thumb/${id}?v=1`, video: `recordstuff-media://video/${id}?v=1`, ...(folder ? { folder } : {}) });

/** The Recordings tab's folders and search (plan 071): the bar, filtering, Move to, and the folder actions. */
it("shows a folder's recordings, searches them, moves one and makes, renames and deletes folders", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });

  let items = [item("a", "Intro"), item("b", "Product demo", "Demos"), item("c", "Bug report")];
  let folders: LibraryFolderView[] = [{ name: "Demos", empty: false }, { name: "Empty", empty: true }];
  let revision = 1;
  const view = (extra: Partial<SettingsView> = {}): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }, { id: "general", label: "General" }], groups: [],
    library: { folder: "~/Movies/RecordStuff", summary: `${items.length} recordings`, items, folders } satisfies LibraryView, ...extra });
  let current = view();
  const choose = vi.fn(async (group: string, choice: unknown): Promise<any> => {
    const action = (choice as { action?: string }).action;
    if (group === "recordingFile:a" && action === "move") {
      items = [item("a2", "Intro", "Demos"), ...items.filter(entry => entry.id !== "a")];
      return { view: current = view(), applied: true, renamed: "a2" };
    }
    if (group === "libraryFolder" && action === "createFolder") {
      const name = (choice as { name: string }).name;
      if (name === "Demos") return { view: current, applied: false, failure: "A folder or file with this name already exists." };
      folders = [...folders, { name, empty: true }];
      return { view: current = view(), applied: true, folder: name };
    }
    if (group === "libraryFolder" && action === "renameFolder") {
      const { folder, name } = choice as { folder: string; name: string };
      folders = folders.map(entry => entry.name === folder ? { ...entry, name } : entry);
      items = items.map(entry => entry.folder === folder ? { ...entry, folder: name } : entry);
      return { view: current = view(), applied: true, folder: name };
    }
    if (group === "libraryFolder" && action === "removeFolder") {
      const { folder } = choice as { folder: string };
      if (folders.find(entry => entry.name === folder)?.empty === false) return { view: current, applied: false, failure: "Only an empty folder can be deleted." };
      folders = folders.filter(entry => entry.name !== folder);
      return { view: current = view(), applied: true };
    }
    return { view: current, applied: true };
  });
  let push!: (next: SettingsView) => void;
  window.settings = { read: async () => current, capture: async () => current, choose, ready: async () => {}, onChanged: cb => { push = cb; return () => {}; } };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(3));
  const cards = () => [...document.querySelectorAll<HTMLElement>(".clip")].map(card => card.dataset.id);
  const chips = () => [...document.querySelectorAll<HTMLElement>(".library-folder")].map(chip =>
    [chip.querySelector(".library-folder-name")!.textContent, chip.querySelector(".library-folder-count")!.textContent, chip.getAttribute("aria-pressed")]);
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));

  // Every recording, then Unsorted and each folder with its count; the bar is named for assistive technology.
  expect(chips()).toEqual([["All", "3", "true"], ["Unsorted", "2", "false"], ["Demos", "1", "false"], ["Empty", "0", "false"]]);
  expect(document.querySelector(".library-folder-list")!.getAttribute("aria-label")).toBe("Folders");
  click(document.getElementById("library-folder-unsorted")!);
  expect(cards()).toEqual(["a", "c"]);
  click(document.getElementById("library-folder-0")!);
  expect([cards(), document.getElementById("library-folder-more")?.getAttribute("aria-label")]).toEqual([["b"], "Folder actions for Demos"]);
  click(document.getElementById("library-folder-1")!);
  expect([cards(), document.querySelector("#library-none-shown .library-empty-title")!.textContent]).toEqual([[], "This folder is empty."]);

  // Search narrows the folder shown, ignoring case; Escape clears it before it would close the window.
  click(document.getElementById("library-folder-all")!);
  const search = document.getElementById("library-search") as HTMLInputElement;
  expect(search.getAttribute("aria-label")).toBe("Search recordings");
  enter(search, "DEMO");
  expect(cards()).toEqual(["b"]);
  click(document.getElementById("library-folder-unsorted")!);
  expect([cards(), document.querySelector("#library-none-shown .library-empty-title")!.textContent]).toEqual([[], "No recordings match “DEMO”."]);
  const close = vi.spyOn(window, "close").mockImplementation(() => {});
  search.focus();
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  expect([search.value, cards(), close.mock.calls.length]).toEqual(["", ["a", "c"], 0]);

  // Move to: the menu offers every folder but the card's own place; the moved card leaves Unsorted and the move is said.
  await menu(document.getElementById("clip-a-more")!);
  // Keyboard first, as the menu's own items are reached: ArrowRight opens the submenu.
  const moveItem = document.getElementById("clip-menu-move")!;
  moveItem.focus();
  moveItem.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
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
  expect(chips()[2]).toEqual(["Demos", "2", "false"]);

  // Dropping a card on a folder moves it only when the dropped file is the card's own, by name and size (review pass 1,
  // F1); a drag forgotten when the window lost focus moves nothing.
  const drop = (target: HTMLElement, file: File): void => {
    const data = new DataTransfer();
    data.items.add(file);
    for (const type of ["dragover", "drop"]) target.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { dataTransfer: data }));
  };
  const bytes = (n: number, name: string): File => new File([new Uint8Array(n)], name);
  items = items.map(entry => entry.id === "c" ? { ...entry, bytes: 4 } : entry);
  push(current = view());
  await vi.waitFor(() => expect(document.getElementById("clip-c")).not.toBeNull());
  const dragStart = () => document.getElementById("clip-c")!.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
  dragStart();
  drop(document.getElementById("library-folder-1")!, bytes(5, "Bug report.mp4"));
  window.dispatchEvent(new Event("blur"));
  dragStart();
  window.dispatchEvent(new Event("blur"));
  drop(document.getElementById("library-folder-1")!, bytes(4, "Bug report.mp4"));
  await flush();
  expect(choose).not.toHaveBeenCalledWith("recordingFile:c", expect.objectContaining({ action: "move" }));
  dragStart();
  drop(document.getElementById("library-folder-1")!, bytes(4, "Bug report.mp4"));
  await vi.waitFor(() => expect(choose).toHaveBeenCalledWith("recordingFile:c", { action: "move", folder: "Empty" }));

  // New folder: a name the folder cannot take is refused before anything is sent; a taken one says so in the dialog.
  click(document.getElementById("library-new-folder")!);
  const input = () => document.getElementById("library-folder-input") as HTMLInputElement;
  await vi.waitFor(() => expect(input()).not.toBeNull());
  enter(input(), "Foo.app");
  input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(document.getElementById("library-folder-error")!.textContent).toBe("A folder name cannot end in an extension such as .app.");
  expect(choose).not.toHaveBeenCalledWith("libraryFolder", expect.objectContaining({ action: "createFolder" }));
  enter(input(), "Demos");
  input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await vi.waitFor(() => expect(document.getElementById("library-folder-error")!.textContent).toBe("A folder or file with this name already exists."));
  enter(input(), "Talks");
  input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  // Made: the dialog closes and the new folder is shown.
  await vi.waitFor(() => expect(document.getElementById("library-folder-dialog")?.hasAttribute("data-open") ?? false).toBe(false));
  expect(chips().at(-1)).toEqual(["Talks", "0", "true"]);
  expect(document.getElementById("feedback")!.textContent).toBe("Created Talks");

  // A dialog cancelled before main answers leaves the page where the user went since (review pass 2, F3).
  let answer!: () => void;
  choose.mockImplementationOnce(async (_group: string, choice: unknown) => {
    await new Promise<void>(resolve => { answer = resolve; });
    folders = [...folders, { name: (choice as { name: string }).name, empty: true }];
    return { view: current = view(), applied: true, folder: (choice as { name: string }).name };
  });
  click(document.getElementById("library-new-folder")!);
  await vi.waitFor(() => expect(input()).not.toBeNull());
  enter(input(), "Late");
  input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  click(document.getElementById("library-folder-all")!);
  answer();
  await vi.waitFor(() => expect(chips().map(chip => chip[0])).toContain("Late"));
  expect([chips()[0]![2], document.getElementById("feedback")!.textContent]).toEqual(["true", "Created Late"]);
  folders = folders.filter(entry => entry.name !== "Late");
  push(current = view());
  await vi.waitFor(() => expect(chips().map(chip => chip[0])).not.toContain("Late"));

  // Rename folder…: the folder shown keeps being shown under its new name.
  click(document.getElementById("library-folder-0")!);
  click(document.getElementById("library-folder-more")!);
  await vi.waitFor(() => expect(document.getElementById("library-folder-rename")).not.toBeNull());
  click(document.getElementById("library-folder-rename")!);
  await vi.waitFor(() => expect(input()?.value).toBe("Demos"));
  enter(input(), "Final");
  input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await vi.waitFor(() => expect(chips()[2]).toEqual(["Final", "2", "true"]));
  expect(cards().sort()).toEqual(["a2", "b"]);

  // Delete folder: one with recordings says why not; an empty one goes and every recording is shown.
  await flush();
  click(document.getElementById("library-folder-more")!);
  await vi.waitFor(() => expect(document.getElementById("library-folder-delete")).not.toBeNull());
  click(document.getElementById("library-folder-delete")!);
  await vi.waitFor(() => expect(document.querySelector(".library-error")!.textContent).toBe("Only an empty folder can be deleted."));
  click(document.getElementById("library-folder-1")!);
  click(document.getElementById("library-folder-more")!);
  await vi.waitFor(() => expect(document.getElementById("library-folder-delete")).not.toBeNull());
  click(document.getElementById("library-folder-delete")!);
  await vi.waitFor(() => expect(chips().map(chip => chip[0])).toEqual(["All", "Unsorted", "Final", "Talks"]));
  expect([chips()[0]![2], document.getElementById("feedback")!.textContent]).toEqual(["true", "Moved Empty to the Trash."]);

  // A folder that left the output folder elsewhere is no longer shown; every recording is.
  click(document.getElementById("library-folder-1")!);
  folders = folders.filter(entry => entry.name !== "Talks");
  push(current = view());
  await vi.waitFor(() => expect(chips()[0]![2]).toBe("true"));
  expect(cards()).toHaveLength(3);

  // An entry bringing a recording clears the search and shows every folder, so its card is there.
  click(document.getElementById("library-folder-unsorted")!);
  enter(search, "zzz");
  push(current = view({ resultFocus: 1, entryTab: "library", libraryFocus: "b" }));
  await vi.waitFor(() => expect(document.activeElement?.id).toBe("clip-b-open"));
  expect([search.value, chips()[0]![2]]).toEqual(["", "true"]);
});
