// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { LibraryItemView, SettingsChoiceResult, SettingsView } from "../../shared/settings-panel";

const item: LibraryItemView = { id: "a", day: "Today", title: "a", time: "2:02 PM", name: "a.mp4", duration: "1:23", size: "180 MB",
  thumbnail: "recordstuff-media://thumb/a?v=1", video: "recordstuff-media://video/a?v=1" };

/** The full-screen window takes a moment to appear; the page's player must not sound alongside it meanwhile. */
it("keeps the page's video paused while a full-screen play is on its way, and lets it play once it has ended", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });


  const pause = vi.fn();
  HTMLMediaElement.prototype.play = async function (this: HTMLMediaElement) { this.dispatchEvent(new Event("play", { bubbles: true })); };
  HTMLMediaElement.prototype.pause = pause;
  const view: SettingsView = { language: "en", title: "RecordStuff", hint: "", failure: "", tabs: [{ id: "library", label: "Recordings" }], groups: [],
    library: { folder: "~/Movies/RecordStuff", summary: "1 recording", items: [item] } };
  let leave!: (result: SettingsChoiceResult) => void;
  const choose = vi.fn(() => new Promise<SettingsChoiceResult>(resolve => { leave = resolve; }));
  window.settings = { read: async () => view, capture: async () => view, choose, ready: async () => {}, onChanged: () => () => {}, onHidden: () => () => {} };
  await import("./settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(1));
  document.getElementById("clip-a-open")!.click();
  const video = document.querySelector<HTMLVideoElement>(".player video")!;

  document.getElementById("player-fullscreen")!.click();
  await vi.waitFor(() => expect(choose).toHaveBeenCalled());
  pause.mockClear();
  // A click on the picture (or Space) before the full-screen window shows.
  video.dispatchEvent(new Event("play", { bubbles: true }));
  expect(pause).toHaveBeenCalledOnce();

  leave({ view, applied: true, playback: { time: 3, playing: false, volume: 1, muted: false } });
  await vi.waitFor(() => expect(video.currentTime).toBe(3));
  pause.mockClear();
  video.dispatchEvent(new Event("play", { bubbles: true }));
  expect(pause).not.toHaveBeenCalled();
});
