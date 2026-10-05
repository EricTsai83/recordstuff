// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { LibraryItemView, LibraryView, SettingsView } from "../shared/settings-panel";

const item = (id: string, title: string, name = `${id}.mp4`): LibraryItemView => ({ id, day: "Today", title, name, duration: "1:23", size: "180 MB",
  thumbnail: `recordstuff-media://thumb/${id}?v=1`, video: `recordstuff-media://video/${id}?v=1` });

/** The Recordings tab's layout switch, Move to Trash with Undo (the bar and ⌘Z), and a card's Rename… (2026-10-05). */
it("switches layout, brings back a trashed recording, and renames one in place", async () => {
  document.body.innerHTML = '<h1 id="title"></h1><div id="status"><p id="status-title"></p><p id="status-detail"></p><p id="hint"></p><button id="status-action" hidden></button></div><p id="feedback"></p><form id="settings"></form>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  HTMLElement.prototype.showPopover = function (this: HTMLElement) { this.dataset.open = ""; };
  HTMLElement.prototype.hidePopover = function (this: HTMLElement) { delete this.dataset.open; };
  const items = [item("a", "2:02 PM", "2026-10-05 14-02-11.mp4"), item("b", "Demo", "Demo.mp4")];
  const view = (library: Partial<LibraryView>, revision: number): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision,
    tabs: [{ id: "library", label: "Recordings" }, { id: "general", label: "General" }], groups: [],
    library: { folder: "~/Movies", summary: "2 recordings", items, ...library } });
  let revision = 1;
  let current = view({}, revision);
  /** A slow rename of the first card, answered when the test says. */
  let slow: ((value: unknown) => void) | undefined;
  const choose = vi.fn(async (group: string, choice: unknown): Promise<any> => {
    revision++;
    if (group === "recordingFile:a" && typeof choice === "object") {
      await new Promise(resolve => { slow = resolve; });
      current = view({ items: [item("d", "Slow", "Slow.mp4"), ...current.library!.items.filter(entry => entry.id !== "a")] }, ++revision);
      return { view: current, applied: true, renamed: "d" };
    }
    if (group === "library" && (choice === "grid" || choice === "list")) current = view({ ...current.library, layout: choice }, revision);
    if (group === "recordingFile:a" && choice === "trash") current = view({ items: [items[1]!], trashed: { name: "2026-10-05 14-02-11.mp4", message: "Moved 2026-10-05 14-02-11.mp4 to the Trash.", undo: "Undo" } }, revision);
    if (group === "library" && choice === "undoTrash") current = view({ items }, revision);
    if (typeof choice === "object" && choice !== null && (choice as { name: string }).name === "Taken") {
      return { view: current, applied: false, failure: "A file with this name is already in the folder." };
    }
    if (group === "recordingFile:b" && typeof choice === "object") {
      current = view({ items: [items[0]!, item("c", "Product demo", "Product demo.mp4")] }, revision);
      return { view: current, applied: true, renamed: "c" };
    }
    return { view: current, applied: true };
  });
  window.settings = { read: async () => current, capture: async () => current, choose, ready: async () => {}, onChanged: () => () => {} };
  await import("./settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(2));
  const library = document.getElementById("library")!;

  // The grid by default; the list is one click, shown at once and saved.
  expect(library.dataset.layout).toBe("grid");
  const list = document.getElementById("library-layout-list") as HTMLInputElement;
  expect([list.getAttribute("aria-label"), document.querySelector(".library-layout")!.getAttribute("aria-label")]).toEqual(["List", "Layout"]);
  list.checked = true; list.dispatchEvent(new Event("change"));
  expect(library.dataset.layout).toBe("list");
  await vi.waitFor(() => expect(choose).toHaveBeenCalledWith("library", "list"));
  expect(document.querySelector("#clip-a .clip-detail")!.textContent).toBe("1:23 · 180 MB");

  // Move to Trash: the card leaves, the bar offers Undo, and ⌘Z brings it back with the focus it had.
  const more = document.getElementById("clip-a-more") as HTMLButtonElement;
  more.click();
  document.getElementById("clip-menu-trash")!.click();
  await vi.waitFor(() => expect(document.getElementById("clip-a")).toBeNull());
  const bar = document.querySelector<HTMLElement>(".library-undo")!;
  expect([bar.hidden, bar.querySelector(".library-undo-text")!.textContent, document.getElementById("library-undo")!.textContent])
    .toEqual([false, "Moved 2026-10-05 14-02-11.mp4 to the Trash.", "Undo"]);
  expect(document.getElementById("feedback")!.textContent).toBe("Moved 2026-10-05 14-02-11.mp4 to the Trash.");
  document.getElementById("tab-library")!.focus();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(document.getElementById("clip-a")).not.toBeNull());
  expect(choose).toHaveBeenLastCalledWith("library", "undoTrash");
  expect([bar.hidden, document.getElementById("feedback")!.textContent, document.activeElement?.id]).toEqual([true, "Restored 2026-10-05 14-02-11.mp4", "clip-a-open"]);
  // With nothing waiting, ⌘Z is left to the Edit menu.
  const calls = choose.mock.calls.length;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
  expect(choose.mock.calls.length).toBe(calls);

  // Rename…: a sheet with the name selected and the extension kept; a taken name says so in the sheet.
  (document.getElementById("clip-b-more") as HTMLButtonElement).click();
  document.getElementById("clip-menu-rename")!.click();
  const sheet = document.getElementById("clip-rename")!;
  const input = document.getElementById("clip-rename-input") as HTMLInputElement;
  expect(["open" in sheet.dataset, input.value, sheet.querySelector(".clip-rename-extension")!.textContent, document.activeElement]).toEqual([true, "Demo", ".mp4", input]);
  expect(document.getElementById("clip-rename-label")!.textContent).toBe("New name for Today, Demo");
  // A name the folder cannot take is refused before anything is sent.
  input.value = "a/b";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(sheet.querySelector(".clip-rename-error")!.textContent).toBe("A name cannot contain / \\ : * ? \" < > |.");
  expect(choose).not.toHaveBeenCalledWith("recordingFile:b", expect.objectContaining({ action: "rename" }));
  input.value = "Taken";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await vi.waitFor(() => expect(sheet.querySelector(".clip-rename-error")!.textContent).toBe("A file with this name is already in the folder."));
  expect("open" in sheet.dataset).toBe(true);
  // Escape cancels, gives focus back to ⋯ and does not close the window.
  const close = vi.spyOn(window, "close").mockImplementation(() => {});
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  expect(["open" in sheet.dataset, document.activeElement?.id, close.mock.calls.length]).toEqual([false, "clip-b-more", 0]);
  // Renamed: the new card takes the focus, and it is said.
  (document.getElementById("clip-b-more") as HTMLButtonElement).click();
  document.getElementById("clip-menu-rename")!.click();
  input.value = " Product demo ";
  document.getElementById("clip-rename-confirm")!.click();
  await vi.waitFor(() => expect(document.getElementById("clip-c")).not.toBeNull());
  expect(choose).toHaveBeenLastCalledWith("recordingFile:b", { action: "rename", name: "Product demo" });
  expect(["open" in sheet.dataset, document.activeElement?.id, document.getElementById("feedback")!.textContent])
    .toEqual([false, "clip-c-open", "Renamed to Product demo.mp4"]);

  // A slow rename answered after its sheet was closed and another card's opened: the newer sheet keeps the focus.
  (document.getElementById("clip-a-more") as HTMLButtonElement).click();
  document.getElementById("clip-menu-rename")!.click();
  input.value = "Slow";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await vi.waitFor(() => expect(slow).toBeDefined());
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  (document.getElementById("clip-c-more") as HTMLButtonElement).click();
  document.getElementById("clip-menu-rename")!.click();
  expect([input.value, document.activeElement]).toEqual(["Product demo", input]);
  slow!(undefined);
  await vi.waitFor(() => expect(document.getElementById("clip-d")).not.toBeNull());
  expect(["open" in sheet.dataset, document.activeElement, input.value]).toEqual([true, input, "Product demo"]);
});
