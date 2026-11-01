// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { LibraryItemView, SettingsView } from "../../../shared/settings-panel";

const item = (id: string, extra: Partial<LibraryItemView> = {}): LibraryItemView => ({ id, day: "Today", title: id, name: `${id}.mp4`, time: "2:02 PM",
  duration: "0:10", size: "18 MB", thumbnail: `recordstuff-media://thumb/${id}?v=1`, video: `recordstuff-media://video/${id}?v=1`, ...extra });

function dragStart(target: Element, altKey: boolean): void {
  target.dispatchEvent(Object.assign(new Event("dragstart", { bubbles: true, cancelable: true }), { altKey }));
}

/**
 * Plan 100's card: a drag gives the Video and ⌥-drag the original; a drag refused while the Video is prepared says why in
 * a toast that shows how far it is, then that it is ready. Behaviour and names only.
 */
it("drags the Video or the original, and a drag refused while the Video is prepared shows its progress in a toast", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  let revision = 1;
  let preparing = true;
  let progress = 0.4;
  const view = (): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }], groups: [],
    library: { folder: "~/Movies", summary: "2 recordings", items: [
      item("a", { editable: "Editable", editableHint: "Keeps the picture apart.",
        ...(preparing ? { preparing: { state: "preparing" as const, progress, label: `Preparing video… ${Math.round(progress * 100)}%` } } : {}) }),
      item("b"),
    ] } });
  const sent: Array<[string, unknown]> = [];
  const choose = vi.fn(async (group: string, choice: unknown): Promise<any> => {
    sent.push([group, choice]);
    if (group === "recordingFile:a" && choice === "drag" && preparing) {
      return { view: view(), applied: false, failure: "Can't copy while still combining video and sound", failureDetail: "To copy the multitrack original, Option-drag. Ordinary players may not play it." };
    }
    return { view: view(), applied: true };
  });
  let push: (next: SettingsView) => void = () => {};
  window.settings = { read: async () => view(), capture: async () => view(), choose, ready: async () => {}, onChanged: (cb) => { push = cb; return () => {}; } };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(2));

  // Being prepared, a card keeps its picture as it is, its state read in its name (2026-11-01).
  expect(document.querySelector("#clip-a .clip-thumb")!.textContent).not.toContain("Preparing video");
  expect(document.querySelector("#clip-a-open")!.getAttribute("aria-label")).toContain("Preparing video… 40%");

  // A drag waits for the Video, and a toast says why, how far it is and what ⌥-drag copies; no line is kept over the
  // recordings.
  dragStart(document.querySelector("#clip-a")!, false);
  const toast = () => document.querySelector<HTMLElement>('.undo-toast:not([data-ending-style])');
  await vi.waitFor(() => expect(toast()?.querySelector(".toast-title")?.textContent).toBe("Can't copy while still combining video and sound"));
  expect(toast()!.querySelector(".toast-description")!.textContent).toContain("To copy the multitrack original, Option-drag. Ordinary players may not play it.");
  expect(toast()!.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("40");
  expect(document.querySelector<HTMLElement>(".library-error")?.hidden ?? true).toBe(true);
  // Each push moves it on, and the toast stays while it is prepared.
  progress = 0.7;
  push(view());
  await vi.waitFor(() => expect(toast()?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("70"));
  // Continue in background closes it while the Video goes on; a toast says when it is ready (below).
  const keepGoing = toast()!.querySelector<HTMLButtonElement>(".toast-action")!;
  expect(keepGoing.textContent).toBe("Continue in background");
  keepGoing.click();
  await vi.waitFor(() => expect(toast()).toBeNull());

  // Let go on the card, the refused drag is not a click too: the player stays closed (2026-11-01: it opened). A press
  // that is only a click, after it, plays the recording.
  const open = document.querySelector<HTMLElement>("#clip-a-open")!;
  open.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(document.querySelector(".player[data-open]")).toBeNull();
  open.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  open.click();
  await vi.waitFor(() => expect(document.querySelector(".player[data-open]")).not.toBeNull());
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await vi.waitFor(() => expect(document.querySelector(".player[data-open]")).toBeNull());

  // ⌥-drag gives the original.
  dragStart(document.querySelector("#clip-a")!, true);
  await vi.waitFor(() => expect(sent.at(-1)).toEqual(["recordingFile:a", "dragOriginal"]));

  // Prepared, a toast says it can be dragged now, though its first was sent to the background, and a drag gives the Video.
  preparing = false;
  push(view());
  await vi.waitFor(() => expect(toast()?.querySelector(".toast-title")?.textContent).toBe("Done combining. Drag it again to copy."));
  expect(toast()!.querySelector('[role="progressbar"]')).toBeNull();
  dragStart(document.querySelector("#clip-b")!, false);
  await vi.waitFor(() => expect(sent.at(-1)).toEqual(["recordingFile:b", "drag"]));
});
