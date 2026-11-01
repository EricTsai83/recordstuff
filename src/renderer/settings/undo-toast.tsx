/**
 * The page's toasts, drawn by shadcn's Toast on Base UI (2026-11-01, at the maintainer's request; Sonner before): the
 * window's corner, one at a time. The controller's toast (the Trash's, its Restored, a notice) is one Base UI toast per
 * time it opens: "Restored" updates it in place, and a dismissal closes it; the controller keeps its timing (held while
 * the pointer or focus is on it), Escape and ⌘Z. A refused drag's promise toast is Base UI's own, its ring reading how
 * far the Video is from each push.
 */
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import {
  Toast,
  ToastContent,
  ToastDescription,
  ToastIcon,
  ToastPortal,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "../components/ui/toast";
import { Button } from "../components/ui/button";
import { ProgressRing } from "../components/progress-ring";
import * as model from "./settings-controller";

/** Base UI's id for the controller's toast of one opening (the controller's `show`). */
const toastIdOf = (show: number): string => `recordstuff-undo-${show}`;

export function ToastHost() {
  useSyncExternalStore(model.subscribe, model.snapshot);
  const state = model.toastState,
    open = Boolean(state?.open);
  // One Base UI toast per time it opens: "Restored" updates the open toast in place, while a toast shown as the last one
  // leaves is a new one.
  const shown = useRef("");
  useEffect(() => {
    if (open && state) {
      const id = toastIdOf(state.show);
      shown.current = id;
      model.pageToasts.add({
        id,
        title: state.title,
        description: state.description,
        type: state.type,
        // The controller times it.
        timeout: 0,
        data: { controlled: true },
        // A swipe or Base UI's Escape ends it as the controller would; an older toast leaving must not close the one
        // that replaced it.
        onClose: () => {
          if (model.toastState?.open && model.toastState.show === state.show) model.dismissToast();
        },
      });
    } else if (shown.current) {
      model.pageToasts.close(shown.current);
      shown.current = "";
    }
  }, [open, state, state?.title, state?.description, state?.type, state?.kind]);
  useEffect(
    () => () => {
      if (shown.current) model.pageToasts.close(shown.current);
    },
    [],
  );
  const inToast = (target: EventTarget | null): boolean =>
    target instanceof Element && Boolean(target.closest(".undo-toast[data-controlled]:not([data-ending-style])"));
  return (
    <ToastProvider toastManager={model.pageToasts} limit={1}>
      <ToastPortal>
        <ToastViewport
          // The controller says each toast in the page's own announcer, once.
          aria-live="off"
          aria-label={model.text("Notifications")}
          // Base UI's layer is above everything; the toast stays under the player and other dialogs.
          className="z-40"
          onMouseOver={(event) => {
            if (inToast(event.target)) model.holdToast("pointer", true);
          }}
          onMouseOut={(event) => {
            if (inToast(event.target) && !inToast(event.relatedTarget)) model.holdToast("pointer", false);
          }}
          onFocusCapture={(event) => {
            if (inToast(event.target)) model.holdToast("focus", true);
          }}
          onBlurCapture={(event) => {
            if (inToast(event.target) && !inToast(event.relatedTarget)) model.holdToast("focus", false);
          }}
        >
          <PageToasts />
        </ToastViewport>
      </ToastPortal>
    </ToastProvider>
  );
}

function PageToasts() {
  useSyncExternalStore(model.subscribe, model.snapshot);
  // A control removed with focus in it (Undo, once the toast says Restored) sends no blur: the hold ends here instead.
  useLayoutEffect(() => {
    if (model.toastState?.focus && !model.toastNode()?.contains(document.activeElement)) model.holdToast("focus", false);
  });
  const { toasts } = ToastPrimitive.useToastManager<{ controlled?: boolean; watch?: string }>();
  const undo = model.view?.library?.trashed?.undo ?? model.text("Undo"),
    key = model.platform() === "darwin" ? "⌘Z" : "Ctrl+Z",
    shortcut = model.platform() === "darwin" ? "Meta+Z" : "Control+Z";
  return toasts.map((item) => {
    const controlled = item.data?.controlled === true;
    const trashed = controlled && model.toastState?.open && toastIdOf(model.toastState.show) === item.id && model.toastState.kind === "trashed";
    // A refused drag's Video still being prepared: how far it is, from the recording's state in each push.
    const watched = item.type === "loading" && item.data?.watch
      ? model.view?.library?.items.find((entry) => entry.id === item.data?.watch)?.preparing
      : undefined;
    const percent = item.type === "loading" ? (watched?.state === "preparing" ? Math.round((watched.progress ?? 0) * 100) : 0) : undefined;
    return (
      <Toast
        key={item.id}
        toast={item}
        className="undo-toast"
        data-controlled={controlled || undefined}
        // A toast leaving under a newer one cannot be reached: its Undo would act on the newer trash (review of 2026-10-07).
        inert={item.transitionStatus === "ending" || item.limited || undefined}
      >
        <ToastContent className="items-start">
          {percent !== undefined ? <ProgressRing value={percent} label={model.text("Combining")} /> : <ToastIcon type={item.type} />}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <ToastTitle className="toast-title" />
            <ToastDescription className="toast-description" />
            {percent !== undefined && (
              // The Video goes on being prepared; the toast goes, and one says when it is ready (2026-11-01).
              <Button variant="outline" size="sm" className="toast-action mt-1 self-start" onClick={() => model.backgroundVideo(item.id)}>
                {model.text("Continue in background")}
              </Button>
            )}
          </div>
          {trashed && (
            <Button
              variant="outline"
              size="sm"
              className="toast-action shrink-0"
              aria-keyshortcuts={shortcut}
              // The toast stays: the controller turns it into "Restored" or leaves it when nothing waits.
              onClick={() => void model.undoTrash()}
            >
              <span className="toast-action-label">{undo}</span>
              {/* Only the shortcut beside Undo is the app's own, quieter than the label. */}
              <kbd className="toast-key ml-1.5 [font:inherit] opacity-[0.6]">{key}</kbd>
            </Button>
          )}
        </ToastContent>
      </Toast>
    );
  });
}
