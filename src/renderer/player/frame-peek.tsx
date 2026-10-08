/**
 * The frame at the moment a seek bar is pointed at, in a small picture of a fixed size above the bar with the moment
 * named beneath it, as YouTube's seek bars show one. Its own muted video, sought one seek at a time, exists only while
 * the peek is drawn: the caller mounts it while the pointer is on the bar and unmounts it when the pointer leaves.
 * Used by a library card's hover preview and by the player (embedded and full screen).
 */
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { formatDuration } from "../../shared/video-player";

export interface FramePeekHandle {
  /** Show `time` seconds, centred `fraction` of the way along its bar; ui.css keeps it whole inside the bar at any size. */
  point(fraction: number, time: number): void;
}

/** Seeks `el` one seek at a time: a moment asked for while one is under way is sought when that one lands. */
export function seeker(el: HTMLVideoElement, landed: () => void): { seek: (time: number) => void; stop: () => void } {
  let next: number | undefined;
  const seeked = (): void => {
    if (next === undefined) return landed();
    el.currentTime = next;
    next = undefined;
  };
  el.addEventListener("seeked", seeked);
  return {
    seek: (time) => {
      if (el.seeking) next = time;
      else el.currentTime = time;
    },
    stop: () => el.removeEventListener("seeked", seeked),
  };
}
/** Pause, drop the source and reload: releases the decoder and the file now rather than when the element is collected. */
export function unload(el: HTMLVideoElement): void {
  el.pause();
  el.removeAttribute("src");
  el.load();
}

export function FramePeek({ source, ref }: { source: string; ref?: Ref<FramePeekHandle> }) {
  const root = useRef<HTMLSpanElement>(null),
    video = useRef<HTMLVideoElement>(null),
    label = useRef<HTMLSpanElement>(null),
    seek = useRef<(time: number) => void>(() => {}),
    wanted = useRef<number | undefined>(undefined);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.muted = true;
    const frames = seeker(el, () => root.current?.setAttribute("data-ready", ""));
    seek.current = frames.seek;
    // A moment pointed at before the source could seek is sought once it can.
    const loaded = (): void => {
      if (wanted.current !== undefined) frames.seek(wanted.current);
    };
    el.addEventListener("loadedmetadata", loaded);
    return () => {
      el.removeEventListener("loadedmetadata", loaded);
      frames.stop();
      seek.current = () => {};
      unload(el);
    };
  }, []);
  useImperativeHandle(ref, () => ({
    point(fraction, time) {
      const node = root.current;
      if (!node) return;
      if (label.current) label.current.textContent = formatDuration(time);
      // A fraction, not pixels: a bar resized under a resting pointer (window or zoom) re-places it without a move.
      node.style.setProperty("--peek-at", String(fraction));
      wanted.current = time;
      if (video.current && video.current.readyState >= 1) seek.current(time);
    },
  }), []);
  return (
    <span ref={root} className="frame-peek" aria-hidden="true">
      <span className="frame-peek-picture">
        <video ref={video} src={source} muted playsInline disablePictureInPicture preload="auto" tabIndex={-1} />
      </span>
      <span ref={label} className="frame-peek-time" />
    </span>
  );
}
