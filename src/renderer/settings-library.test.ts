// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { LibraryItemView, SettingsView } from "../shared/settings-panel";

const item = (id: string, day: string, title: string): LibraryItemView => ({ id, day, title, name: `${id}.mp4`, duration: "1:23", size: "180 MB",
  thumbnail: `recordstuff-media://thumb/${id}?v=1`, video: `recordstuff-media://video/${id}?v=1` });

/** The Recordings tab: cards by day, a drag that hands the file to main, and the page's own player. */
it("groups cards by day, drags a file out through main, and plays, trashes and closes in its player", async () => {
  document.body.innerHTML = '<h1 id="title"></h1><div id="status"><p id="status-title"></p><p id="status-detail"></p><p id="hint"></p><button id="status-action" hidden></button></div><p id="feedback"></p><form id="settings"></form>';
  // Before any view names main's platform, the page takes the browser's; macOS words are expected below.
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  // happy-dom has no modal dialogs of its own.
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };
  HTMLMediaElement.prototype.play = async () => {};
  HTMLMediaElement.prototype.pause = () => {};
  const base: SettingsView = { language: "en", title: "Settings", hint: "", failure: "",
    tabs: [{ id: "library", label: "Recordings" }, { id: "recording", label: "Recording settings" }],
    groups: [{ id: "outputFolder", label: "Output folder", tab: "recording", kind: "actions", enabled: true, choices: [{ id: "reveal", label: "Show in Finder", enabled: true, checked: false }] }],
    library: { folder: "~/Movies/RecordStuff", summary: "3 recordings · 400 MB", items: [item("a", "Today", "2:02 PM"), item("b", "Today", "11:40 AM"), item("c", "Yesterday", "Demo")] } };
  let current = base;
  const choose = vi.fn(async (group: string, choice: string) => {
    if (group === "recordingFile:a" && choice === "trash") current = { ...base, library: { ...base.library!, items: base.library!.items.slice(1) } };
    return { view: current, applied: true };
  });
  const close = vi.spyOn(window, "close").mockImplementation(() => {});
  let push!: (view: SettingsView) => void;
  window.settings = { read: async () => base, capture: async () => base, choose, ready: async () => {}, onChanged: cb => { push = cb; return () => {}; } };
  await import("./settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(3));
  expect([...document.querySelectorAll(".library-day")].map(day => [day.querySelector("h2")!.textContent, day.querySelectorAll(".clip").length])).toEqual([["Today", 2], ["Yesterday", 1]]);
  expect(document.querySelector(".library-summary")!.textContent).toBe("3 recordings · 400 MB");
  const first = document.getElementById("clip-a")!;
  expect([first.querySelector("img")!.getAttribute("src"), first.querySelector(".clip-meta")!.textContent, first.querySelector("button")!.getAttribute("aria-label")])
    .toEqual(["recordstuff-media://thumb/a?v=1", "1:23 · 180 MB", "Play Today, 2:02 PM, 1:23, 180 MB"]);

  // A saved recording's entry (its notification or the tray) lands on its card and outlines it, without playing.
  push({ ...base, revision: 2, resultFocus: 1, entryTab: "library", libraryFocus: "c" });
  expect(document.activeElement?.id).toBe("clip-c-open");
  expect(document.getElementById("clip-c")!.classList.contains("arrived")).toBe(true);
  expect(document.querySelector<HTMLDialogElement>("dialog.player")?.open ?? false).toBe(false);
  first.dispatchEvent(new Event("dragstart", { cancelable: true }));
  expect(choose).toHaveBeenLastCalledWith("recordingFile:a", "drag");

  first.querySelector("button")!.click();
  const player = document.querySelector<HTMLDialogElement>("dialog.player")!;
  expect([player.open, player.querySelector("video")!.getAttribute("src"), document.getElementById("player-title")!.textContent]).toEqual([true, "recordstuff-media://video/a?v=1", "Today, 2:02 PM"]);
  // Escape belongs to the player while it is open; the window stays.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(close).not.toHaveBeenCalled();
  // An entry while it plays (another notification, Show last recording) closes it first, then lands on the card (review pass 1, F1).
  push({ ...base, revision: 3, resultFocus: 2, entryTab: "library", libraryFocus: "b" });
  expect([player.open, player.querySelector("video")!.hasAttribute("src"), document.activeElement?.id]).toEqual([false, false, "clip-b-open"]);
  first.querySelector("button")!.click();
  expect(player.open).toBe(true);

  document.getElementById("player-trash")!.click();
  await vi.waitFor(() => expect(player.open).toBe(false));
  expect(choose).toHaveBeenLastCalledWith("recordingFile:a", "trash");
  expect(document.getElementById("clip-a")).toBeNull();
  expect(document.getElementById("feedback")!.textContent).toBe("Moved to the Trash");
  expect(player.querySelector("video")!.hasAttribute("src")).toBe(false);
});
