// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { playerControls } from "./player-controls";
import { VIDEO_TIMING, formatDuration } from "../shared/video-player";

const labels = { play: "Play", pause: "Pause", mute: "Mute", unmute: "Unmute", volume: "Volume", position: "Playback position" };

/** A video whose playing state, length and position the test sets, as happy-dom plays nothing. */
function setup(): { video: HTMLVideoElement; root: HTMLElement; fullScreen: ReturnType<typeof vi.fn>; set: (state: { paused?: boolean; duration?: number }) => void } {
  document.body.innerHTML = "";
  const video = document.createElement("video");
  let paused = true, duration = NaN, time = 0;
  Object.defineProperty(video, "paused", { get: () => paused, configurable: true });
  Object.defineProperty(video, "ended", { get: () => false, configurable: true });
  Object.defineProperty(video, "duration", { get: () => duration, configurable: true });
  Object.defineProperty(video, "currentTime", { get: () => time, set: (value: number) => { time = value; }, configurable: true });
  video.play = vi.fn(async () => { paused = false; video.dispatchEvent(new Event("play")); });
  video.pause = vi.fn(() => { paused = true; video.dispatchEvent(new Event("pause")); });
  const fullScreen = vi.fn();
  const top = document.createElement("p");
  const trailing = document.createElement("button"); trailing.id = "trailing";
  const controls = playerControls(video, { id: "p", labels, top, trailing: [trailing], fullScreen });
  document.body.append(controls.root);
  const set = (state: { paused?: boolean; duration?: number }): void => {
    if (state.paused !== undefined) paused = state.paused;
    if (state.duration !== undefined) { duration = state.duration; video.dispatchEvent(new Event("durationchange")); }
  };
  return { video, root: controls.root, fullScreen, set };
}
const key = (target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("reads the time as YouTube does, past an hour too, and an unknown length as 0:00; a card's length reads the same", () => {
  expect([formatDuration(0), formatDuration(59.6), formatDuration(65.9), formatDuration(3725), formatDuration(NaN), formatDuration(Infinity), formatDuration(-1)])
    .toEqual(["0:00", "0:59", "1:05", "1:02:05", "0:00", "0:00", "0:00"]);
});

it("replaces the native controls with play, volume, the time and the page's own trailing button, all named", () => {
  const { video, root, set } = setup();
  expect(video.controls).toBe(false);
  expect([...root.querySelectorAll("button")].map(el => el.id)).toEqual(["p-play", "p-mute", "trailing"]);
  set({ duration: 8 });
  const seek = root.querySelector<HTMLInputElement>(".pc-seek")!;
  expect([root.querySelector(".pc-time")!.textContent, seek.max, seek.getAttribute("aria-label"), seek.getAttribute("aria-valuetext")])
    .toEqual(["0:00 / 0:08", "8", "Playback position", "0:00 / 0:08"]);
  expect([document.getElementById("p-play")!.getAttribute("aria-label"), document.getElementById("p-mute")!.getAttribute("aria-label")]).toEqual(["Play", "Mute"]);
});

it("plays and pauses from its button, a click on the picture, Space and K; Space on a button is the button's own", async () => {
  const { video, root } = setup();
  const play = document.getElementById("p-play")!;
  play.click();
  await Promise.resolve();
  expect([(video.play as ReturnType<typeof vi.fn>).mock.calls.length, play.getAttribute("aria-label"), root.classList.contains("pc-paused")]).toEqual([1, "Pause", false]);
  video.click();
  expect((video.pause as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  key(video, " ");
  await Promise.resolve();
  expect((video.play as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  key(video, "k");
  expect((video.pause as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  // Space on a focused button: the browser clicks it, so the keys handler leaves it alone (one toggle, not two).
  const spaceOnButton = key(play, " ");
  expect([spaceOnButton.defaultPrevented, (video.play as ReturnType<typeof vi.fn>).mock.calls.length]).toEqual([false, 2]);
});

it("steps forward with the arrows before the length is known, instead of back to the start", () => {
  const { video } = setup();
  video.currentTime = 2;
  key(video, "ArrowRight");
  expect(video.currentTime).toBe(7);
  key(video, "ArrowLeft"); key(video, "ArrowLeft");
  expect(video.currentTime).toBe(0);
});

it("seeks by five seconds with the arrows within the video, on the seek bar too, leaves them to the volume slider, mutes with M and asks for full screen with F", () => {
  const { video, root, fullScreen, set } = setup();
  set({ duration: 8 });
  key(video, "ArrowRight");
  key(video, "ArrowRight");
  expect(video.currentTime).toBe(8);
  key(video, "ArrowLeft");
  expect(video.currentTime).toBe(3);
  // The seek bar's own step (`any`) would move 1% of the length: it moves 5 s like the rest of the player.
  const seek = root.querySelector<HTMLInputElement>(".pc-seek")!;
  expect(key(seek, "ArrowLeft").defaultPrevented).toBe(true);
  expect(video.currentTime).toBe(0);
  key(seek, "ArrowRight");
  expect(video.currentTime).toBe(5);
  const level = root.querySelector<HTMLInputElement>(".pc-level")!;
  expect(key(level, "ArrowLeft").defaultPrevented).toBe(false);
  expect(video.currentTime).toBe(5);
  key(video, "m");
  // happy-dom does not report the change itself, as Chromium does.
  video.dispatchEvent(new Event("volumechange"));
  expect([video.muted, document.getElementById("p-mute")!.getAttribute("aria-label")]).toEqual([true, "Unmute"]);
  key(video, "f");
  expect(fullScreen).toHaveBeenCalledOnce();
  // A shortcut with a modifier is someone else's (⌘F, ⌘K).
  key(video, "f", { metaKey: true });
  expect(fullScreen).toHaveBeenCalledOnce();
});

it("moves to where the seek bar is dragged, and sets the volume from its slider, at zero muted and brought back by its button", () => {
  const { video, root, set } = setup();
  set({ duration: 8 });
  const seek = root.querySelector<HTMLInputElement>(".pc-seek")!;
  seek.value = "6"; seek.dispatchEvent(new Event("input"));
  expect([video.currentTime, seek.style.getPropertyValue("--pc-fill")]).toEqual([6, "75%"]);
  const level = root.querySelector<HTMLInputElement>(".pc-level")!;
  level.value = "0"; level.dispatchEvent(new Event("input"));
  video.dispatchEvent(new Event("volumechange"));
  expect([video.volume, video.muted, level.getAttribute("aria-valuetext")]).toEqual([0, true, "0%"]);
  document.getElementById("p-mute")!.click();
  video.dispatchEvent(new Event("volumechange"));
  // Read as a percentage, as the seek bar reads as the time (review: volume value text).
  expect([video.volume, video.muted, level.getAttribute("aria-label"), level.getAttribute("aria-valuetext")]).toEqual([0.5, false, "Volume", "50%"]);
});

it("steps the controls aside while it plays and the pointer rests, never while paused, and brings them back on a move", async () => {
  const { video, root } = setup();
  vi.advanceTimersByTime(VIDEO_TIMING.idleMs + 10);
  expect(root.classList.contains("pc-idle")).toBe(false);
  await video.play();
  vi.advanceTimersByTime(VIDEO_TIMING.idleMs + 10);
  expect(root.classList.contains("pc-idle")).toBe(true);
  root.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
  expect(root.classList.contains("pc-idle")).toBe(false);
  // Pausing shows them at once, and they stay.
  vi.advanceTimersByTime(VIDEO_TIMING.idleMs - 100);
  video.pause();
  vi.advanceTimersByTime(VIDEO_TIMING.idleMs + 10);
  expect([root.classList.contains("pc-idle"), root.classList.contains("pc-paused")]).toEqual([false, true]);
});

it("writes nothing again while what it shows has not changed, though timeupdate fires several times a second", async () => {
  const { video, root, set } = setup();
  set({ duration: 8 });
  video.currentTime = 2.1;
  video.dispatchEvent(new Event("timeupdate"));
  const changes: string[] = [];
  const observer = new MutationObserver(records => { for (const record of records) changes.push(`${(record.target as Element).className}:${record.attributeName}`); });
  observer.observe(root, { attributes: true, subtree: true });
  video.currentTime = 2.4;
  video.dispatchEvent(new Event("timeupdate"));
  await Promise.resolve();
  observer.disconnect();
  // The bar's fill moves with the time; its reading, still 0:02, and the volume are left alone.
  expect(changes).toEqual(["pc-seek:style"]);
});
