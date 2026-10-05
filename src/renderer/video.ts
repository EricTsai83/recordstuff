/**
 * The fullscreen video page (src/shared/video-player.ts): plays one recording from where the player was, says when
 * its first frame is drawn so the window can fade in, and leaves on Escape, ⌘W, a double-click or its exit button with
 * where the video is now. Main owns the window and its fades; the page never closes it. The title and controls are
 * the player's own (player-controls.ts), laid out as YouTube's full screen is.
 */
import { documentLanguage, translate, isLanguage } from "../shared/i18n";
import { VIDEO_QUERY, type PlaybackState, type VideoBridge } from "../shared/video-player";
import { mark, playbackOf, playerControls } from "./player-controls";
import { browserPlatform, isCloseChord } from "./shortcut-capture";

declare global {
  interface Window {
    video?: VideoBridge;
  }
}

const query = new URLSearchParams(location.search);
/** A number main gave; a missing or empty one takes the fallback, as `Number(null)` would read 0. */
const number = (key: string, fallback: number): number => {
  const raw = query.get(key)?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : fallback;
};
const queried = query.get(VIDEO_QUERY.language);
const language = isLanguage(queried) ? queried : undefined;
document.documentElement.lang = documentLanguage(language);
const video = document.getElementById("video") as HTMLVideoElement;
const exitButton = document.getElementById("exit") as HTMLButtonElement;

const label = translate("Exit full screen", language);
exitButton.setAttribute("aria-label", label);
exitButton.title = label;
exitButton.className = "pc-button";
exitButton.hidden = false;
// Four corners pointing in: the way out, at the bar's right end where the player's Full screen was.
exitButton.append(mark("M9 4v5H4V7.2h3.2V4ZM15 4h1.8v3.2H20V9h-5ZM15 20v-5h5v1.8h-3.2V20ZM4 15h5v5H7.2v-3.2H4Z"));
// The recording's name over the top edge, as main named it from the listing.
const heading = document.createElement("div"); heading.className = "pc-heading";
const headingText = document.createElement("div"); headingText.className = "pc-heading-text";
const title = document.createElement("p"); title.className = "pc-title"; title.textContent = query.get(VIDEO_QUERY.title) ?? "";
headingText.append(title); heading.append(headingText);
heading.hidden = !title.textContent;
const controls = playerControls(video, {
  id: "video", top: heading, trailing: [exitButton], fullScreen: leave,
  labels: { play: translate("Play", language), pause: translate("Pause", language), mute: translate("Mute", language), unmute: translate("Unmute", language),
    volume: translate("Volume", language), position: translate("Playback position", language), seconds: value => translate("{value} s", language, { value }) },
});
document.body.prepend(controls.root);

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
/** The frame is drawn two animation frames after it is decoded, as the settings page reports its first paint. */
const drawn = (): void => { requestAnimationFrame(() => requestAnimationFrame(sayReady)); };
video.addEventListener("loadedmetadata", () => {
  if (start.time > 0 && start.time < video.duration) {
    video.addEventListener("seeked", drawn, { once: true });
    video.currentTime = start.time;
  // Metadata decodes no frame: without a seek, the first one is there once the current position's data is.
  } else if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) drawn();
  else video.addEventListener("loadeddata", drawn, { once: true });
}, { once: true });
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
  const state = playbackOf(video);
  video.pause();
  window.video?.exit(state);
}
exitButton.addEventListener("click", leave);
// A double-click leaves, as it enters from the player; the controls' own double-click would ask for the page's fullscreen.
video.addEventListener("dblclick", event => { event.preventDefault(); leave(); });
// ⌘W (Ctrl+W elsewhere) leaves too: the app menu has no Close, since each page closes on it itself (app-menu.ts).
const platform = browserPlatform();
document.addEventListener("keydown", event => {
  if ((event.key === "Escape" && !event.repeat) || isCloseChord(event, platform)) { event.preventDefault(); leave(); }
  if (event.key === "Tab") document.documentElement.dataset.input = "keyboard";
});
document.addEventListener("pointerdown", () => { delete document.documentElement.dataset.input; });

// The controls show while the pointer moves and step aside once it rests while the video plays (player-controls.ts).
controls.wake();
