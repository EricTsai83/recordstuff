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
  const { video, exit } = await load("src=s&t=0&play=0&vol=1&mute=1&lang=zh-TW");
  expect(document.getElementById("exit")!.getAttribute("aria-label")).toBe("結束全螢幕");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", repeat: true, cancelable: true }));
  expect(exit).not.toHaveBeenCalled();
  video.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  expect(exit).toHaveBeenCalledWith({ time: 0, playing: false, volume: 1, muted: true });
});
