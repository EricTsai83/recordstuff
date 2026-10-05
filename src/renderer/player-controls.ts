/**
 * The player's own controls (2026-10-05), laid out as YouTube's full screen is: the title over the top edge, and
 * along the bottom a seek bar the width of the picture over play, volume and the time, with the way to or out of
 * full screen at the right. Shared by the page's player (settings.ts) and the full-screen window (video.ts).
 * Both fade while a video plays and the pointer rests, and stay while it is paused. Nothing runs on a timer while
 * the video is still: the seek bar follows `timeupdate`, which fires only while it plays.
 */
import { VIDEO_TIMING, formatDuration, type PlaybackState } from "../shared/video-player";
import { glyph } from "./glyph";

/** The controls' names for assistive technology and tooltips, in the page's language. */
export interface PlayerLabels {
  play: string;
  pause: string;
  mute: string;
  unmute: string;
  volume: string;
  position: string;
  /** "5 s", "5 秒": what ← and → show they moved, with a sign before it (2026-10-06). */
  seconds(value: number): string;
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
  /** The volume turned down: the speaker with its nearer wave only. */
  volumeDown: "M4 9.2h3.6L12 5v14l-4.4-4.2H4ZM15 8.6a4.6 4.6 0 0 1 0 6.8l-1.1-1.1a3.1 3.1 0 0 0 0-4.6Z",
  /** One of the three arrows a seek shows, pointing forward. */
  chevron: "M7 5.5 17 12 7 18.5Z",
} as const;
/** One step of the volume: the slider's, and what ↑ and ↓ turn it by. */
const VOLUME_STEP = 0.05;
/** How far ← and → move, in seconds. */
const ARROW_SEEK_SECONDS = 5;
/** How long each flash lasts: the volume's circle, its level at the top, and a seek's arrows and seconds. */
const BEZEL_MS = 500, BEZEL_TEXT_MS = 800, SEEK_HINT_MS = 650;
const reducedMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/**
 * The flashes, as YouTube's: the circle grows to twice its size as it fades; the level and a seek hold, then fade. With
 * reduced motion the circle only fades, and the arrows hold still (player-controls.css).
 */
const FLASHES: Record<"bezel" | "text" | "seek", (reduced: boolean) => Keyframe[]> = {
  bezel: reduced => reduced ? [{ opacity: 1 }, { opacity: 0 }]
    : [{ opacity: 1, transform: "translate(-50%, -50%) scale(1)" }, { opacity: 0, transform: "translate(-50%, -50%) scale(2)" }],
  text: () => [{ opacity: 1, offset: 0 }, { opacity: 1, offset: 0.7 }, { opacity: 0, offset: 1 }],
  seek: () => [{ opacity: 1, offset: 0 }, { opacity: 1, offset: 0.6 }, { opacity: 0, offset: 1 }],
};
/** Each shown flash's end, which puts it away; a newer flash of the same overlay replaces it. */
const flashEnds = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
/** Shows an overlay for `ms`, starting its animation over if it was already showing (a key pressed again). */
function flash(el: HTMLElement, kind: keyof typeof FLASHES, ms: number): void {
  stopFlash(el);
  el.hidden = false;
  // The arrows' own animation (CSS) starts over with the class.
  void el.offsetWidth;
  el.classList.add("pc-flashing");
  // A flash cut short by the next one rejects its `finished` promise: nothing waits on it.
  el.animate?.(FLASHES[kind](reducedMotion()), { duration: ms, easing: "linear", fill: "forwards" })?.finished.catch(() => {});
  flashEnds.set(el, setTimeout(() => stopFlash(el), ms));
}
function stopFlash(el: HTMLElement): void {
  clearTimeout(flashEnds.get(el));
  flashEnds.delete(el);
  for (const animation of el.getAnimations?.() ?? []) animation.cancel();
  el.classList.remove("pc-flashing");
  el.hidden = true;
}
/**
 * Where a video is and how it sounds, as one window hands it to the other: the player going full screen, and the
 * full-screen window handing back. One reading, so resuming behaves the same in both directions.
 */
