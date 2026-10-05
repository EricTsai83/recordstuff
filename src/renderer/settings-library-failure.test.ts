// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { LibraryItemView, SettingsView } from "../shared/settings-panel";

const item = (id: string): LibraryItemView => ({ id, day: "Today", title: id, name: `${id}.mp4`, duration: "1:23", size: "180 MB",
  thumbnail: `recordstuff-media://thumb/${id}?v=1`, video: `recordstuff-media://video/${id}?v=1` });

/** The tab's file actions that fail are shown under the header, not only spoken: the latest one, until the next action. */
it("shows the latest failed file action on the page until the next one, as well as announcing it", async () => {
  document.body.innerHTML = '<h1 id="title"></h1><div id="status"><p id="status-title"></p><p id="status-detail"></p><p id="hint"></p><button id="status-action" hidden></button></div><p id="feedback" class="visually-hidden"></p><form id="settings"></form>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  HTMLElement.prototype.showPopover = function (this: HTMLElement) { this.dataset.open = ""; };
  HTMLElement.prototype.hidePopover = function (this: HTMLElement) { delete this.dataset.open; };
  const view: SettingsView = { language: "en", title: "RecordStuff", hint: "", failure: "",
    tabs: [{ id: "library", label: "Recordings" }],
    groups: [{ id: "outputFolder", label: "Output folder", tab: "recording", kind: "actions", enabled: true, choices: [{ id: "reveal", label: "Show in Finder", enabled: true, checked: false }] }],
    library: { folder: "~/Movies/RecordStuff", summary: "1 recording", items: [item("a")] } };
  let fails = true;
  const choose = vi.fn(async (group: string) => !fails ? { view, applied: true }
    : group === "outputFolder" ? { view, applied: false, failure: "Could not open the folder." }
    : { view, applied: false, failure: "Could not complete this action. Try again." });
  window.settings = { read: async () => view, capture: async () => view, choose, ready: async () => {}, onChanged: () => () => {}, onHidden: () => () => {} };
  await import("./settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(1));
  const error = document.querySelector<HTMLElement>(".library-error")!;
  expect(error.hidden).toBe(true);

  document.getElementById("clip-a-more")!.click();
  document.getElementById("clip-menu-open")!.click();
  await vi.waitFor(() => expect(error.hidden).toBe(false));
  expect([error.textContent, document.getElementById("feedback")!.textContent])
    .toEqual(["Could not complete this action. Try again.", "Could not complete this action. Try again."]);

  // The header's Show in Finder failing afterwards is the one shown, not the older card failure (review pass 1, F1).
  document.getElementById("library-reveal")!.click();
  await vi.waitFor(() => expect(error.textContent).toBe("Could not open the folder."));
  expect(error.hidden).toBe(false);

  // A card action that works next clears it, the header's failure included (review pass 1, F1).
  fails = false;
  document.getElementById("clip-a-more")!.click();
  document.getElementById("clip-menu-reveal")!.click();
  await vi.waitFor(() => expect(error.hidden).toBe(true));
  expect(error.textContent).toBe("");

  // A second Move to Trash chosen while main still works on the first is not sent: on a slow volume it would find the
  // file gone and say so over the first one's success.
  let answer!: () => void;
  choose.mockImplementationOnce(() => new Promise(resolve => { answer = () => resolve({ view, applied: true }); }));
  const calls = choose.mock.calls.length;
  document.getElementById("clip-a-more")!.click();
  document.getElementById("clip-menu-trash")!.click();
  document.getElementById("clip-a-more")!.click();
  document.getElementById("clip-menu-trash")!.click();
  expect(choose.mock.calls.length).toBe(calls + 1);
  answer();
  await vi.waitFor(() => expect(document.getElementById("feedback")!.textContent).toBe("Moved to the Trash"));
  // Answered, the card takes actions again.
  document.getElementById("clip-a-more")!.click();
  document.getElementById("clip-menu-reveal")!.click();
  expect(choose.mock.calls.length).toBe(calls + 2);
});
