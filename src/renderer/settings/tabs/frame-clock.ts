/**
 * One clock for what the Recording Studio redraws (plan 075 step 8): the preview's frames when it draws, else a timer
 * at the Studio's rate. The meters paint on it, so the window composes one frame for each of the clock's ticks rather
 * than one for each preview frame, each level and each fall step apart, which cost Settings' processes more than the
 * preview itself (2026-10-18). Its rate is the preview's (plan 092, D1; studio-pace.ts): 5, 10 or 15 a second; each
 * frame Chromium composes costs about half a point of a core per frame a second (2026-10-19).
 */
import { STUDIO_FPS } from "../../../shared/studio-port";

const listeners = new Set<() => void>();
let interval = 1000 / STUDIO_FPS;
let drivenAt = 0;
let tickedAt = 0;
let timer: ReturnType<typeof setInterval> | undefined;

const tick = (): void => {
  tickedAt = performance.now();
  for (const listener of listeners) listener();
};

/**
 * Without preview frames for a while (none showing, or a still screen), the timer keeps the meters falling: it wakes
 * at the clock's rate and ticks unless a preview frame drove the clock lately.
 */
function startTimer(): void {
  timer = setInterval(() => {
    const now = performance.now();
    if (now - drivenAt > interval * 1.5 && now - tickedAt >= interval / 2) tick();
  }, interval);
}

/** Called on each frame; returns the call that stops it. */
export function onFrame(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) startTimer();
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
  if (1000 / fps === interval) return;
  interval = 1000 / fps;
  if (timer) {
    clearInterval(timer);
    startTimer();
  }
}
