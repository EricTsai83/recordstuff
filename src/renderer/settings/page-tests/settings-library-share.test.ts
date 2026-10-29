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
        ...(preparing ? { preparing: { state: "preparing" as const, progress: 0.4, label: "Preparing video… 40%", hint: "Option-drag gives the original." } } : {}) }),
      item("b"),
    ] } });
  const sent: Array<[string, unknown]> = [];
  const choose = vi.fn(async (group: string, choice: unknown): Promise<any> => {
    sent.push([group, choice]);
    if (group === "recordingFile:a" && choice === "drag" && preparing) {
      return { view: view(), applied: false, failure: "The video is still being prepared. Option-drag to give the original recording." };
    }
    return { view: view(), applied: true };
  });
  window.settings = { read: async () => view(), capture: async () => view(), choose, ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(2));

  const overlay = document.querySelector("#clip-a .clip-preparing")!;
  expect(overlay.textContent).toContain("Preparing video… 40%");
  expect(overlay.textContent).toContain("Option-drag gives the original.");
  expect(document.querySelector("#clip-a-open")!.getAttribute("aria-label")).toContain("Preparing video… 40%");
  expect(document.querySelector("#clip-b .clip-preparing")).toBeNull();

  // A drag waits for the Video, and the tab says why.
  dragStart(document.querySelector("#clip-a")!, false);
  await vi.waitFor(() => expect(document.querySelector(".library-error")?.textContent).toBe("The video is still being prepared. Option-drag to give the original recording."));
  expect(document.querySelector<HTMLElement>(".library-error")!.hidden).toBe(false);

  // ⌥-drag gives the original.
  dragStart(document.querySelector("#clip-a")!, true);
  await vi.waitFor(() => expect(sent.at(-1)).toEqual(["recordingFile:a", "dragOriginal"]));

  // Prepared, the overlay goes and a drag gives the Video.
  preparing = false;
  dragStart(document.querySelector("#clip-b")!, false);
  await vi.waitFor(() => expect(sent.at(-1)).toEqual(["recordingFile:b", "drag"]));
  await vi.waitFor(() => expect(document.querySelector("#clip-a .clip-preparing")).toBeNull());
});
