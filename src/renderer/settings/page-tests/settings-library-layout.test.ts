// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click } from "../../testing/test-interactions";
import type { LibraryView, SettingsView } from "../../../shared/settings-panel";

/** Quick clicks on the layout switch show the last choice throughout: an earlier answer never flashes its layout back. */
it("keeps the latest layout while an earlier layout request answers", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  const view = (library: Partial<LibraryView>, revision: number): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision,
    tabs: [{ id: "library", label: "Recordings" }, { id: "general", label: "General" }], groups: [],
    library: { folder: "~/Movies", summary: "1 recording", items: [{ id: "a", day: "Today", title: "Demo", name: "Demo.mp4", time: "2:02 PM",
      duration: "1:23", size: "180 MB", thumbnail: "recordstuff-media://thumb/a?v=1", video: "recordstuff-media://video/a?v=1" }], ...library } });
  let revision = 1;
  let current = view({}, revision);
  const answers: Array<() => void> = [];
  const choose = vi.fn((group: string, choice: unknown): Promise<any> => new Promise(resolve => {
    answers.push(() => {
      if (group === "library" && (choice === "grid" || choice === "list")) current = view({ ...current.library, layout: choice }, ++revision);
      resolve({ view: current, applied: true });
    });
  }));
  window.settings = { read: async () => current, capture: async () => current, choose, ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(1));
  const library = document.getElementById("library")!;
  const layout = (id: "grid" | "list") => document.getElementById(`library-layout-${id}`) as HTMLInputElement;

  click(layout("list"));
  click(layout("grid"));
  expect(library.dataset.layout).toBe("grid");
  await vi.waitFor(() => expect(answers).toHaveLength(2));
  // The list request answers first, with a view whose saved layout is the list.
  answers[0]!();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(library.dataset.layout).toBe("grid");
  answers[1]!();
  await vi.waitFor(() => expect(choose).toHaveBeenCalledTimes(2));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(library.dataset.layout).toBe("grid");
});
