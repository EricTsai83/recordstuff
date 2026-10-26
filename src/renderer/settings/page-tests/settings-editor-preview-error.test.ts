// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { click, menu } from "../../testing/test-interactions";
import type { LibraryItemView, SettingsView } from "../../../shared/settings-panel";
import type { EditorChoice, EditorView } from "../../../shared/editing";

const item: LibraryItemView = { id: "a", day: "Today", title: "Talk", name: "Talk.mp4", time: "2:02 PM", duration: "0:10", size: "18 MB",
  thumbnail: "recordstuff-media://thumb/a?v=1", video: "recordstuff-media://video/a?v=1" };
const ready: EditorView = { id: "a", state: "ready", timescale: 90_000, duration: 900_000, seconds: 10, frameRate: 30, removed: [], skipped: [],
  revision: 0, notes: [], outputSeconds: 10, exportable: true, export: { phase: "idle" } };

/**
 * A preview whose media fails (Codex's computer-use round of 2026-10-26: Play showed Pause over a still picture, nothing
 * said why, and the view opened again kept the broken element): the failure is said over it with Reload preview, Play
 * reads as Play, and Reload loads the recording again at the playhead; a view opened again on the failed element loads
 * it again too.
 */
it("says a failed preview, offers Reload preview, and loads it again when the view opens again", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  let revision = 1;
  let editor: EditorView | undefined;
  const view = (): SettingsView => ({ language: "en", title: "RecordStuff", hint: "", failure: "", revision: ++revision,
    tabs: [{ id: "library", label: "Recordings" }], groups: [],
    library: { folder: "~/Movies", summary: "1 recording", items: [item] }, ...(editor ? { editor } : {}) });
  const choose = vi.fn(async (group: string, choice: unknown): Promise<any> => {
    const edit = choice as EditorChoice;
    if (group === "recordingEdit:a" && edit.action === "open") editor = ready;
    if (group === "recordingEdit:a" && edit.action === "close") editor = undefined;
    return { view: view(), applied: true };
  });
  window.settings = { read: async () => view(), capture: async () => view(), choose, ready: async () => {}, onChanged: () => () => {} };
  await import("../settings");
  await vi.waitFor(() => expect(document.querySelectorAll(".clip")).toHaveLength(1));
  const open = async (): Promise<void> => {
    await menu(document.getElementById("clip-a-more")!);
    click(document.getElementById("clip-menu-edit")!);
    await vi.waitFor(() => expect(document.getElementById("editor-play")).not.toBeNull());
  };
  await open();
  const video = document.querySelector<HTMLVideoElement>("#editor .pc video")!;
  const load = vi.spyOn(video, "load").mockImplementation(() => undefined);

  // The media fails while Chromium leaves the element unpaused: Play reads as Play, and the failure is said over it.
  let failure: MediaError | null = { code: 3, message: "PIPELINE_ERROR_DECODE" } as MediaError;
  Object.defineProperty(video, "error", { get: () => failure, configurable: true });
  Object.defineProperty(video, "paused", { get: () => false, configurable: true });
  video.dispatchEvent(new Event("error"));
  await vi.waitFor(() => expect(document.querySelector("#editor .player-error")!.textContent).toBe("The preview stopped because the recording could not be read. Reload it to go on."));
  expect(document.getElementById("editor-play")!.getAttribute("aria-label")).toBe("Play");
  expect(document.getElementById("editor-feedback")!.textContent).toBe("The preview stopped because the recording could not be read. Reload it to go on.");

  // Reload preview loads it again, back at the playhead, and the message goes.
  video.currentTime = 4;
  click(document.getElementById("editor-reload")!);
  expect(load).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(document.getElementById("editor-reload")).toBeNull());
  failure = null;
  video.currentTime = 0;
  video.dispatchEvent(new Event("loadedmetadata"));
  expect(video.currentTime).toBe(4);

  // A reload still loading when the view closes is let go: its metadata arriving later neither seeks nor plays
  // (review of 2026-10-26).
  const play = vi.spyOn(video, "play").mockResolvedValue(undefined);
  failure = { code: 3, message: "PIPELINE_ERROR_DECODE" } as MediaError;
  video.currentTime = 7;
  document.getElementById("editor-play")!.click();
  expect(load).toHaveBeenCalledTimes(2);
  click(document.getElementById("editor-close")!);
  await vi.waitFor(() => expect(document.querySelector("#editor[data-open]")).toBeNull());
  failure = null;
  video.currentTime = 0;
  video.dispatchEvent(new Event("loadedmetadata"));
  expect([video.currentTime, play.mock.calls.length]).toEqual([0, 0]);
  await open();

  // Failed again, then closed: opened again on the same element, it loads again rather than stay broken.
  failure = { code: 3, message: "PIPELINE_ERROR_DECODE" } as MediaError;
  video.dispatchEvent(new Event("error"));
  await vi.waitFor(() => expect(document.getElementById("editor-reload")).not.toBeNull());
  click(document.getElementById("editor-close")!);
  await vi.waitFor(() => expect(document.querySelector("#editor[data-open]")).toBeNull());
  await open();
  expect(load).toHaveBeenCalledTimes(3);
  expect(document.getElementById("editor-reload")).toBeNull();
});
