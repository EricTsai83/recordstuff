// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { playbackOf } from "./player-state";
import { Player } from "./player";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { click } from "../testing/test-interactions";
import { VIDEO_TIMING, formatDuration } from "../../shared/video-player";

let mounted: Root | undefined;
/** A real React player with a controlled media element: happy-dom cannot decode/play a video. */
function setup(): { video: HTMLVideoElement; root: HTMLElement; fullScreen: ReturnType<typeof vi.fn>; set: (state: { paused?: boolean; duration?: number }) => void } {
 document.body.innerHTML = '<div id="root"></div>';
 let video!: HTMLVideoElement, paused = true, duration = NaN, time = 0;
 const fullScreen = vi.fn();
 const attach = (node: HTMLVideoElement | null): void => {
  if (!node) return; video = node;
  Object.defineProperties(video, {
   paused: { get: () => paused, configurable: true }, ended: { get: () => false, configurable: true },
   duration: { get: () => duration, configurable: true }, currentTime: { get: () => time, set: (value: number) => { time = value; }, configurable: true },
  });
  video.play = vi.fn(async () => { paused = false; video.dispatchEvent(new Event("play")); });
  video.pause = vi.fn(() => { paused = true; video.dispatchEvent(new Event("pause")); });
 };
 mounted = createRoot(document.getElementById("root")!);
 flushSync(() => mounted!.render(createElement(Player, { id: "p", source: "fixture.mp4", title: "", language: "en", videoRef: attach, trailing: createElement("button", { id: "trailing" }), fullScreen, onDoubleClick: fullScreen })));
 const set = (state: { paused?: boolean; duration?: number }): void => { if (state.paused !== undefined) paused = state.paused; if (state.duration !== undefined) { duration = state.duration; video.dispatchEvent(new Event("durationchange")); } };
 return { video, root: document.querySelector(".pc")!, fullScreen, set };
}
const slider = (root: HTMLElement, selector: string): HTMLElement => root.querySelector<HTMLElement>(`${selector} input[type="range"]`)!;
function drag(root: HTMLElement, selector: string, percent: number): void {
 const control = root.querySelector<HTMLElement>(`${selector} > div`)!;
 vi.spyOn(control, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 100, height: 20 }));
 flushSync(() => { control.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, clientX: percent, clientY: 10, pointerType: "mouse" })); control.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true, clientX: percent, clientY: 10, pointerType: "mouse" })); });
}
const key = (target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  flushSync(() => target.dispatchEvent(event));
  return event;
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { flushSync(() => mounted?.unmount()); mounted = undefined; vi.useRealTimers(); });

it("reads the time as YouTube does, past an hour too, and an unknown length as 0:00; a card's length reads the same", () => {
  expect([formatDuration(0), formatDuration(59.6), formatDuration(65.9), formatDuration(3725), formatDuration(NaN), formatDuration(Infinity), formatDuration(-1)])
    .toEqual(["0:00", "0:59", "1:05", "1:02:05", "0:00", "0:00", "0:00"]);
});

it("replaces the native controls with play, volume, the time and the page's own trailing button, all named", () => {
  const { video, root, set } = setup();
  expect(video.controls).toBe(false);
  expect([...root.querySelectorAll("button")].map(el => el.id)).toEqual(["p-play", "p-mute", "trailing"]);
  set({ duration: 8 });
  const seek = slider(root, ".pc-seek");
  expect([root.querySelector(".pc-time")!.textContent, seek.getAttribute("max"), seek.getAttribute("aria-label"), seek.getAttribute("aria-valuetext")])
    .toEqual(["0:00 / 0:08", "8", "Playback position", "0:00 / 0:08"]);
  expect([document.getElementById("p-play")!.getAttribute("aria-label"), document.getElementById("p-mute")!.getAttribute("aria-label")]).toEqual(["Play", "Mute"]);
});

