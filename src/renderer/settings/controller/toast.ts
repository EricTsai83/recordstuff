/** The Trash/Restored toast: its timer pauses while the pointer or focus is on it, and it fades before it hides. */
import { draw, focus, selectedTab } from "./core";

export let toastState:
  | {
      kind: "trashed" | "restored";
      title: string;
      description: string;
      open: boolean;
      visible: boolean;
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
let toastFadeTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function showToast(
  kind: "trashed" | "restored",
  title: string,
  description: string,
  ms: number,
): void {
  clearTimeout(toastTimer);
  clearTimeout(toastFadeTimer);
  const node = toastNode();
  toastState = {
    kind,
    title,
    description,
    open: true,
    visible: true,
    remaining: ms,
    started: Date.now(),
    pointer: node?.matches(":hover") === true,
    focus: node?.contains(document.activeElement) === true,
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
  const closing = toastState;
  closing.open = false;
  draw();
  toastFadeTimer = setTimeout(() => {
    if (toastState === closing) {
      closing.visible = false;
      draw();
    }
  }, 160);
}
export function disposeToast(): void {
  clearTimeout(toastTimer);
  clearTimeout(toastFadeTimer);
}