export function playbackOf(video: HTMLVideoElement): PlaybackState {
  return { time: video.currentTime || 0, playing: !video.paused && !video.ended, volume: video.volume, muted: video.muted };
}
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
  const level = element("input", "pc-level"); level.type = "range"; level.id = `${options.id}-volume`; level.min = "0"; level.max = "1"; level.step = String(VOLUME_STEP);
  volume.append(mute, level);
  const time = element("span", "pc-time");
  row.append(play, volume, time, element("span", "pc-spacer"), ...options.trailing);
  bottom.append(seek, row);
  // What a key just did, flashed over the picture as YouTube does (2026-10-06): the volume in a circle at the centre
  // with its level at the top, and a seek as three arrows and the seconds at the side it went. Seen, not read: the
  // slider and the seek bar already say their values, and none of it takes a click meant for the picture.
  const bezel = element("div", "pc-bezel"); bezel.hidden = true;
  const levelText = element("div", "pc-bezel-text"); levelText.hidden = true;
  const [seekBack, seekForward] = (["back", "forward"] as const).map(side => {
    const hint = element("div", `pc-seek-hint pc-seek-${side}`); hint.hidden = true;
    const arrows = element("div", "pc-seek-arrows");
    for (let index = 0; index < 3; index++) { const arrow = element("span", "pc-seek-arrow"); arrow.append(mark(MARKS.chevron)); arrows.append(arrow); }
    hint.append(arrows, element("div", "pc-seek-label"));
    return hint;
  });
  for (const overlay of [bezel, levelText, seekBack!, seekForward!]) overlay.setAttribute("aria-hidden", "true");
  root.append(video, bezel, levelText, seekBack!, seekForward!, top, bottom);

  /** The thumb is held: the bar follows the hand, not the video catching up. */
  let scrubbing = false;
  const playing = (): boolean => playbackOf(video).playing;
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
  /**
   * ↑ and ↓ turn the volume up or down a slider step (2026-10-06), as YouTube's do. Muted counts as silent, so ↑ brings
   * the sound back at one step and ↓ to nothing mutes, as the slider does.
   */
  function nudgeVolume(by: number): void {
    const from = video.muted ? 0 : video.volume;
    const to = Math.round(Math.min(1, Math.max(0, from + by)) * 100) / 100;
    video.volume = to;
    video.muted = to === 0;
    bezel.replaceChildren(mark(MARKS[to === 0 ? "muted" : by > 0 ? "volume" : "volumeDown"]));
    bezel.dataset.kind = to === 0 ? "muted" : by > 0 ? "up" : "down";
    flash(bezel, "bezel", BEZEL_MS);
    levelText.textContent = `${Math.round(to * 100)}%`;
    flash(levelText, "text", BEZEL_TEXT_MS);
  }
  /** → or ←: the arrows and the seconds at that side, the other side's put away. */
  function showSeek(forward: boolean): void {
    const hint = forward ? seekForward! : seekBack!;
    stopFlash(forward ? seekBack! : seekForward!);
    hint.querySelector(".pc-seek-label")!.textContent = `${forward ? "+" : "−"}${labels.seconds(ARROW_SEEK_SECONDS)}`;
    flash(hint, "seek", SEEK_HINT_MS);
  }

  /** Kept within the video; a length not known yet bounds nothing, or every step forward would land on 0. */
  function seekTo(at: number): void {
    const end = Number.isFinite(video.duration) ? video.duration : Infinity;
    video.currentTime = Math.min(Math.max(0, at), end);
  }
  /**
   * The seek bar's own keys, in seconds from where the video is, or where they send it. Its `step="any"` would move
   * Page Up and Down by 10% of the length: 6 min of an hour's recording, a fraction of a second of a short one. So
   * they move 10 s. Up and Down are the volume's everywhere in the player, the seek bar included (2026-10-06).
   */
  const SEEK_KEYS: Record<string, (at: number) => number> = {
    PageUp: at => at + 10, PageDown: at => at - 10,
    Home: () => 0, End: () => (Number.isFinite(video.duration) ? video.duration : video.currentTime),
  };

  // The keys YouTube uses, wherever focus is in the player; a focused control keeps its own (Space on a button, arrows on
  // the volume slider). ← and → move 5 s, ↑ and ↓ turn the volume, the seek bar's other keys as SEEK_KEYS says.
  root.addEventListener("keydown", event => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    const onButton = target instanceof HTMLButtonElement, onVolume = target === level;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if ((key === " " && !onButton) || key === "k") toggle();
    else if ((key === "ArrowLeft" || key === "ArrowRight") && !onVolume) {
      seekTo(video.currentTime + (key === "ArrowLeft" ? -ARROW_SEEK_SECONDS : ARROW_SEEK_SECONDS));
      showSeek(key === "ArrowRight");
    }
    else if ((key === "ArrowUp" || key === "ArrowDown") && !onVolume) nudgeVolume(key === "ArrowUp" ? VOLUME_STEP : -VOLUME_STEP);
    else if (target === seek && Object.hasOwn(SEEK_KEYS, key)) seekTo(SEEK_KEYS[key]!(video.currentTime));
    else if (key === "m") toggleMute();
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
