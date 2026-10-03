/** Space between an ⓘ button and its explanation; the explanation's CSS bridges it so the pointer can cross. */
export const INFO_GAP = 6;
/** Closest the explanation comes to the window's edges. */
const MARGIN = 8;

/** `bridge` spans the button's columns, from the explanation's left edge, for the transparent strip over the gap. */
export interface InfoPlacement { left: number; top: number; side: "above" | "below"; bridge: { left: number; width: number } }

/**
 * Above the button, left-aligned to it and kept inside the window, so it covers
 * the row before rather than the control it explains; below when there is no
 * room above, and pressed against the top when there is room on neither side.
 */
export function infoPlacement(
  anchor: { left: number; right: number; top: number; bottom: number },
  box: { width: number; height: number },
  viewport: { width: number; height: number },
): InfoPlacement {
  const left = Math.round(Math.max(MARGIN, Math.min(anchor.left, viewport.width - box.width - MARGIN)));
  const bridge = { left: Math.round(anchor.left - left), width: Math.round(anchor.right - anchor.left) };
  const above = anchor.top - INFO_GAP - box.height;
  const below = anchor.bottom + INFO_GAP;
  if (above < MARGIN && below + box.height <= viewport.height - MARGIN) return { left, top: Math.round(below), side: "below", bridge };
  return { left, top: Math.round(Math.max(MARGIN, above)), side: "above", bridge };
}
