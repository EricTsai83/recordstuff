// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { LibraryItemView, SettingsView } from "../../../shared/settings-panel";

const item = (id: string, extra: Partial<LibraryItemView> = {}): LibraryItemView => ({ id, day: "Today", title: id, name: `${id}.mp4`, time: "2:02 PM",
  duration: "0:10", size: "18 MB", thumbnail: `recordstuff-media://thumb/${id}?v=1`, video: `recordstuff-media://video/${id}?v=1`, ...extra });

function dragStart(target: Element, altKey: boolean): void {
  target.dispatchEvent(Object.assign(new Event("dragstart", { bubbles: true, cancelable: true }), { altKey }));
}

/**
 * Plan 100's card: a drag gives the Video and ⌥-drag the original; while the Video is prepared the card says so over its
 * picture with the way to give the original, and a drag refused meanwhile says why. Behaviour and names only.
 */
it("drags the Video or the original, and says over the picture when the Video is still being prepared", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  let revision = 1;
  let preparing = true;
  const view = (): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }], groups: [],
    library: { folder: "~/Movies", summary: "2 recordings", items: [
      item("a", { editable: "Editable", editableHint: "Keeps the picture apart.",
        ...(preparing ? { preparing: { state: "preparing" as const, progress: 0.4, label: "Preparing video… 40%" } } : {}) }),
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
  window.settings = { read: async () => view(), capture: async () => view(), choose, ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(2));

  // Being prepared, a card keeps its picture and draws a thin bar along its top, its state read in its name (2026-11-01).
  const bar = document.querySelector<HTMLElement>("#clip-a .clip-preparing-bar > span")!;
  expect(bar.style.width).toBe("40%");
  expect(document.querySelector("#clip-a .clip-thumb")!.textContent).not.toContain("Preparing video");
  expect(document.querySelector("#clip-a-open")!.getAttribute("aria-label")).toContain("Preparing video… 40%");
  expect(document.querySelector("#clip-b .clip-preparing-bar")).toBeNull();

  // A drag waits for the Video, and a toast says why and what ⌥-drag gives; no line is kept over the recordings.
  dragStart(document.querySelector("#clip-a")!, false);
  const toast = () => document.querySelector<HTMLElement>('.undo-toast:not([data-removed="true"])');
  await vi.waitFor(() => expect([toast()?.querySelector(".toast-title")?.textContent, toast()?.querySelector(".toast-description")?.textContent])
    .toEqual(["Can't copy while still combining video and sound", "To copy the multitrack original, Option-drag. Ordinary players may not play it."]));
  expect(document.querySelector<HTMLElement>(".library-error")?.hidden ?? true).toBe(true);

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

  // Prepared, the overlay goes and a drag gives the Video.
  preparing = false;
  dragStart(document.querySelector("#clip-b")!, false);
  await vi.waitFor(() => expect(sent.at(-1)).toEqual(["recordingFile:b", "drag"]));
  await vi.waitFor(() => expect(document.querySelector("#clip-a .clip-preparing")).toBeNull());
});
