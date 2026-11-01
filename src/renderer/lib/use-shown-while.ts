/**
 * When work going on behind the page is shown (2026-11-01, the maintainer's choice, Share…'s preparing files): only once
 * it has lasted SHOW_AFTER_MS, so work done in a moment shows nothing, and once shown, for SHOW_AT_LEAST_MS at least, so
 * work done just past that does not show for a frame and go. Both as spin-delay's defaults and Nielsen's half-second
 * floor suggest. The wait counts from when the work was asked for, when that is known: work already waiting that long
 * shows at once, from the first frame.
 */
import { useLayoutEffect, useRef, useState } from "react";

export const SHOW_AFTER_MS = 500;
export const SHOW_AT_LEAST_MS = 500;

/**
 * Whether `active` work is shown now. `since` (epoch ms) is when it was asked for; `cut` (it failed) hides it at once,
 * for the failure to show instead.
 */
export function useShownWhile(active: boolean, { since, cut = false }: { since?: number | undefined; cut?: boolean | undefined } = {}): boolean {
  const waited = (): boolean => since !== undefined && Date.now() - since >= SHOW_AFTER_MS;
  const shownAt = useRef(0);
  const [shown, setShown] = useState(() => {
    const now = active && !cut && waited();
    if (now) shownAt.current = performance.now();
    return now;
  });
  // Before the page is painted: work that has already waited long enough shows in the draw that made it active, not a
  // frame later (2026-11-01: picking a Sound being prepared flashed its ready note for one frame).
  useLayoutEffect(() => {
    if (cut) {
      setShown(false);
      return undefined;
    }
    if (active && !shown) {
      const show = (): void => { shownAt.current = performance.now(); setShown(true); };
      const wait = since === undefined ? SHOW_AFTER_MS : Math.max(0, since + SHOW_AFTER_MS - Date.now());
      if (wait === 0) {
        show();
        return undefined;
      }
      const timer = setTimeout(show, wait);
      return () => clearTimeout(timer);
    }
    if (!active && shown) {
      const timer = setTimeout(() => setShown(false), Math.max(0, shownAt.current + SHOW_AT_LEAST_MS - performance.now()));
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [active, shown, cut, since]);
  return shown && !cut;
}
