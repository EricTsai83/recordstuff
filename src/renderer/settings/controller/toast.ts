/**
 * The page's toasts, Base UI's (2026-11-01, at the maintainer's request; Sonner's before). The controller's own: the
 * Trash/Restored toast and the notices a category action or a refused drag leave, whose timer pauses while the pointer
 * or focus is on it. And a refused drag's Video being prepared: a promise toast showing how far it is until it is ready
 * or could not be made, which can be sent to the background meanwhile. Only "trashed" offers Undo.
 */
import { Toast } from "@base-ui/react/toast";
import { sentences } from "../../../shared/i18n";
import { announce, draw, focus, selectedTab, text, view } from "./core";

/** The page's toast manager: ToastHost draws what it holds. */
export const pageToasts = Toast.createToastManager();

export let toastState:
  | {
      kind: "trashed" | "restored" | "notice";
      /** shadcn's icon: a check for what was done, an octagon for what went wrong; none for the Trash's toasts. */
      type?: "success" | "error" | undefined;
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
/**
 * How long a toast saying something went wrong or was refused stays (2026-11-01, at the maintainer's request: six or
 * seven seconds left too little time to read why); its timer still pauses under the pointer or focus. A toast that only
 * confirms keeps its own shorter time.
 */
export const PROBLEM_TOAST_MS = 12_000;
/**
 * While Undo restores, the push that drops the trash leaves its toast for "Restored" to take in place (Base UI would
 * otherwise slide it out and bring Restored in as another).
 */
export let restoring = false;
export const setRestoring = (on: boolean): void => {
  restoring = on;
};
let toastShows = 0;
/** The controller's toast on screen (undo-toast.tsx), not one leaving. */
export const toastNode = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('.undo-toast[data-controlled]:not([data-ending-style])');
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function showToast(
  kind: "trashed" | "restored" | "notice",
  title: string,
  description: string,
  ms: number,
  type?: "success" | "error",
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
    // The pointer on the toast this one replaces, leaving or not, is on this one: it opens in the same place.
    pointer: document.querySelector<HTMLElement>(".undo-toast[data-controlled]")?.matches(":hover") === true,
    focus: kind !== "notice" && focused,
    show: toastState?.open ? toastState.show : ++toastShows,
    type,
  };
  draw();
  resumeToast();
}
/** How long the toast that says a watched Video is ready stays. */
const READY_TOAST_MS = 5000;
type Watch = { id: string; toast: string; note: string; settle: (failed: boolean) => void; closed: boolean };
/** Refused drags' recordings whose Video is being prepared, by recording. */
const watches = new Map<string, Watch>();
let watchCount = 0;
const readyTitle = (): string => text("Done combining. Drag it again to copy.");
const failedTitle = (): string => text("Can't copy: video and sound could not be combined");
const failedNote = (note: string): string => sentences([text("Drag again to retry."), note], view?.language);

/**
 * A drag refused while its Video is being prepared (2026-11-01, at the maintainer's request: Base UI's promise toast,
 * with how far it is in a ring). It stays while the Video is prepared, then says it is ready or could not be made; its
 * Continue in background closes it, and the Video goes on, a toast of the controller's saying when it is done. A drag
 * of a recording whose toast is still on screen leaves that toast as it is.
 */
export function watchVideo(id: string, title: string, note: string): void {
  if (watches.get(id)?.closed === false) return;
  let settle: (failed: boolean) => void = () => {};
  const done = new Promise<void>((resolve, reject) => {
    settle = (failed) => (failed ? reject(new Error("not prepared")) : resolve());
  });
  const watch: Watch = { id, toast: `recordstuff-video-${++watchCount}`, note, settle, closed: false };
  watches.set(id, watch);
  void pageToasts
    .promise(done, {
      // Base UI's own id for the toast, so a recording gone can take it away; its loading options pass it to the toast.
      loading: { id: watch.toast, title, description: note, data: { watch: id }, onClose: () => { watch.closed = true; } } as never,
      success: { title: readyTitle(), description: "", timeout: READY_TOAST_MS },
      error: { title: failedTitle(), description: failedNote(note), timeout: PROBLEM_TOAST_MS },
    })
    .catch(() => {});
}
/** Continue in background: the toast goes, the Video goes on. */
export function backgroundVideo(toastId: string): void {
  pageToasts.close(toastId);
}
/**
 * After each push: a watched Video no longer being prepared settles its promise toast (ready, or could not be made); one
 * sent to the background says the same in a toast of the controller's; a recording gone takes its toast with it.
 */
export function followToast(): void {
  for (const watch of [...watches.values()]) {
    const item = view?.library?.items.find((entry) => entry.id === watch.id);
    if (item?.preparing?.state === "preparing") continue;
    watches.delete(watch.id);
    if (!item) {
      if (!watch.closed) pageToasts.close(watch.toast);
      continue;
    }
    const failed = item.preparing?.state === "failed";
    const title = failed ? failedTitle() : readyTitle(), description = failed ? failedNote(watch.note) : "";
    announce(description ? `${title}. ${description}` : title);
    if (watch.closed) showToast("notice", title, description, failed ? PROBLEM_TOAST_MS : READY_TOAST_MS, failed ? "error" : "success");
    else watch.settle(failed);
  }
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
