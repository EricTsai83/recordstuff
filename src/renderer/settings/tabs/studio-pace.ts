/**
 * How fast the Recording Studio shows the recording (plan 081, D1): at the full rate while someone works in it, with
 * the pointer over its window or a key, click or scroll in it within `ACTIVE_MS`, so dragging the bubble, a fader or a
 * mute answers as before; at half the rate while it is only looked at, as during most of a recording made in another
 * app. Each frame Chromium composes costs the Studio's processes about half a point of a core per frame a second.
 */
import { STUDIO_ACTIVE_MS, STUDIO_FPS, STUDIO_RESTING_FPS } from "../../../shared/studio-port";
import { setFrameRate } from "./frame-clock";
import { setPreviewRate } from "./studio-feed";

/** How long the full rate lasts after the last key, click or scroll with the pointer outside the window. */
export const ACTIVE_MS = STUDIO_ACTIVE_MS;

const INPUTS = ["pointerdown", "keydown", "wheel"] as const;

/** Paces the Studio from now on; returns the call that stops, which leaves the full rate. */
export function paceStudio(now: () => number = () => performance.now()): () => void {
  const root = document.documentElement;
  let inside = root.matches(":hover");
  let inputAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let shown: number | undefined;
  const show = (fps: typeof STUDIO_FPS | typeof STUDIO_RESTING_FPS): void => {
    if (fps === shown) return;
    shown = fps;
    setFrameRate(fps);
    setPreviewRate(fps);
  };
  const apply = (): void => {
    clearTimeout(timer);
    timer = undefined;
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
  return () => {
    clearTimeout(timer);
    root.removeEventListener("pointerenter", enter);
    root.removeEventListener("pointerleave", leave);
    for (const type of INPUTS) window.removeEventListener(type, input, { capture: true });
    show(STUDIO_FPS);
  };
}
