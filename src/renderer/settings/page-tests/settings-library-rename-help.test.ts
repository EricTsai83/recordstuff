// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click, menu } from "../../testing/test-interactions";
import type { LibraryItemView, SettingsView } from "../../../shared/settings-panel";

const item = (id: string, title: string, name: string): LibraryItemView => ({ id, day: "Today", title, name, time: "2:02 PM", duration: "1:23", size: "180 MB",
  thumbnail: `recordstuff-media://thumb/${id}?v=1`, video: `recordstuff-media://video/${id}?v=1` });

/**
 * Plan 100: an editable recording's Rename… holds its title alone, its marker kept with the extension; a rename refused
 * because the edit could not follow says why in the sheet and offers the way out, which asks main to open it.
 */
it("renames an editable recording by its title and offers the way out of an edit that could not follow", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  let revision = 1;
  const view = (): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }], groups: [],
    library: { folder: "~/Movies", summary: "1 recording", items: [item("a", "Talk", "Talk.recordstuff.mp4")] } });
  const failure = "Not renamed: the disk that holds RecordStuff's edits is full (5 MB free). Free some space, then try again. The recording and its edit are unchanged.";
  const choose = vi.fn(async (group: string, choice: unknown): Promise<any> => {
    if (group === "recordingFile:a" && typeof choice === "object") return { view: view(), applied: false, failure, failureHelp: { action: "storageSettings", label: "Open Storage settings" } };
    return { view: view(), applied: true };
  });
  window.settings = { read: async () => view(), capture: async () => view(), choose, ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(1));

  await menu(document.getElementById("clip-a-more")!);
  click(document.getElementById("clip-menu-rename")!);
  const input = () => document.getElementById("clip-rename-input") as HTMLInputElement;
  await vi.waitFor(() => expect(document.activeElement).toBe(input()));
  expect([input().value, document.querySelector(".clip-rename-extension")!.textContent]).toEqual(["Talk", ".recordstuff.mp4"]);

  input().value = "Weekly";
  input().dispatchEvent(new Event("input", { bubbles: true }));
  click(document.getElementById("clip-rename-confirm")!);
  await vi.waitFor(() => expect(choose).toHaveBeenCalledWith("recordingFile:a", { action: "rename", name: "Weekly" }));
  await vi.waitFor(() => expect(document.querySelector(".clip-rename-error")!.textContent).toBe(failure));
  const help = document.getElementById("clip-rename-error-help")!;
  expect(help.textContent).toBe("Open Storage settings");
  click(help);
  await vi.waitFor(() => expect(choose).toHaveBeenCalledWith("failureHelp", "storageSettings"));
});
