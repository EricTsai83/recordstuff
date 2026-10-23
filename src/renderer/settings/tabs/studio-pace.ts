/**
 * How fast the Recording Studio shows the recording, at the rate the user chose (plan 092, D1). Power saving (and Off,
 * for the meters, which still run while the preview is off) follows plan 081's D1: the full rate while someone works
 * in the Studio, with the pointer over its window or a key, click or scroll in it within `ACTIVE_MS`, so dragging the
 * bubble, a fader or a mute answers as before; half the rate while it is only looked at, as during most of a recording
 * made in another app. Standard and Smooth hold one rate. Each frame Chromium composes costs the Studio's processes
 * about half a point of a core per frame a second.
 *
 * Whether someone works in the Studio is followed from the Studio's opening, whatever the rate, so choosing a rate
 * keeps what the pointer did before: a pacer made later would not know the pointer already rests on a window another
 * app is in front of (plan 092's after-round, 2026-10-23).
 */
import { FIXED_STUDIO_FPS, STUDIO_ACTIVE_MS, STUDIO_FPS, STUDIO_RESTING_FPS, type StudioFps, type StudioPreviewRate } from "../../../shared/studio-port";
import { setFrameRate } from "./frame-clock";
import { setPreviewRate } from "./studio-feed";

/** How long the full rate lasts after the last key, click or scroll with the pointer outside the window. */
export const ACTIVE_MS = STUDIO_ACTIVE_MS;

const INPUTS = ["pointerdown", "keydown", "wheel"] as const;

/** The Studio's pacing from its opening: `rate` sets the chosen rate, `stop` ends it at the full rate. */
export interface StudioPacer { rate(rate: StudioPreviewRate): void; stop(): void }

/** Paces the Studio at `rate` from now on, following its pointer and inputs until it stops. */
export function paceStudio(rate: StudioPreviewRate = "power", now: () => number = () => performance.now()): StudioPacer {
  const root = document.documentElement;
  let chosen = rate;
  let inside = root.matches(":hover");
  let inputAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: StudioFps | undefined;
  const show = (fps: StudioFps): void => {
    if (fps === current) return;
    current = fps;
    setFrameRate(fps);
    setPreviewRate(fps);
  };
  const apply = (): void => {
    clearTimeout(timer);
    timer = undefined;
    const fixed = FIXED_STUDIO_FPS[chosen];
    if (fixed !== undefined) return show(fixed);
    const left = ACTIVE_MS - (now() - inputAt);
    show(inside || left > 0 ? STUDIO_FPS : STUDIO_RESTING_FPS);
    if (!inside && left > 0) timer = setTimeout(apply, left);
  };
  const enter = (): void => { inside = true; apply(); };
  const leave = (): void => { inside = false; apply(); };
  const input = (): void => { inputAt = now(); apply(); };
  root.addEventListener("pointerenter", enter);
  root.addEventListener("pointerleave", leave);
  for (const type of INPUTS) window.addEventListener(type, input, { capture: true, passive: true });
  apply();
  return {
    rate(next) {
      if (next === chosen) return;
      chosen = next;
      apply();
    },
    stop() {
      clearTimeout(timer);
      root.removeEventListener("pointerenter", enter);
      root.removeEventListener("pointerleave", leave);
      for (const type of INPUTS) window.removeEventListener(type, input, { capture: true });
      show(STUDIO_FPS);
    },
  };
}
