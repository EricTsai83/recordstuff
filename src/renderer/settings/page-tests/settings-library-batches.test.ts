// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click, menu } from "../../testing/test-interactions";
import type { LibraryItemView, SettingsView, ShareView } from "../../../shared/settings-panel";
import * as model from "../settings-controller";

const share: ShareView = {
  heading: "Share “Recording 0”",
  versions: [{ kind: "video", label: "Video file", note: "The finished video.", fileName: "Recording 0.mp4", recommended: true, state: "ready" }],
  labels: { share: "Share", copy: "Copy", saveTo: "Save to…", more: "More", moreCount: "{count} items", close: "Close",
    drag: "You can also drag a file into another app.", preparing: "Preparing…", failed: "Could not be made",
    preparingNote: "Being prepared.", failedNote: "This file could not be made.", selected: "{count} files selected", copied: "Copied", saved: "Saved" },
};
const item = (index: number): LibraryItemView => ({ id: `r${index}`, day: "Today", title: `Recording ${index}`, name: `Recording ${index}.mp4`,
  time: "2:02 PM", duration: "1:23", size: "180 MB", thumbnail: `recordstuff-media://thumb/r${index}?v=1`, video: `recordstuff-media://video/r${index}?v=1`,
  ...(index % 2 ? { folder: "Demos" } : {}), ...(index === 0 ? { share } : {}) });

/**
 * The Recordings list drawn in batches (2026-11-01): a large list starts with a few cards and fills in the background; a
 * card an entry brings is drawn at once and stays drawn as the batches go on; another category starts over, whatever
 * category came before; Share… asked for a card whose tab was left before main answered does not open; and an entry to
 * another tab closes an open Share….
 */
it("draws a long list in batches, keeps an entry's card, starts over in another category, and drops a Share… left behind", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  let revision = 1;
  const items = Array.from({ length: 80 }, (_, index) => item(index));
  const view = (extra: Partial<SettingsView> = {}): SettingsView => ({
    language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }, { id: "general", label: "General" }], groups: [],
    library: { folder: "~/Movies", summary: "80 recordings", items, folders: [{ name: "Demos", empty: false }] }, ...extra });
  // Opened by a notification for a recording past the first batch.
  let current = view({ resultFocus: 1, entryTab: "library", libraryFocus: "r30" });
  let answerShare: (() => void) | undefined;
  const choose = vi.fn(async (group: string): Promise<any> => {
    if (group.startsWith("recordingShare:")) await new Promise<void>((resolve) => { answerShare = resolve; });
    return { view: current, applied: true };
  });
  let push!: (next: SettingsView) => void;
  window.settings = { read: async () => current, capture: async () => current, choose, ready: async () => {}, onChanged: (cb) => { push = cb; return () => {}; } };
  await import("../settings");
  const cards = () => document.querySelectorAll(".clip").length;

  // The entry's card is drawn and focused at once, ahead of the batches, and stays as they fill the list.
  await vi.waitFor(() => expect(document.activeElement?.id).toBe("clip-r30-open"));
  expect(cards()).toBeLessThan(80);
  await vi.waitFor(() => expect(cards()).toBe(80));
  expect(document.activeElement?.id).toBe("clip-r30-open");
  // Each day's heading counts all its recordings, however many are drawn yet.
  expect(document.querySelector(".day-heading")!.getAttribute("data-count")).toBe("80");

  // A category starts over, and so does the next one after it (review: categories once shared one key).
  model.showFolder({ folder: "Demos" });
  expect(cards()).toBeLessThan(40);
  await vi.waitFor(() => expect(cards()).toBe(40));
  model.showFolder({ folder: null });
  expect(cards()).toBeLessThan(40);
  await vi.waitFor(() => expect(cards()).toBe(40));

  // Share… asked for, then the tab left before main answers: nothing opens, and Share… still opens afterwards.
  await menu(document.getElementById("clip-r0-more")!);
  click(document.getElementById("clip-menu-share")!);
  await vi.waitFor(() => expect(answerShare).toBeDefined());
  document.getElementById("tab-general")!.click();
  await vi.waitFor(() => expect(model.selectedTab).toBe("general"));
  answerShare!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.querySelector(".share-panel")).toBeNull();
  expect(model.sharing).toBeUndefined();
  document.getElementById("tab-library")!.click();
  await vi.waitFor(() => expect(model.selectedTab).toBe("library"));
  answerShare = undefined;
  await menu(document.getElementById("clip-r0-more")!);
  click(document.getElementById("clip-menu-share")!);
  await vi.waitFor(() => expect(answerShare).toBeDefined());
  answerShare!();
  await vi.waitFor(() => expect(document.querySelector(".share-panel")).not.toBeNull());

  // An entry to another tab while the panel is open closes it: drawn over the whole window, it would stay over that tab
  // and keep the focus (review pass 2).
  push(current = view({ resultFocus: 2, entryTab: "general" }));
  await vi.waitFor(() => expect(model.selectedTab).toBe("general"));
  await vi.waitFor(() => expect(document.querySelector(".share-panel")).toBeNull());
  expect(model.sharing).toBeUndefined();
});