it("plays and pauses from its button, a click on the picture, Space and K; Space on a button is the button's own", async () => {
  const { video, root } = setup();
  const play = document.getElementById("p-play")!;
  click(play);
  await Promise.resolve();
  expect([(video.play as ReturnType<typeof vi.fn>).mock.calls.length, play.getAttribute("aria-label"), root.classList.contains("pc-paused")]).toEqual([1, "Pause", false]);
  click(video);
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
  const seek = slider(root, ".pc-seek");
  expect(key(seek, "ArrowLeft").defaultPrevented).toBe(true);
  expect(video.currentTime).toBe(0);
  key(seek, "ArrowRight");
  expect(video.currentTime).toBe(5);
  const level = slider(root, ".pc-level");
  key(level, "ArrowLeft");
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

it("moves the seek bar's other keys by fixed steps, not by a share of the length: Page Up and Down 10 s, Home and End to the ends", () => {
  const { video, root, set } = setup();
  set({ duration: 3600 });
  const seek = slider(root, ".pc-seek");
  const steps = ["PageUp", "PageUp", "PageDown", "End", "PageUp", "Home", "PageDown"].map(name => {
    const event = key(seek, name);
    return [name, video.currentTime, event.defaultPrevented];
  });
  expect(steps).toEqual([
    ["PageUp", 10, true], ["PageUp", 20, true], ["PageDown", 10, true],
    ["End", 3600, true], ["PageUp", 3600, true], ["Home", 0, true], ["PageDown", 0, true],
  ]);
  // Elsewhere in the player these keys are not the player's.
  expect(key(video, "PageDown").defaultPrevented).toBe(false);
  key(slider(root, ".pc-level"), "ArrowUp");
});

it("turns the volume up and down a step with ↑ and ↓ wherever focus is in the player, the seek bar included (2026-10-06)", () => {
  const { video, root, set } = setup();
  set({ duration: 60 });
  video.volume = 0.5; video.muted = false;
  const seek = slider(root, ".pc-seek");
  expect(key(video, "ArrowUp").defaultPrevented).toBe(true);
  expect([video.volume, video.muted, video.currentTime]).toEqual([0.55, false, 0]);
  key(seek, "ArrowDown"); key(seek, "ArrowDown");
  expect([video.volume, video.currentTime]).toEqual([0.45, 0]);
  // Kept between nothing and full: ↓ to nothing mutes, as the slider does, and ↑ brings the sound back a step.
  video.volume = 0.98; key(video, "ArrowUp");
  expect(video.volume).toBe(1);
  video.volume = 0.04; key(video, "ArrowDown");
  expect([video.volume, video.muted]).toEqual([0, true]);
  key(video, "ArrowUp");
  expect([video.volume, video.muted]).toEqual([0.05, false]);
  // Muted counts as silent: ↑ unmutes at one step rather than jumping back to the old level.
  video.volume = 0.8; video.muted = true; key(video, "ArrowUp");
  expect([video.volume, video.muted]).toEqual([0.05, false]);
  // The volume slider keeps its own arrows; a modifier makes it someone else's shortcut.
  video.volume = 0.5; video.dispatchEvent(new Event("volumechange"));
  key(slider(root, ".pc-level"), "ArrowUp");
  expect(video.volume).toBe(0.55);
  key(video, "ArrowUp", { metaKey: true });
  expect(video.volume).toBe(0.55);
});

it("flashes what a click or key did over the picture, as YouTube does: play or pause and the volume at the centre with its level, a seek at its side (2026-10-06)", () => {
  const { video, root, set } = setup();
  set({ duration: 60 });
  video.volume = 0.5; video.muted = false;
  // Each flash is a fresh element, so its animation starts over: read them anew every time.
  const bezel = () => root.querySelector<HTMLElement>(".pc-bezel")!, level = () => root.querySelector<HTMLElement>(".pc-bezel-text")!;
  const back = () => root.querySelector<HTMLElement>(".pc-seek-back")!, forward = () => root.querySelector<HTMLElement>(".pc-seek-forward")!;
  // None of it is in the way, or read out: the controls already say their values.
  expect([bezel(), level(), back(), forward()].map(el => [el.hidden, el.getAttribute("aria-hidden")])).toEqual([[true, "true"], [true, "true"], [true, "true"], [true, "true"]]);
  key(video, "ArrowUp");
  expect([bezel().hidden, bezel().dataset.kind, level().hidden, level().textContent]).toEqual([false, "up", false, "55%"]);
  key(video, "ArrowDown"); key(video, "ArrowDown");
  expect([bezel().dataset.kind, level().textContent]).toEqual(["down", "45%"]);
  // The circle goes after half a second, its level a little later.
  flushSync(() => vi.advanceTimersByTime(500));
  expect([bezel().hidden, level().hidden]).toEqual([true, false]);
  flushSync(() => vi.advanceTimersByTime(300));
  expect(level().hidden).toBe(true);
  video.volume = 0.05; key(video, "ArrowDown");
  expect([bezel().dataset.kind, level().textContent]).toEqual(["muted", "0%"]);
  // → shows +5 at the right, ← −5 at the left, each putting the other away; pressed again it starts over.
  key(video, "ArrowRight");
  expect([forward().hidden, forward().textContent, back().hidden]).toEqual([false, "+5 s", true]);
  key(video, "ArrowLeft");
  expect([back().hidden, back().textContent, forward().hidden]).toEqual([false, "−5 s", true]);
  flushSync(() => vi.advanceTimersByTime(500));
  const first = back();
  key(video, "ArrowLeft");
  expect(back()).not.toBe(first);
  flushSync(() => vi.advanceTimersByTime(500));
  expect(back().hidden).toBe(false);
  flushSync(() => vi.advanceTimersByTime(200));
  expect(back().hidden).toBe(true);
  // The volume slider's own arrows flash nothing.
  flushSync(() => vi.advanceTimersByTime(800));
  key(slider(root, ".pc-level"), "ArrowUp");
  expect(bezel().hidden).toBe(true);
  // A click on the picture flashes what it did, and so does Space; the play button does not.
  flushSync(() => video.click());
  expect([bezel().hidden, bezel().dataset.kind, level().hidden]).toEqual([false, "play", true]);
  flushSync(() => vi.advanceTimersByTime(500));
  expect(bezel().hidden).toBe(true);
  click(document.getElementById("p-play")!);
  expect(bezel().hidden).toBe(true);
});

it("moves to where the seek bar is dragged, and sets the volume from its slider, at zero muted and brought back by its button", () => {
  const { video, root, set } = setup();
  set({ duration: 8 });
  const seek = slider(root, ".pc-seek");
  drag(root, ".pc-seek", 75);
  expect([video.currentTime, seek.getAttribute("aria-valuenow")]).toEqual([6, "6"]);
  const level = slider(root, ".pc-level");
  drag(root, ".pc-level", 0);
  video.dispatchEvent(new Event("volumechange"));
  expect([video.volume, video.muted, level.getAttribute("aria-valuetext")]).toEqual([0, true, "0%"]);
  click(document.getElementById("p-mute")!);
  video.dispatchEvent(new Event("volumechange"));
  // Read as a percentage, as the seek bar reads as the time (review: volume value text).
  expect([video.volume, video.muted, level.getAttribute("aria-label"), level.getAttribute("aria-valuetext")]).toEqual([0.5, false, "Volume", "50%"]);
});

it("steps the controls aside while it plays and the pointer rests, never while paused, and brings them back on a move", async () => {
  const { video, root } = setup();
  flushSync(() => vi.advanceTimersByTime(VIDEO_TIMING.idleMs + 10));
  expect(root.classList.contains("pc-idle")).toBe(false);
  await video.play();
  flushSync(() => vi.advanceTimersByTime(VIDEO_TIMING.idleMs + 10));
  expect(root.classList.contains("pc-idle")).toBe(true);
  flushSync(() => root.dispatchEvent(new PointerEvent("pointermove", { bubbles: true })));
  expect(root.classList.contains("pc-idle")).toBe(false);
  // Pausing shows them at once, and they stay.
  flushSync(() => vi.advanceTimersByTime(VIDEO_TIMING.idleMs - 100));
  video.pause();
  flushSync(() => vi.advanceTimersByTime(VIDEO_TIMING.idleMs + 10));
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
  expect(changes.filter(change => change.includes("aria-label") || change.includes("aria-valuetext"))).toEqual([]);
  expect(root.querySelector(".pc-time")!.textContent).toBe("0:02 / 0:08");
  const noops: MutationRecord[] = []; const same = new MutationObserver(records => noops.push(...records)); same.observe(root, { attributes: true, childList: true, subtree: true });
  video.dispatchEvent(new Event("timeupdate")); video.dispatchEvent(new Event("timeupdate")); await Promise.resolve(); same.disconnect(); expect(noops).toEqual([]);
});

it("reads where a video is the one way both windows hand it over: an ended or paused video is not playing, and no position is 0", () => {
  const video = document.createElement("video");
  let paused = false, ended = false, time = NaN;
  Object.defineProperty(video, "paused", { get: () => paused, configurable: true });
  Object.defineProperty(video, "ended", { get: () => ended, configurable: true });
  Object.defineProperty(video, "currentTime", { get: () => time, configurable: true });
  video.volume = 0.25; video.muted = true;
  expect(playbackOf(video)).toEqual({ time: 0, playing: true, volume: 0.25, muted: true });
  time = 12.5; ended = true;
  expect(playbackOf(video)).toMatchObject({ time: 12.5, playing: false });
  ended = false; paused = true;
  expect(playbackOf(video).playing).toBe(false);
});
