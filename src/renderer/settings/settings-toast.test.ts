// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click, menu } from "../testing/test-interactions";
import type { LibraryItemView, LibraryView, SettingsView } from "../../shared/settings-panel";

const item = (id: string): LibraryItemView => ({ id, day: "Today", title: id, name: `${id}.mp4`, time: "2:02 PM", duration: "1:23", size: "180 MB",
  thumbnail: `recordstuff-media://thumb/${id}?v=1`, video: `recordstuff-media://video/${id}?v=1` });

/** The toast's own clock (2026-10-06): 8 s untouched, paused by the pointer or by focus in it; "Restored" stays 3 s. */
it("leaves after 8 s unless the pointer or focus holds it, and says Restored for 3 s", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    document.body.innerHTML = '<div id="root"></div>';
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });


    const items = [item("a"), item("b")];
    const view = (library: Partial<LibraryView>, revision: number): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision,
      tabs: [{ id: "library", label: "Recordings" }], groups: [], library: { folder: "~/Movies", items, ...library } });
    let revision = 1;
    let current = view({}, revision);
    const choose = vi.fn(async (group: string, choice: unknown): Promise<any> => {
      revision++;
      if (choice === "trash") {
        const id = group.slice("recordingFile:".length);
        current = view({ items: items.filter(entry => entry.id !== id), trashed: { name: `${id}.mp4`, message: `Moved ${id}.mp4 to the Trash.`, undo: "Undo" } }, revision);
      }
      if (choice === "undoTrash") current = view({ items }, revision);
      return { view: current, applied: true };
    });
    window.settings = { read: async () => current, capture: async () => current, choose, ready: async () => {}, onChanged: () => () => {} };
    await import("./settings");
    await vi.advanceTimersByTimeAsync(50);
    const trash = async (id: string): Promise<void> => {
      await menu(document.getElementById(`clip-${id}-more`)!);
      click(document.getElementById("clip-menu-trash")!);
      await vi.advanceTimersByTimeAsync(0);
    };
    const state = () => [document.getElementById("toast")!.dataset.state, document.getElementById("toast")!.hidden];
    await trash("a");
    expect(state()).toEqual(["open", false]);
    await vi.advanceTimersByTimeAsync(7_900);
    expect(state()).toEqual(["open", false]);
    // The pointer on it holds it however long, and leaving gives back only what was left.
    const toast = document.getElementById("toast")!;
    toast.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state()).toEqual(["open", false]);
    toast.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(50);
    expect(state()).toEqual(["open", false]);
    await vi.advanceTimersByTimeAsync(100);
    expect(state()).toEqual(["closed", false]);
    // Gone from view once it has faded.
    await vi.advanceTimersByTimeAsync(200);
    expect(state()).toEqual(["closed", true]);

    // Focus in it holds it too; a newer trash replaces the toast and starts its count again.
    await trash("b");
    document.getElementById("toast-action")!.focus();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(state()).toEqual(["open", false]);
    click(document.getElementById("toast-action")!);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector("#toast .toast-title")!.textContent).toBe("Restored");
    // Focus went to the card that came back, so the count runs: Restored leaves after 3 s.
    expect(document.activeElement?.id).toBe("clip-b-open");
    await vi.advanceTimersByTimeAsync(2_900);
    expect(state()).toEqual(["open", false]);
    await vi.advanceTimersByTimeAsync(200);
    expect(state()[0]).toBe("closed");

    // Undo clicked with the pointer on the toast: "Restored" takes the same node, so no new enter arrives, yet the
    // pointer still holds it (review of 2026-10-06, F2).
    await vi.advanceTimersByTimeAsync(300);
    await trash("a");
    toast.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    const original = Element.prototype.matches;
    const matches = vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
      return selector === ":hover" ? this.id === "toast" : original.call(this, selector);
    });
    click(document.getElementById("toast-action")!);
    await vi.advanceTimersByTimeAsync(0);
    matches.mockRestore();
    expect(document.querySelector("#toast .toast-title")!.textContent).toBe("Restored");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state()).toEqual(["open", false]);
    toast.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(3_100);
    expect(state()[0]).toBe("closed");

    // Escape closes an open toast wherever focus is, before it would close the window and end the Undo (F1).
    await vi.advanceTimersByTimeAsync(300);
    await trash("b");
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    document.getElementById("tab-library")!.focus();
    document.getElementById("tab-library")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect([state()[0], close.mock.calls.length]).toEqual(["closed", 0]);
    // The next Escape, with nothing else open, closes the window as before.
    document.getElementById("tab-library")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(close).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});
