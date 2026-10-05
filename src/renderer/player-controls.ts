/**
 * The player's own controls (2026-10-05), laid out as YouTube's full screen is: the title over the top edge, and
 * along the bottom a seek bar the width of the picture over play, volume and the time, with the way to or out of
 * full screen at the right. Shared by the page's player (settings.ts) and the full-screen window (video.ts).
 * Both fade while a video plays and the pointer rests, and stay while it is paused. Nothing runs on a timer while
 * the video is still: the seek bar follows `timeupdate`, which fires only while it plays.
 */
import { VIDEO_TIMING, formatDuration } from "../shared/video-player";
import { glyph } from "./glyph";

/** The controls' names for assistive technology and tooltips, in the page's language. */
export interface PlayerLabels {
  play: string;
  pause: string;
  mute: string;
  unmute: string;
  volume: string;
  position: string;
}
export interface PlayerControlsOptions {
  labels: PlayerLabels;
  /** Over the top edge: the title and what else the page shows there, such as its Close button. */
  top: HTMLElement;
  /** At the right end of the bar: full screen, or the way out of it. */
  trailing: HTMLElement[];
  /** F: what the full-screen button does. */
  fullScreen: () => void;
  /** An id prefix for the controls, so each page can name them. */
  id: string;
}
export interface PlayerControls {
  /** The video, its overlays and their controls; placed where the video should be. */
  root: HTMLElement;
  relabel(labels: PlayerLabels): void;
  /** Shows the controls, as a pointer move does; they fade again once it rests while the video plays. */
  wake(): void;
}

/** Filled marks on a 24-unit grid, white on the picture. */
const MARKS = {
  play: "M8 5.6v12.8a1 1 0 0 0 1.5.86l10.2-6.4a1 1 0 0 0 0-1.72L9.5 4.74A1 1 0 0 0 8 5.6Z",
  pause: "M7 5h3.2v14H7ZM13.8 5H17v14h-3.2Z",
  volume: "M4 9.2h3.6L12 5v14l-4.4-4.2H4ZM15 8.6a4.6 4.6 0 0 1 0 6.8l-1.1-1.1a3.1 3.1 0 0 0 0-4.6ZM17.4 6.2a8 8 0 0 1 0 11.6l-1.1-1.1a6.4 6.4 0 0 0 0-9.4Z",
  muted: "M4 9.2h3.6L12 5v14l-4.4-4.2H4ZM15.3 9.4l1.1-1.1 2.3 2.3 2.3-2.3 1.1 1.1-2.3 2.3 2.3 2.3-1.1 1.1-2.3-2.3-2.3 2.3-1.1-1.1 2.3-2.3Z",
} as const;
/** A filled mark from its path, white on the picture. */
export function mark(d: string): SVGSVGElement {
  return glyph("0 0 24 24", {}, { d, fill: "currentColor" });
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.className = className; return el;
}
/** A round control of the bar, named by its label. */
export function controlButton(id: string, className = ""): HTMLButtonElement {
  const el = element("button", `pc-button ${className}`.trim()); el.type = "button"; el.id = id;
  return el;
}
function name(el: HTMLElement, label: string): void {
  if (el.getAttribute("aria-label") !== label) { el.setAttribute("aria-label", label); el.title = label; }
}
/**
 * The controls follow `timeupdate`, about four times a second while playing: what has not changed is not written
 * again, so neither the page nor assistive technology is told of a change that did not happen.
 */
function setAttr(el: HTMLElement, attribute: string, value: string): void {
  if (el.getAttribute(attribute) !== value) el.setAttribute(attribute, value);
}
function setFill(el: HTMLElement, value: string): void {
  if (el.style.getPropertyValue("--pc-fill") !== value) el.style.setProperty("--pc-fill", value);
}

