// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { LibraryItemView, SettingsView } from "../../../shared/settings-panel";

const item = (id: string, extra: Partial<LibraryItemView> = {}): LibraryItemView => ({ id, day: "Today", title: id, name: `${id}.mp4`, time: "2:02 PM",
  duration: "0:10", size: "18 MB", thumbnail: `recordstuff-media://thumb/${id}?v=1`, video: `recordstuff-media://video/${id}?v=1`, ...extra });

function dragStart(target: Element): void {
  target.dispatchEvent(Object.assign(new Event("dragstart", { bubbles: true, cancelable: true }), { altKey: false }));
}

const REFUSED = "Can't copy while still combining video and sound";
const NOTE = "To copy the multitrack original, Option-drag. Ordinary players may not play it.";
const NOTE_B = "To copy the unedited original, Option-drag.";
const FAILED = "Can't copy: video and sound could not be combined";

/**
 * A refused drag's Video that could not be made (a full disk, a cache folder that cannot be written, a damaged
 * recording; 2026-11-01): its promise toast turns into the failure, with the way to retry and what ⌥-drag copies; one
 * sent to the background says the same in a toast of its own. Behaviour and names only.
 */
it("says a refused drag's Video could not be made, on screen or after Continue in background", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  let revision = 1;
  const states: Record<string, "preparing" | "failed" | undefined> = { a: "preparing", b: "preparing" };
  const prepared = (id: string): Partial<LibraryItemView> => {
    const state = states[id];
    if (state === "preparing") return { preparing: { state, progress: 0.5, label: "Preparing video… 50%" } };
    if (state === "failed") return { preparing: { state, label: "Video not prepared" } };
    return {};
  };
  const view = (): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }], groups: [],
    library: { folder: "~/Movies", summary: "2 recordings", items: ["a", "b"].map((id) => item(id, { editable: "Editable", ...prepared(id) })) } });
  const choose = vi.fn(async (group: string, choice: unknown): Promise<any> => {
    const id = group.replace("recordingFile:", "");
    if (choice === "drag" && states[id] === "preparing") return { view: view(), applied: false, failure: REFUSED, failureDetail: id === "a" ? NOTE : NOTE_B };
    return { view: view(), applied: true };
  });
  let push: (next: SettingsView) => void = () => {};
  window.settings = { read: async () => view(), capture: async () => view(), choose, ready: async () => {}, onChanged: (cb) => { push = cb; return () => {}; } };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(2));
  const toast = () => document.querySelector<HTMLElement>('.undo-toast:not([data-ending-style])');
  const said = () => [toast()?.querySelector(".toast-title")?.textContent, toast()?.querySelector(".toast-description")?.textContent];

  // On screen: the promise toast's progress turns into the failure, with the retry before what ⌥-drag copies.
  dragStart(document.querySelector("#clip-a")!);
  await vi.waitFor(() => expect(toast()?.querySelector('[role="progressbar"]')).not.toBeNull());
  states.a = "failed";
  push(view());
  await vi.waitFor(() => expect(said()).toEqual([FAILED, `Drag again to retry. ${NOTE}`]));
  expect(toast()!.querySelector('[role="progressbar"]')).toBeNull();
  expect(toast()!.querySelector(".toast-action")).toBeNull();

  // Sent to the background: its toast goes (the one it held back comes forward again, one toast showing at a time),
  // and the failure comes in a toast of its own.
  dragStart(document.querySelector("#clip-b")!);
  await vi.waitFor(() => expect(said()).toEqual([REFUSED, NOTE_B]));
  toast()!.querySelector<HTMLButtonElement>(".toast-action")!.click();
  await vi.waitFor(() => expect(said()[1]).not.toBe(NOTE_B));
  states.b = "failed";
  push(view());
  await vi.waitFor(() => expect(said()).toEqual([FAILED, `Drag again to retry. ${NOTE_B}`]));
});
