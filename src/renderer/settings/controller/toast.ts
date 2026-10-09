/**
 * The Trash/Restored toast, and the notice a category action leaves (2026-10-09): its timer pauses while the pointer or
 * focus is on it; Sonner animates it out. Only "trashed" offers Undo.
 */
import { draw, focus, selectedTab } from "./core";

export let toastState:
  | {
      kind: "trashed" | "restored" | "notice";
      title: string;
      description: string;
      open: boolean;
      remaining: number;
      started: number;
      pointer: boolean;
      focus: boolean;
      /** Which time it opened: "Restored" over an open toast keeps it, a toast after a closed one takes the next. */
      show: number;
    }
  | undefined;
let toastShows = 0;
/** The toast on screen: Sonner's (undo-toast.tsx), not one still sliding out. */
export const toastNode = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('.undo-toast:not([data-removed="true"])');
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function showToast(
  kind: "trashed" | "restored" | "notice",
  title: string,
  description: string,
  ms: number,
): void {
  clearTimeout(toastTimer);
  const node = toastNode();
  // A notice has no button: focus on the toast it replaces (its Undo) would go with that button and never blur, holding
  // the notice's timer for good (review 2026-10-09). The focus goes where a dismissal sends it, and nothing is held.
  const focused = node?.contains(document.activeElement) === true;
  if (kind === "notice" && focused) focus(`tab-${selectedTab}`);
  toastState = {
    kind,
    title,
    description,
    open: true,
    remaining: ms,
    started: Date.now(),
    pointer: node?.matches(":hover") === true,
    focus: kind !== "notice" && focused,
    show: toastState?.open ? toastState.show : ++toastShows,
  };
  draw();
  resumeToast();
}
function resumeToast(): void {
  clearTimeout(toastTimer);
  if (!toastState?.open || toastState.pointer || toastState.focus) return;
  toastState.started = Date.now();
  toastTimer = setTimeout(dismissToast, toastState.remaining);
}
export function holdToast(what: "pointer" | "focus", on: boolean): void {
  if (!toastState || toastState[what] === on) return;
  const held = toastState.pointer || toastState.focus;
  toastState[what] = on;
  if (!held && (toastState.pointer || toastState.focus)) {
    clearTimeout(toastTimer);
    toastState.remaining = Math.max(
      0,
      toastState.remaining - (Date.now() - toastState.started),
    );
  } else if (held && !toastState.pointer && !toastState.focus) resumeToast();
}
export function dismissToast(): void {
  if (!toastState?.open) return;
  clearTimeout(toastTimer);
  if (toastNode()?.contains(document.activeElement))
    focus(`tab-${selectedTab}`);
  toastState.open = false;
  draw();
}
export function disposeToast(): void {
  clearTimeout(toastTimer);
}
