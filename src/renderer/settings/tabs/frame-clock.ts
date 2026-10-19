/**
 * One clock for what the Recording Studio redraws (plan 075 step 8): the preview's frames when it draws, else a timer
 * at the Studio's rate. The meters paint on it, so the window composes one frame for each of the clock's ticks rather
 * than one for each preview frame, each level and each fall step apart, which cost Settings' processes more than the
 * preview itself (2026-10-18). Its rate is 10 a second, or 5 while no one works in the Studio (plan 081, D1;
 * studio-pace.ts): each frame Chromium composes costs about half a point of a core per frame a second (2026-10-19).
 */
import { STUDIO_FPS } from "../../../shared/studio-port";

export const FRAME_MS = 1000 / STUDIO_FPS;

const listeners = new Set<() => void>();
let interval = FRAME_MS;
let drivenAt = 0;
let tickedAt = 0;
let timer: ReturnType<typeof setInterval> | undefined;

const tick = (): void => {
  tickedAt = performance.now();
  for (const listener of listeners) listener();
};

/** Called on each frame; returns the call that stops it. */
export function onFrame(listener: () => void): () => void {
  listeners.add(listener);
  // Without preview frames for a while (none showing, or a still screen), the timer keeps the meters falling. It wakes
  // at the full rate and ticks at the clock's, a few milliseconds early rather than a whole wake late.
  timer ??= setInterval(() => {
    const now = performance.now();
    if (now - drivenAt > interval * 1.5 && now - tickedAt >= interval - FRAME_MS / 2) tick();
  }, FRAME_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** The preview drew a frame: the clock's tick, in the same composited frame. */
export function frameDrawn(): void {
  drivenAt = performance.now();
  tick();
}

/** The clock's rate in frames a second (studio-pace.ts); the preview's frames follow it from the capture process. */
export function setFrameRate(fps: number): void {
  interval = 1000 / fps;
}