export function playerControls(video: HTMLVideoElement, options: PlayerControlsOptions): PlayerControls {
  let labels = options.labels;
  const root = element("div", "pc pc-paused");
  // Focusable from script, so Space and the arrows reach the controls' keys while the picture has focus.
  video.tabIndex = -1;
  video.controls = false;
  const top = element("div", "pc-top"); top.append(options.top);
  const bottom = element("div", "pc-bottom");
  const seek = element("input", "pc-seek"); seek.type = "range"; seek.id = `${options.id}-seek`; seek.min = "0"; seek.max = "0"; seek.step = "any"; seek.value = "0";
  const row = element("div", "pc-row");
  const play = controlButton(`${options.id}-play`);
  const volume = element("div", "pc-volume");
  const mute = controlButton(`${options.id}-mute`);
  const level = element("input", "pc-level"); level.type = "range"; level.id = `${options.id}-volume`; level.min = "0"; level.max = "1"; level.step = "0.05";
  volume.append(mute, level);
  const time = element("span", "pc-time");
  row.append(play, volume, time, element("span", "pc-spacer"), ...options.trailing);
  bottom.append(seek, row);
  root.append(video, top, bottom);

  /** The thumb is held: the bar follows the hand, not the video catching up. */
  let scrubbing = false;
  const playing = (): boolean => !video.paused && !video.ended;
  function sync(): void {
    const paused = !playing();
    if (root.classList.contains("pc-paused") !== paused) root.classList.toggle("pc-paused", paused);
    const shown = paused ? "play" : "pause";
    if (play.dataset.mark !== shown) { play.dataset.mark = shown; play.replaceChildren(mark(MARKS[shown])); }
    name(play, paused ? labels.play : labels.pause);
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (seek.max !== String(duration)) seek.max = String(duration);
    if (!scrubbing) seek.value = String(Math.min(video.currentTime || 0, duration));
    const at = Number(seek.value);
    setFill(seek, `${duration ? (at / duration) * 100 : 0}%`);
    const reading = `${formatDuration(at)} / ${formatDuration(duration)}`;
    if (time.textContent !== reading) time.textContent = reading;
    setAttr(seek, "aria-valuetext", reading);
    name(seek, labels.position);
    const silent = video.muted || video.volume === 0;
    const volumeMark = silent ? "muted" : "volume";
    if (mute.dataset.mark !== volumeMark) { mute.dataset.mark = volumeMark; mute.replaceChildren(mark(MARKS[volumeMark])); }
    name(mute, silent ? labels.unmute : labels.mute);
    const volume = String(silent ? 0 : video.volume);
    if (level.value !== volume) level.value = volume;
    const percent = `${Math.round(Number(level.value) * 100)}%`;
    setFill(level, percent);
    // Read as a percentage, as the seek bar reads as the time; muted reads 0%, as the slider shows.
    setAttr(level, "aria-valuetext", percent);
    name(level, labels.volume);
  }
  for (const type of ["play", "pause", "ended", "timeupdate", "durationchange", "loadedmetadata", "volumechange", "seeked", "emptied"])
    video.addEventListener(type, () => { sync(); if (type === "pause" || type === "ended") wake(); });

  function toggle(): void {
    if (playing()) video.pause();
    else void video.play().catch(() => {});
  }
  function toggleMute(): void {
    if (video.muted || video.volume === 0) { video.muted = false; if (video.volume === 0) video.volume = 0.5; }
    else video.muted = true;
  }
  play.addEventListener("click", toggle);
  mute.addEventListener("click", toggleMute);
  video.addEventListener("click", toggle);
  seek.addEventListener("pointerdown", () => { scrubbing = true; });
  for (const type of ["pointerup", "pointercancel", "change"]) seek.addEventListener(type, () => { scrubbing = false; sync(); });
  seek.addEventListener("input", () => { video.currentTime = Number(seek.value); sync(); });
  level.addEventListener("input", () => { video.volume = Number(level.value); video.muted = video.volume === 0; });

  // The keys YouTube uses, wherever focus is in the player; a focused control keeps its own (Space on a button, arrows on
  // the volume slider). The seek bar's arrows move 5 s as everywhere else: its `step="any"` would move 1% of the length,
  // 36 s of an hour's recording and a tenth of a second of a short one.
  root.addEventListener("keydown", event => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    const onButton = target instanceof HTMLButtonElement, onVolume = target === level;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if ((key === " " && !onButton) || key === "k") toggle();
    else if ((key === "ArrowLeft" || key === "ArrowRight") && !onVolume) {
      // Kept within the video; a length not known yet bounds nothing, or every step forward would land on 0.
      const end = Number.isFinite(video.duration) ? video.duration : Infinity;
      video.currentTime = Math.min(Math.max(0, video.currentTime + (key === "ArrowLeft" ? -5 : 5)), end);
    } else if (key === "m") toggleMute();
    else if (key === "f") options.fullScreen();
    else return;
    event.preventDefault();
    wake();
  });

  // At rest while it plays, the controls and the pointer step aside; a move, a press or a focused control brings them back.
  let idle: ReturnType<typeof setTimeout> | undefined;
  function rest(): void {
    clearTimeout(idle);
    // Kept while the pointer is over a bar or a control has keyboard focus, as YouTube keeps them.
    if (playing() && !root.querySelector(".pc-top:hover, .pc-bottom:hover, :focus-visible:not(video)")) root.classList.add("pc-idle");
  }
  function wake(): void {
    root.classList.remove("pc-idle");
    clearTimeout(idle);
    idle = setTimeout(rest, VIDEO_TIMING.idleMs);
  }
  for (const type of ["pointermove", "pointerdown", "keydown", "focusin"]) root.addEventListener(type, wake);
  root.addEventListener("pointerleave", () => { if (playing()) rest(); });
  video.addEventListener("play", wake);

  sync();
  return {
    root,
    relabel(next) { labels = next; sync(); },
    wake,
  };
}
