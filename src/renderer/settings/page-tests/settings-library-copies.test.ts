// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click, menu } from "../../testing/test-interactions";

const key = (target: HTMLElement, name: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
import type { LibraryItemView, SettingsView } from "../../../shared/settings-panel";

const item = (id: string, extra: Partial<LibraryItemView> = {}): LibraryItemView => ({ id, day: "Today", title: id, name: `${id}.mp4`, time: "2:02 PM",
  duration: "0:10", size: "18 MB", thumbnail: `recordstuff-media://thumb/${id}?v=1`, video: `recordstuff-media://video/${id}?v=1`, ...extra });

/**
 * Plan 100's saved copies (D4): a copy says where it came from, on its card and in its name for assistive technology,
 * and its recording's menu lists its copies, each shown in Finder. Behaviour and names only.
 */
it("says where a saved copy came from, and lists a recording's copies in its menu", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  let revision = 1;
  const view = (): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }], groups: [],
    library: { folder: "~/Movies", summary: "2 recordings", items: [
      item("copy", { savedFrom: "Saved from “Meeting”" }),
      item("meeting", { copies: [{ label: "Sound only, saved Today 2:10 PM", name: "Meeting (sound).m4a" }, { label: "Video file, saved Today 2:05 PM", name: "copy.mp4" }] }),
    ] } });
  const choose = vi.fn(async (): Promise<any> => ({ view: view(), applied: true }));
  window.settings = { read: async () => view(), capture: async () => view(), choose, ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(2));

  expect(document.querySelector("#clip-copy .clip-saved-from")!.textContent).toBe("Saved from “Meeting”");
  expect(document.querySelector("#clip-copy-open")!.getAttribute("aria-label")).toContain("Saved from “Meeting”");
  expect(document.querySelector("#clip-meeting .clip-saved-from")).toBeNull();

  // A recording without copies has no Saved copies.
  await menu(document.getElementById("clip-copy-more")!);
  expect(document.getElementById("clip-menu-copies")).toBeNull();
  key(document.activeElement as HTMLElement, "Escape");

  await menu(document.getElementById("clip-meeting-more")!);
  const copies = document.getElementById("clip-menu-copies")!;
  expect(copies.textContent).toBe("Saved copies");
  copies.focus();
  key(copies, "ArrowRight");
  const listed = await vi.waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('[id^="clip-menu-copy-"]')].map(entry => [entry.querySelector("span > span")?.textContent, entry.querySelector(".clip-copy-name")?.textContent]);
    if (!found.length) throw new Error("Saved copies has not opened");
    return found;
  });
  expect(listed).toEqual([["Sound only, saved Today 2:10 PM", "Meeting (sound).m4a"], ["Video file, saved Today 2:05 PM", "copy.mp4"]]);
  click(document.getElementById("clip-menu-copy-0")!);
  await vi.waitFor(() => expect(choose).toHaveBeenCalledWith("recordingFile:meeting", "revealCopy:0"));
});
