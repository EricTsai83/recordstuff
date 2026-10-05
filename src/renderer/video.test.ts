// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";

/** The fullscreen page (video.ts): loaded fresh for each case, with the query main gives it. */
async function load(query: string): Promise<{ video: HTMLVideoElement; ready: ReturnType<typeof vi.fn>; exit: ReturnType<typeof vi.fn>; order: string[] }> {
  vi.resetModules();
  document.body.innerHTML = '<video id="video"></video><button id="exit" hidden></button>';
  history.replaceState(null, "", `/video.html?${query}`);
  const order: string[] = [];
  const ready = vi.fn(() => { order.push("ready"); });
  const exit = vi.fn(() => { order.push("exit"); });
  window.video = { ready, exit };
  const video = document.getElementById("video") as HTMLVideoElement;
  vi.spyOn(video, "play").mockImplementation(async () => { order.push("play"); });
  vi.spyOn(video, "pause").mockImplementation(() => { order.push("pause"); });
  await import("./video");
  return { video, ready, exit, order };
}

beforeEach(() => { vi.restoreAllMocks(); });

it("stops before handing the state back, so the player and this window never sound together (review pass 1, F1)", async () => {
  const { video, exit, order } = await load("src=recordstuff-media%3A%2F%2Fvideo%2Fa&t=0&play=1&vol=0.5&mute=0&lang=zh-TW");
  expect([video.volume, video.muted]).toEqual([0.5, false]);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
  expect(order.slice(-2)).toEqual(["pause", "exit"]);
  expect(exit).toHaveBeenCalledOnce();
  // Leaving is once: a double-click after it sends nothing more.
  video.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  expect(exit).toHaveBeenCalledOnce();
});

it("starts nothing after the viewer has left, even when the first frame comes later (review pass 1, F1)", async () => {
  const { video, ready, order } = await load("src=s&t=0&play=1&vol=1&mute=0&lang=en");
  document.getElementById("exit")!.click();
  // A file it cannot decode still reports ready, to be shown and left again.
  video.dispatchEvent(new Event("error"));
  expect(ready).toHaveBeenCalledOnce();
  expect(order).not.toContain("play");
});

it("leaves on a double-click but not on a held Escape's repeats, and names its way out in the page's language", async () => {
  const { video, exit } = await load(`src=s&t=0&play=0&vol=1&mute=1&lang=zh-TW&title=${encodeURIComponent("今天，下午1:30")}`);
  expect(document.getElementById("exit")!.getAttribute("aria-label")).toBe("結束全螢幕");
  // The player's own controls (2026-10-05): the title main named over the top, the way out at the bar's right end, all in the page's language.
  expect([document.querySelector(".pc-title")!.textContent, document.querySelector(".pc-row")!.lastElementChild!.id, document.getElementById("video-play")!.getAttribute("aria-label"), video.controls])
    .toEqual(["今天，下午1:30", "exit", "播放", false]);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", repeat: true, cancelable: true }));
  expect(exit).not.toHaveBeenCalled();
  video.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  expect(exit).toHaveBeenCalledWith({ time: 0, playing: false, volume: 1, muted: true });
});

it("leaves on the platform's close chord, as the app's other window closes on it", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const mac = await load("src=s&t=0&play=0&vol=1&mute=0&lang=en");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW", ctrlKey: true, cancelable: true }));
  expect(mac.exit).not.toHaveBeenCalled();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW", metaKey: true, cancelable: true }));
  expect(mac.exit).toHaveBeenCalledOnce();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  const windows = await load("src=s&t=0&play=0&vol=1&mute=0&lang=en");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW", ctrlKey: true, cancelable: true }));
  expect(windows.exit).toHaveBeenCalledOnce();
});

it("reads in the language main gives it, for assistive technology too", async () => {
  await load("src=recordstuff-media%3A%2F%2Fvideo%2Fa&t=0&play=0&vol=1&mute=0&lang=zh-TW");
  expect([document.documentElement.lang, document.getElementById("exit")!.getAttribute("aria-label")]).toEqual(["zh-Hant", "結束全螢幕"]);
  await load("src=recordstuff-media%3A%2F%2Fvideo%2Fa&t=0&play=0&vol=1&mute=0");
  expect(document.documentElement.lang).toBe("en");
});

it("starts at full volume from the beginning when main leaves the numbers out", async () => {
  const { video } = await load("src=recordstuff-media%3A%2F%2Fvideo%2Fa&play=0&mute=0&vol=");
  expect([video.volume, video.muted]).toEqual([1, false]);
});

it("says ready once the first frame is decoded, not when only the metadata is known", async () => {
  const { video, ready } = await load("src=s&t=0&play=0&vol=1&mute=0&lang=en");
  video.dispatchEvent(new Event("loadedmetadata"));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(ready).not.toHaveBeenCalled();
  video.dispatchEvent(new Event("loadeddata"));
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
});

it("says ready after the seek to the player's time lands", async () => {
  const { video, ready } = await load("src=s&t=5&play=0&vol=1&mute=0&lang=en");
  vi.spyOn(video, "duration", "get").mockReturnValue(60);
  video.dispatchEvent(new Event("loadedmetadata"));
  expect(video.currentTime).toBe(5);
  video.dispatchEvent(new Event("loadeddata"));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(ready).not.toHaveBeenCalled();
  video.dispatchEvent(new Event("seeked"));
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
});
