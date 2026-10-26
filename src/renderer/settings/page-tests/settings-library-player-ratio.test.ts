// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click } from "../../testing/test-interactions";
import type { LibraryItemView, SettingsView } from "../../../shared/settings-panel";

const item: LibraryItemView = { id: "a", day: "Today", title: "Tall", name: "Tall.mp4", time: "2:02 PM", duration: "0:10", size: "18 MB",
  thumbnail: "recordstuff-media://thumb/a?v=1", video: "recordstuff-media://video/a?v=1" };

/**
 * The player's stage takes the recording's shape (2026-10-26, the maintainer's choice): it opens at the card picture's
 * shape, 16:9 without one, and follows the video's own once known; a shape past 21:9 either way is held there.
 */
it("shapes the player's stage as the recording", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  let revision = 1;
  const view = (): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }], groups: [], library: { folder: "~/Movies", summary: "1 recording", items: [item] } });
  window.settings = { read: async () => view(), capture: async () => view(), choose: async () => ({ view: view(), applied: true }), ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(1));
  const ratio = (): number => Number((document.querySelector<HTMLElement>(".player")!.style.getPropertyValue("--player-ratio")));

  // A portrait picture on the card: the stage opens portrait.
  const picture = document.querySelector<HTMLImageElement>("#clip-a img");
  if (picture) {
    Object.defineProperty(picture, "naturalWidth", { value: 1080, configurable: true });
    Object.defineProperty(picture, "naturalHeight", { value: 1920, configurable: true });
  }
  click(document.getElementById("clip-a-open")!);
  await vi.waitFor(() => expect(document.querySelector(".player[data-open]")).not.toBeNull());
  expect(ratio()).toBeCloseTo(picture ? 1080 / 1920 : 16 / 9, 4);

  // The video's own size, once known, wins; an extreme one is held at 21:9.
  const video = document.querySelector<HTMLVideoElement>(".player video")!;
  Object.defineProperty(video, "videoWidth", { value: 4000, configurable: true });
  Object.defineProperty(video, "videoHeight", { value: 1000, configurable: true });
  video.dispatchEvent(new Event("loadedmetadata"));
  await vi.waitFor(() => expect(ratio()).toBeCloseTo(21 / 9, 4));
});
