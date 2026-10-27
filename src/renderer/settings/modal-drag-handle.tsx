/**
 * The window's drag handle while a modal is open (2026-10-27, at the maintainer's request). An open dialog pauses the
 * page's drag surfaces, so its backdrop takes the click that closes it (ui.css, `window-drag`); nothing then moved the
 * window. On macOS a pill shows at the top centre while the pointer is near the window's top edge: it is a native drag
 * region, so dragging it moves the window as the title bar does (screen-edge tiling, and a double-click doing what the
 * system's title-bar setting says), and a click on it closes nothing. The rest of the backdrop is unchanged.
 *
 * One handle for the whole page, not one per dialog, so a dialog opened over another shows one; outside `#root`, as the
 * dialogs are, since the player and the edit view blur `#root`, which would hold it blurred under their backdrops
 * whatever its z-index (Codex review, 2026-10-27). This only says whether the pointer is near the top (`data-near`); the
 * stylesheet decides whether it shows at all: on macOS, while a modal is open and no menu, list or popover is.
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { GripVertical } from "lucide-react";
import * as model from "./settings-controller";

/**
 * Within this many CSS pixels of the top the handle shows: the title bar's strip (`--window-titlebar-height`), the
 * height the page drags by with no dialog open, so the window drags from the same place either way (2026-10-27, at
 * the maintainer's request; 56 px showed it before the pointer could reach it).
 */
export const REVEAL_PX = 40;
/** Below this the handle goes; between the two it stays as it is, so the pointer at the strip's edge does not flicker it. */
export const KEEP_PX = 48;
/** How long it stays once the pointer has gone: enough to absorb a jitter at the edge, short enough not to linger. */
export const HIDE_DELAY_MS = 120;

export function ModalDragHandle() {
  const handle = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = handle.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastY = Number.POSITIVE_INFINITY;
    const cancel = (): void => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
    const show = (): void => { cancel(); if (!element.hasAttribute("data-near")) element.setAttribute("data-near", ""); };
    const hideNow = (): void => { cancel(); element.removeAttribute("data-near"); };
    const hideSoon = (): void => {
      if (!element.hasAttribute("data-near") || timer !== undefined) return;
      timer = setTimeout(() => { timer = undefined; element.removeAttribute("data-near"); }, HIDE_DELAY_MS);
    };
    const move = (event: PointerEvent): void => {
      lastY = event.clientY;
      if (event.clientY <= REVEAL_PX) show();
      else if (event.clientY > KEEP_PX) hideSoon();
      // Back within the bounds before it went: it stays (Codex review, 2026-10-27); a hidden one still waits for the top.
      else cancel();
    };
    // The page hears nothing while the pointer is over the handle, a native drag region, and may be told the pointer
    // left; so a leave near the top keeps it, and only a leave from lower down, a later move or the window losing focus
    // takes it away.
    const leave = (): void => { if (lastY > REVEAL_PX) hideSoon(); };
    const root = document.documentElement;
    document.addEventListener("pointermove", move, { passive: true });
    root.addEventListener("pointerleave", leave);
    window.addEventListener("blur", hideNow);
    return () => {
      cancel();
      document.removeEventListener("pointermove", move);
      root.removeEventListener("pointerleave", leave);
      window.removeEventListener("blur", hideNow);
    };
  }, []);
  return createPortal(
    <div ref={handle} id="modal-drag-handle" className="modal-drag-handle" aria-hidden="true">
      <GripVertical />
      {model.text("Drag to move the window")}
    </div>,
    document.body,
  );
}
