/**
 * One clock for what the Recording Studio redraws (plan 075 step 8): the preview's frames when it draws, about 15 a
 * second, else a timer at that rate. The meters paint on it, so the window composes about 15 frames a second rather
 * than one for each preview frame, each level and each fall step apart, which cost Settings' processes more than the
 * preview itself (2026-10-18).
 */
export const FRAME_MS = 1000 / 15;

const listeners = new Set<() => void>();
let drivenAt = 0;
let timer: ReturnType<typeof setInterval> | undefined;

const tick = (): void => { for (const listener of listeners) listener(); };

/** Called on each frame; returns the call that stops it. */
export function onFrame(listener: () => void): () => void {
  listeners.add(listener);
  // Without preview frames for a while (none showing, or a still screen), the timer keeps the meters falling.
  timer ??= setInterval(() => { if (performance.now() - drivenAt > FRAME_MS * 1.5) tick(); }, FRAME_MS);
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
