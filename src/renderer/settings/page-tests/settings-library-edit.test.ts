// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click, enter, menu } from "../../testing/test-interactions";
import type { LibraryItemView, LibraryView, SettingsView } from "../../../shared/settings-panel";

const item = (id: string, title: string, name = `${id}.mp4`): LibraryItemView => ({ id, day: "Today", title, name, time: "2:02 PM", duration: "1:23", size: "180 MB",
  thumbnail: `recordstuff-media://thumb/${id}?v=1`, video: `recordstuff-media://video/${id}?v=1` });

/** The Recordings tab's layout switch, Move to Trash with Undo (the bar and ⌘Z), and a card's Rename… (2026-10-05). */
it("switches layout, brings back a trashed recording, and renames one in place", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });


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
  let push!: (next: SettingsView) => void;
  window.settings = { read: async () => current, capture: async () => current, choose, ready: async () => {}, onChanged: cb => { push = cb; return () => {}; } };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(2));
  const library = document.getElementById("library")!;

  // The grid by default; the list is one click, shown at once and saved.
  expect(library.dataset.layout).toBe("grid");
  const list = document.getElementById("library-layout-list") as HTMLInputElement;
  expect([list.getAttribute("aria-label"), document.querySelector(".library-layout")!.getAttribute("aria-label")]).toEqual(["List", "Layout"]);
  click(list);
  expect(library.dataset.layout).toBe("list");
  await vi.waitFor(() => expect(choose).toHaveBeenCalledWith("library", "list"));
  expect(document.querySelector("#clip-a .clip-detail")!.textContent).toBe("2:02 PM · 1:23 · 180 MB");

  // Move to Trash: the card leaves, the toast offers Undo with its ⌘Z, and the toast's Undo brings it back with the focus it had.
  // The toast is Sonner's own (2026-10-07): the one on screen, not one still sliding out; "closed" once it has gone.
  const toastOf = () => document.querySelector<HTMLElement>('.undo-toast:not([data-removed="true"])');
  const toastState = () => (toastOf() ? "open" : "closed");
  const trash = async (id: string): Promise<void> => {
    await menu(document.getElementById(`clip-${id}-more`)!);
    click(document.getElementById("clip-menu-trash")!);
    await vi.waitFor(() => expect(document.getElementById(`clip-${id}`)).toBeNull());
  };
  await trash("a");
  const toastText = () => { const t = toastOf()!, action = t.querySelector<HTMLElement>(".toast-action");
    return [toastState(), t.querySelector(".toast-title")!.textContent, t.querySelector(".toast-description")!.textContent,
      !action, action?.querySelector(".toast-action-label")?.textContent ?? null, action?.querySelector(".toast-key")?.textContent ?? null]; };
  await vi.waitFor(() => expect(toastText()).toEqual(["open", "Moved to the Trash", "2026-10-05 14-02-11.mp4", false, "Undo", "⌘Z"]));
  await vi.waitFor(() => expect(toastOf()!.querySelector(".toast-action")!.getAttribute("aria-keyshortcuts")).toBe("Meta+Z"));
  expect(document.getElementById("feedback")!.textContent).toBe("Moved 2026-10-05 14-02-11.mp4 to the Trash.");
  // The old bar under the header is gone.
  expect(document.querySelector(".library-undo")).toBeNull();
  toastOf()!.querySelector<HTMLButtonElement>(".toast-action")!.focus();
  click(toastOf()!.querySelector<HTMLButtonElement>(".toast-action")!);
  await vi.waitFor(() => expect(document.getElementById("clip-a")).not.toBeNull());
  expect(choose).toHaveBeenLastCalledWith("library", "undoTrash");
  // A short "Restored" without a button replaces it; focus left the button for the card that came back.
  await vi.waitFor(() => expect(toastText().slice(0, 4)).toEqual(["open", "Restored", "2026-10-05 14-02-11.mp4", true]));
  expect([document.getElementById("feedback")!.textContent, document.activeElement?.id]).toEqual(["Restored 2026-10-05 14-02-11.mp4", "clip-a-open"]);

  // ⌘Z works on another tab too, toast or not: the card waits in Recordings, and the tab stays where it is.
  await trash("a");
  click(document.getElementById("tab-general")!);
  expect(toastState()).toBe("open");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(toastOf()!.querySelector(".toast-title")!.textContent).toBe("Restored"));
  expect([document.querySelector('[aria-selected="true"]')!.id, document.activeElement?.id]).toEqual(["tab-general", "tab-general"]);
  click(document.getElementById("tab-library")!);
  expect(document.getElementById("clip-a")).not.toBeNull();

  // Escape closes it without undoing anything; ⌘Z still brings the file back while it waits.
  await trash("a");
  document.getElementById("tab-library")!.focus();
  document.getElementById("tab-library")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(toastState()).toBe("closed"));
  expect(document.getElementById("clip-a")).toBeNull();
  document.getElementById("tab-library")!.focus();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(document.getElementById("clip-a")).not.toBeNull());
  expect(document.activeElement?.id).toBe("clip-a-open");

  // The toast leaves as soon as nothing waits to be undone: the file was moved meanwhile.
  await trash("a");
  current = view({ items: [items[1]!] }, ++revision);
  push(current);
  // Sonner slides it out on its next frame.
  await vi.waitFor(() => expect(toastState()).toBe("closed"));
  current = view({ items }, ++revision);
  push(current);

  // With nothing waiting, ⌘Z is left to the Edit menu.
  const calls = choose.mock.calls.length;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
  expect(choose.mock.calls.length).toBe(calls);

  // Rename…: a sheet with the name selected and the extension kept; a taken name says so in the sheet.
  await menu(document.getElementById("clip-b-more")!);
  click(document.getElementById("clip-menu-rename")!);
  const sheet = () => document.getElementById("clip-rename");
  const input = () => document.getElementById("clip-rename-input") as HTMLInputElement;
  await vi.waitFor(() => expect(document.activeElement).toBe(input()));
  expect([Boolean(sheet()?.hasAttribute("data-open")), input().value, sheet()!.querySelector(".clip-rename-extension")!.textContent, document.activeElement]).toEqual([true, "Demo", ".mp4", input()]);
  expect(document.getElementById("clip-rename-label")!.textContent).toBe("New name for Demo");
  // A name the folder cannot take is refused before anything is sent.
  enter(input(), "a/b");
  input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(sheet()!.querySelector(".clip-rename-error")!.textContent).toBe("A name cannot contain / \\ : * ? \" < > |.");
  expect(choose).not.toHaveBeenCalledWith("recordingFile:b", expect.objectContaining({ action: "rename" }));
  // An input method's Enter while composing picks its characters; it renames nothing (2026-10-09).
  enter(input(), "Taken");
  input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
  expect(choose).not.toHaveBeenCalledWith("recordingFile:b", expect.objectContaining({ action: "rename" }));
  input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await vi.waitFor(() => expect(sheet()!.querySelector(".clip-rename-error")!.textContent).toBe("A file with this name is already in the folder."));
  expect(Boolean(sheet()?.hasAttribute("data-open"))).toBe(true);
  // Escape cancels, gives focus back to ⋯ and does not close the window.
  const close = vi.spyOn(window, "close").mockImplementation(() => {});
  input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  expect([Boolean(sheet()?.hasAttribute("data-open")), document.activeElement?.id, close.mock.calls.length]).toEqual([false, "clip-b-more", 0]);
  // Renamed: the new card takes the focus, and it is said.
  await menu(document.getElementById("clip-b-more")!);
  click(document.getElementById("clip-menu-rename")!);
  enter(input(), " Product demo ");
  click(document.getElementById("clip-rename-confirm")!);
  await vi.waitFor(() => expect(document.getElementById("clip-c")).not.toBeNull());
  expect(choose).toHaveBeenLastCalledWith("recordingFile:b", { action: "rename", name: "Product demo" });
  expect([Boolean(sheet()?.hasAttribute("data-open")), document.activeElement?.id, document.getElementById("feedback")!.textContent])
    .toEqual([false, "clip-c-open", "Renamed to Product demo.mp4"]);

  // A slow rename answered after its sheet was closed and another card's opened: the newer sheet keeps the focus.
  await menu(document.getElementById("clip-a-more")!);
  click(document.getElementById("clip-menu-rename")!);
  enter(input(), "Slow");
  input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await vi.waitFor(() => expect(slow).toBeDefined());
  input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await menu(document.getElementById("clip-c-more")!);
  click(document.getElementById("clip-menu-rename")!);
  await vi.waitFor(() => expect(document.activeElement).toBe(input()));
  expect([input().value, document.activeElement]).toEqual(["Product demo", input()]);
  slow!(undefined);
  await vi.waitFor(() => expect(document.getElementById("clip-d")).not.toBeNull());
  expect([Boolean(sheet()?.hasAttribute("data-open")), document.activeElement, input().value]).toEqual([true, input(), "Product demo"]);
});
