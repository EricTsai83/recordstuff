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
  // Nor popovers: the menu's own state is read from `data-open`.
  HTMLElement.prototype.showPopover = function (this: HTMLElement) { this.dataset.open = ""; };
  HTMLElement.prototype.hidePopover = function (this: HTMLElement) { delete this.dataset.open; };
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
    .toEqual(["recordstuff-media://thumb/a?v=1", "180 MB", "Play Today, 2:02 PM, 1:23, 180 MB"]);
  // The length is on the thumbnail, so the line under it gives the size alone.
  expect(first.querySelector(".clip-duration")!.textContent).toBe("1:23");

  // The same listing pushed again rewrites nothing on the cards.
  const mutations: string[] = [];
  const observer = new MutationObserver(records => { for (const record of records) mutations.push(`${(record.target as Element).id || (record.target as Element).className}:${record.attributeName}`); });
  observer.observe(document.querySelector(".library-days")!, { attributes: true, subtree: true });
  push({ ...base, revision: 1.5 });
  await Promise.resolve();
  observer.disconnect();
  expect(mutations).toEqual([]);

  // A saved recording's entry (its notification) lands on its card and outlines it, without playing.
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
  // An entry while it plays (another saved notification) closes it first, then lands on the card (review pass 1, F1).
  push({ ...base, revision: 3, resultFocus: 2, entryTab: "library", libraryFocus: "b" });
  expect([player.open, player.querySelector("video")!.hasAttribute("src"), document.activeElement?.id]).toEqual([false, false, "clip-b-open"]);
  first.querySelector("button")!.click();
  expect(player.open).toBe(true);
  // The player only plays: its one action is Close (2026-10-04).
  expect([...player.querySelectorAll("button")].map(el => el.id)).toEqual(["player-close"]);

  // A recording the page cannot play says so, and points to Open in the card's menu; the next one starts without the message.
  const video = player.querySelector("video")!;
  const error = player.querySelector<HTMLElement>(".player-error")!;
  expect(error.hidden).toBe(true);
  video.dispatchEvent(new Event("error"));
  // Spoken inside the dialog: a modal player makes `#feedback` inert (review pass 1, F1).
  const spoken = player.querySelector<HTMLElement>('[role="status"]')!;
  const unplayable = "This recording cannot be played here. Choose Open from its ⋯ menu to play it in another app.";
  expect([error.hidden, error.textContent, spoken.textContent, player.contains(spoken)]).toEqual([false, unplayable, unplayable, true]);
  // Closing empties the source, which is not a failure: nothing more is said.
  document.getElementById("player-close")!.click();
  const said = document.getElementById("feedback")!.textContent;
  video.dispatchEvent(new Event("error"));
  expect(document.getElementById("feedback")!.textContent).toBe(said);
  first.querySelector("button")!.click();
  expect([player.open, error.hidden, spoken.textContent]).toEqual([true, true, ""]);
  document.getElementById("player-close")!.click();

  // The file's actions come before it is opened: the card's ⋯ button opens a menu of them.
  const more = document.getElementById("clip-a-more") as HTMLButtonElement;
  expect([more.getAttribute("aria-label"), more.getAttribute("aria-haspopup"), more.getAttribute("aria-expanded")]).toEqual(["More actions for Today, 2:02 PM", "menu", "false"]);
  more.click();
  const menu = document.getElementById("clip-menu")!;
  const items = (): string[] => [...menu.querySelectorAll("[role=menuitem]")].map(el => el.textContent ?? "");
  expect([("open" in menu.dataset), more.getAttribute("aria-expanded"), items(), document.activeElement?.id])
    .toEqual([true, "true", ["Show in Finder", "Open", "Move to Trash"], "clip-menu-reveal"]);
  // Arrows move through it; Escape closes it, not the window, and gives focus back.
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  expect(document.activeElement?.id).toBe("clip-menu-trash");
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect([("open" in menu.dataset), more.getAttribute("aria-expanded"), document.activeElement?.id, close.mock.calls.length]).toEqual([false, "false", "clip-a-more", 0]);
  // A right-click on the card opens the same menu; its choice reaches main as the file's action.
  first.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
  expect(("open" in menu.dataset)).toBe(true);
  document.getElementById("clip-menu-open")!.click();
  await vi.waitFor(() => expect(choose).toHaveBeenLastCalledWith("recordingFile:a", "open"));
  expect(("open" in menu.dataset)).toBe(false);
  more.click();
  document.getElementById("clip-menu-reveal")!.click();
  await vi.waitFor(() => expect(choose).toHaveBeenLastCalledWith("recordingFile:a", "reveal"));

  // A card scrolled out of the panel opens no menu, and leaves nothing expanded or focused in it (review pass 1, F3).
  const panelBox = document.getElementById("settings-panel")!.getBoundingClientRect;
  document.getElementById("settings-panel")!.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 100, width: 500, height: 400 });
  first.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: -300, width: 200, height: 150 });
  first.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
  expect([("open" in menu.dataset), more.getAttribute("aria-expanded"), menu.contains(document.activeElement)]).toEqual([false, "false", false]);
  // Partly above the window, the card keeps its menu, which stays inside the window (review pass 2, P2-1).
  first.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 60, width: 200, height: 150 });
  more.getBoundingClientRect = () => DOMRect.fromRect({ x: 160, y: -40, width: 28, height: 28 });
  more.click();
  expect([("open" in menu.dataset), menu.style.top]).toEqual([true, "8px"]);
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  delete (more as Partial<HTMLElement>).getBoundingClientRect;
  delete (first as Partial<HTMLElement>).getBoundingClientRect;
  document.getElementById("settings-panel")!.getBoundingClientRect = panelBox;

  // Moved to the Trash: the card leaves, it is said, and focus goes to the card that took its place.
  more.click();
  document.getElementById("clip-menu-trash")!.click();
  await vi.waitFor(() => expect(document.getElementById("clip-a")).toBeNull());
  expect(choose).toHaveBeenLastCalledWith("recordingFile:a", "trash");
  expect(document.getElementById("feedback")!.textContent).toBe("Moved to the Trash");
  expect(document.activeElement?.id).toBe("clip-b-open");

  // Traditional Chinese joins a card's name and the player's title with its own comma.
  push({ ...base, revision: 4, language: "zh-TW", library: { ...base.library!, items: [{ ...item("c", "今天", "下午2:02"), duration: "1:23" }] } });
  expect(document.querySelector("#clip-c .clip-open")!.getAttribute("aria-label")).toBe("播放 今天，下午2:02，1:23，180 MB");
  document.querySelector<HTMLButtonElement>("#clip-c .clip-open")!.click();
  expect(document.getElementById("player-title")!.textContent).toBe("今天，下午2:02");

  // An entry to another tab (a banner or the tray, with no blur) takes the cards away: their menu leaves with them,
  // so none of its items can act on a recording no longer shown.
  document.getElementById("player-close")!.click();
  const moreC = document.getElementById("clip-c-more") as HTMLButtonElement;
  moreC.click();
  expect(("open" in menu.dataset)).toBe(true);
  push({ ...base, revision: 5, resultFocus: 3, entryTab: "recording", library: { ...base.library!, items: [item("c", "今天", "下午2:02")] } });
  expect([("open" in menu.dataset), moreC.isConnected]).toEqual([false, false]);

  // A focused card deleted in Finder, while Finder is in front: the card after it takes its place, as a removed
  // failure row's does, so the window opens on it when the user comes back (review batch 3).
  push({ ...base, revision: 6, resultFocus: 4, entryTab: "library" });
  document.querySelector<HTMLElement>("#clip-b .clip-open")!.focus();
  const inactive = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  push({ ...base, revision: 7, library: { ...base.library!, items: [base.library!.items[0]!, base.library!.items[2]!] } });
  inactive.mockRestore();
  expect(document.activeElement?.id).toBe("clip-c-open");
  // The recording playing in the focused player leaves: the player closes and the card before it, the last one left, has focus.
  document.querySelector<HTMLButtonElement>("#clip-c .clip-open")!.click();
  document.getElementById("player-close")!.focus();
  push({ ...base, revision: 8, library: { ...base.library!, items: [base.library!.items[0]!] } });
  expect([player.open, document.activeElement?.id]).toEqual([false, "clip-a-open"]);
});
