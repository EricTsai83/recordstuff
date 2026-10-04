/**
 * The fullscreen video page (src/shared/video-player.ts): plays one recording from where the player was, says when
 * its first frame is drawn so the window can fade in, and leaves on Escape, a double-click or its exit button with
 * where the video is now. Main owns the window and its fades; the page never closes it.
 */
import { translate, isLanguage } from "../shared/i18n";
import { VIDEO_QUERY, VIDEO_TIMING, type PlaybackState, type VideoBridge } from "../shared/video-player";

declare global {
  interface Window {
    video?: VideoBridge;
  }
}

const query = new URLSearchParams(location.search);
const number = (key: string, fallback: number): number => { const value = Number(query.get(key)); return Number.isFinite(value) ? value : fallback; };
const language = query.get(VIDEO_QUERY.language);
const video = document.getElementById("video") as HTMLVideoElement;
const exitButton = document.getElementById("exit") as HTMLButtonElement;

const label = translate("Exit full screen", isLanguage(language) ? language : undefined);
exitButton.setAttribute("aria-label", label);
exitButton.title = label;
// Two arrows pointing in, drawn with the text colour.
const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
path.setAttribute("d", "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7");
path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "1.8");
path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round");
svg.append(path); exitButton.append(svg);

const start: PlaybackState = {
  time: Math.max(0, number(VIDEO_QUERY.time, 0)),
  playing: query.get(VIDEO_QUERY.playing) === "1",
  volume: Math.min(1, Math.max(0, number(VIDEO_QUERY.volume, 1))),
  muted: query.get(VIDEO_QUERY.muted) === "1",
};
video.volume = start.volume;
video.muted = start.muted;

/** Said once: the first frame at the starting time is on screen, or the file could not be read. */
let readySaid = false;
/** The viewer has left (see `leave`). */
let left = false;
function sayReady(): void {
  if (readySaid) return;
  readySaid = true;
  window.video?.ready();
  // Left before the first frame: nothing starts playing behind the fade (review pass 1, F1).
  if (start.playing && !left) void video.play().catch(() => {});
  video.focus({ preventScroll: true });
}
video.addEventListener("loadedmetadata", () => {
  if (start.time > 0 && start.time < video.duration) video.currentTime = start.time;
  else video.dispatchEvent(new Event("seeked"));
}, { once: true });
// The frame is drawn two animation frames after the seek lands, as the settings page reports its first paint.
video.addEventListener("seeked", () => requestAnimationFrame(() => requestAnimationFrame(sayReady)), { once: true });
// A file that cannot be decoded still shows the window, to be left again.
video.addEventListener("error", sayReady);
video.src = query.get(VIDEO_QUERY.src) ?? "";

/**
 * Left once, with where the video is now. It stops here before the player goes on, so the two never sound
 * together while this window fades out (review pass 1, F1).
 */
function leave(): void {
  if (left) return;
  left = true;
  const state = { time: video.currentTime || 0, playing: !video.paused && !video.ended, volume: video.volume, muted: video.muted };
  video.pause();
  window.video?.exit(state);
}
exitButton.addEventListener("click", leave);
// A double-click leaves, as it enters from the player; the controls' own double-click would ask for the page's fullscreen.
video.addEventListener("dblclick", event => { event.preventDefault(); leave(); });
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !event.repeat) { event.preventDefault(); leave(); }
  if (event.key === "Tab") document.documentElement.dataset.input = "keyboard";
});
document.addEventListener("pointerdown", () => { delete document.documentElement.dataset.input; });

// The exit button and the pointer show while the pointer moves, and step aside once it rests.
let idle: ReturnType<typeof setTimeout> | undefined;
function wake(): void {
  exitButton.hidden = false;
  document.body.classList.remove("idle");
  clearTimeout(idle);
  idle = setTimeout(() => { if (!exitButton.matches(":hover, :focus-visible")) document.body.classList.add("idle"); }, VIDEO_TIMING.idleMs);
}
document.addEventListener("pointermove", wake);
document.addEventListener("keydown", wake);
wake();
