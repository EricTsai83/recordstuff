/**
 * A card's hover preview, as YouTube's home page plays one: a moment's rest on a grid card's picture plays the
 * recording there, muted, with a seek bar along its foot. Near the foot the bar rises over a strip of its own; the
 * pointer along it shows the frame at that moment in a small picture above it while the preview plays on, and a press
 * there (or a drag) moves the preview. A click elsewhere on the picture opens the player from what the preview shows.
 * One preview at a time: the card it leaves unloads its video, so
 * passing over many cards never holds more than one decoder.
 */
import { useEffect, useRef, useState } from "react";
import type { LibraryItemView } from "../../../shared/settings-panel";
import { FramePeek, seeker, unload, type FramePeekHandle } from "../../player/frame-peek";

/** How long the pointer rests on a picture before its preview starts, so a pass across the grid starts none. */
export const PREVIEW_DELAY_MS = 400;

let previewId: string | undefined,
  pendingId: string | undefined,
  timer: ReturnType<typeof setTimeout> | undefined,
  video: HTMLVideoElement | null = null,
  barPressed = false;
const listeners = new Set<() => void>();
const emit = (): void => {
  for (const listener of listeners) listener();
};

export function subscribePreview(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const previewing = (): string | undefined => previewId;
/** A press that began on a preview's seek bar: moving it seeks, and never drags the card's file out. */
export const pressedOnBar = (): boolean => barPressed;
const release = (): void => {
  barPressed = false;
};
addEventListener("pointerup", release, true);
addEventListener("pointercancel", release, true);
// A hidden window takes no pointer out of a card: a preview playing, or about to start, stops instead of playing unseen.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPreview();
});

/** The pointer rests on card `id`'s picture: its preview starts unless the pointer leaves first. */
export function hoverClip(id: string): void {
  if (previewId === id || pendingId === id) return;
  clearTimeout(timer);
  pendingId = id;
  timer = setTimeout(() => {
    pendingId = undefined;
    if (document.hidden) return;
    previewId = id;
    emit();
  }, PREVIEW_DELAY_MS);
}
/** The pointer left card `id`'s picture: a preview waiting to start does not, and a playing one unloads. */
export function leaveClip(id: string): void {
  if (pendingId === id) {
    clearTimeout(timer);
    pendingId = undefined;
  }
  if (previewId === id) stopPreview();
}
export function stopPreview(): void {
  clearTimeout(timer);
  pendingId = undefined;
  if (previewId === undefined) return;
  previewId = undefined;
  emit();
}
/** Where card `id`'s preview is, for the player to start there; undefined when it has none or has not moved. */
export function previewTime(id: string): number | undefined {
  if (previewId !== id || !video) return undefined;
  const time = video.currentTime;
  return Number.isFinite(time) && time > 0 ? time : undefined;
}

const clamp = (value: number): number => Math.min(1, Math.max(0, value));
const known = (el: HTMLVideoElement): boolean => Number.isFinite(el.duration) && el.duration > 0;

/** The preview itself, drawn over card `item`'s picture while it is the one previewed. */
export function ClipPreview({ item }: { item: LibraryItemView }) {
  const element = useRef<HTMLVideoElement>(null),
    fill = useRef<HTMLSpanElement>(null),
    knob = useRef<HTMLSpanElement>(null),
    ghost = useRef<HTMLSpanElement>(null),
    peek = useRef<FramePeekHandle>(null),
    seekMain = useRef<(time: number) => void>(() => {}),
    strip = useRef<HTMLSpanElement>(null),
    pointerX = useRef(0),
    // Reduced motion: nothing plays by itself; the picture changes only when a press on the bar moves it.
    still = useRef(matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [shown, setShown] = useState(false),
    // The small picture above the bar, and its own video, exist only while the pointer is on the bar's strip.
    [peeking, setPeeking] = useState(false),
    [pressed, setPressed] = useState(false);
  useEffect(() => {
    const el = element.current;
    if (!el) return;
    video = el;
    el.muted = true;
    if (!still.current) void el.play().catch(() => {});
    let frame = 0;
    // The bar follows the picture each frame by a transform and a small dot's offset: no render, no page layout.
    const tick = (): void => {
      if (known(el)) {
        const fraction = clamp(el.currentTime / el.duration);
        if (fill.current) fill.current.style.transform = `scaleX(${fraction})`;
        if (knob.current) knob.current.style.left = `${fraction * 100}%`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    // A sought frame shows even when nothing has played yet: under reduced motion, or pressed before playback began.
    const main = seeker(el, () => setShown(true));
    seekMain.current = main.seek;
    return () => {
      cancelAnimationFrame(frame);
      main.stop();
      if (video === el) video = null;
      unload(el);
      // The card left the page with its preview still on: nothing is previewed any more.
      if (previewId === item.id) queueMicrotask(stopPreview);
    };
  }, [item.id]);
  // The frame picture is placed where the pointer came in, before it moves again, and once more when the preview's
  // length is known if the pointer came in before it was.
  useEffect(() => {
    const el = element.current;
    if (!peeking || !el) return;
    const place = (): void => point(pointerX.current, false);
    place();
    el.addEventListener("loadedmetadata", place);
    return () => el.removeEventListener("loadedmetadata", place);
  }, [peeking]);
  /** The moment under the pointer: marked on the bar, named and shown above it; a press moves the preview there. */
  const point = (x: number, move: boolean): void => {
    pointerX.current = x;
    const el = element.current,
      box = strip.current?.getBoundingClientRect();
    if (!el || !box || !known(el) || box.width <= 0) return;
    const fraction = clamp((x - box.left) / box.width),
      time = fraction * el.duration;
    if (ghost.current) ghost.current.style.transform = `scaleX(${fraction})`;
    peek.current?.point(fraction, time);
    if (move) seekMain.current(time);
  };
  return (
    <span className="clip-preview" data-shown={shown || undefined} aria-hidden="true">
      <video
        ref={element}
        src={item.video}
        muted
        loop
        playsInline
        disablePictureInPicture
        preload="auto"
        tabIndex={-1}
        onPlaying={() => setShown(true)}
      />
      <span
        ref={strip}
        className="clip-scrub"
        data-pressed={pressed || undefined}
        onPointerEnter={(event) => {
          pointerX.current = event.clientX;
          setPeeking(true);
        }}
        onPointerMove={(event) => point(event.clientX, pressed)}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          barPressed = true;
          // A drag that wanders off the strip still moves the preview until the button is released.
          event.currentTarget.setPointerCapture(event.pointerId);
          setPressed(true);
          point(event.clientX, true);
        }}
        onPointerUp={() => setPressed(false)}
        onLostPointerCapture={(event) => {
          setPressed(false);
          if (!event.currentTarget.matches(":hover")) setPeeking(false);
        }}
        onPointerLeave={() => {
          if (!pressed) setPeeking(false);
        }}
        // A click on the strip only moves the preview; it does not open the player as the rest of the card does.
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <span className="clip-scrub-track">
          <span ref={ghost} className="clip-scrub-ghost" />
          <span ref={fill} className="clip-scrub-fill" />
        </span>
        <span ref={knob} className="clip-scrub-knob" />
        {peeking && <FramePeek ref={peek} source={item.video} />}
      </span>
    </span>
  );
}
