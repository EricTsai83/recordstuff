// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click } from "../../testing/test-interactions";
import type { LibraryView, SettingsView } from "../../../shared/settings-panel";

/** A grid card's preview starts muted; its speaker turns the sound on at once and saves the choice for every card (2026-10-14). */
it("plays a preview muted until its speaker turns the sound on, and saves the choice", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  const view = (library: Partial<LibraryView>, revision: number): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision,
    tabs: [{ id: "library", label: "Recordings" }, { id: "general", label: "General" }], groups: [],
    library: { folder: "~/Movies", summary: "1 recording", items: [{ id: "a", day: "Today", title: "Demo", name: "Demo.mp4", time: "2:02 PM",
      duration: "1:23", size: "180 MB", thumbnail: "recordstuff-media://thumb/a?v=1", video: "recordstuff-media://video/a?v=1" }], ...library } });
  let revision = 1;
  let current = view({ previewSound: false }, revision);
  const choose = vi.fn(async (group: string, choice: unknown): Promise<any> => {
    if (group === "library" && (choice === "previewSound:on" || choice === "previewSound:off"))
      current = view({ ...current.library, previewSound: choice === "previewSound:on" }, ++revision);
    return { view: current, applied: true };
  });
  window.settings = { read: async () => current, capture: async () => current, choose, ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  const { hoverClip, stopPreview } = await import("../tabs/clip-preview");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(1));
  // No speaker until the card previews.
  expect(document.getElementById("clip-a-sound")).toBeNull();

  hoverClip("a");
  const speaker = await vi.waitFor(() => {
    const button = document.getElementById("clip-a-sound");
    expect(button).not.toBeNull();
    return button!;
  });
  const video = document.querySelector<HTMLVideoElement>(".clip-preview > video")!;
  expect(video.muted).toBe(true);
  expect(speaker.getAttribute("aria-label")).toBe("Unmute");

  click(speaker);
  await vi.waitFor(() => expect(choose).toHaveBeenLastCalledWith("library", "previewSound:on"));
  await vi.waitFor(() => expect(document.getElementById("clip-a-sound")?.getAttribute("aria-label")).toBe("Mute"));
  expect(document.querySelector<HTMLVideoElement>(".clip-preview > video")!.muted).toBe(false);

  // The next preview starts with the saved sound.
  stopPreview();
  await vi.waitFor(() => expect(document.querySelector(".clip-preview")).toBeNull());
  hoverClip("a");
  await vi.waitFor(() => expect(document.querySelector(".clip-preview > video")).not.toBeNull());
  expect(document.querySelector<HTMLVideoElement>(".clip-preview > video")!.muted).toBe(false);

  click(document.getElementById("clip-a-sound")!);
  await vi.waitFor(() => expect(choose).toHaveBeenLastCalledWith("library", "previewSound:off"));
  await vi.waitFor(() => expect(document.querySelector<HTMLVideoElement>(".clip-preview > video")!.muted).toBe(true));
});
