/**
 * The toast a move to the Trash and its undo show, drawn by Sonner itself (2026-10-07): shadcn's Toaster gives it the
 * app's popover, border and radius, and Sonner its title, description, action button and motion.
 * Sonner owns its life on screen: each opening is one Sonner toast that slides in, "Restored" updates it in place, and a
 * dismissal slides it out. The controller keeps the timing (held while the pointer or focus is on it), Escape and ⌘Z.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Toaster } from "../components/ui/sonner";
import { toast } from "sonner";
import * as model from "./settings-controller";

/** Sonner's id for the toast of one opening (the controller's `show`). */
const toastIdOf = (show: number): string => `recordstuff-undo-${show}`;

export function ToastHost() {
  useSyncExternalStore(model.subscribe, model.snapshot);
  const state = model.toastState,
    open = Boolean(state?.open),
    undo = model.view?.library?.trashed?.undo ?? model.text("Undo"),
    key = model.platform() === "darwin" ? "⌘Z" : "Ctrl+Z";
  // One Sonner toast per time it opens: "Restored" updates the open toast in place, while a toast shown as the last one
  // slides out is a new one, which Sonner would otherwise merge into the leaving toast and remove with it.
  const shown = useRef("");
  useEffect(() => {
    if (open && state) {
      shown.current = toastIdOf(state.show);
      toast(state.title, {
        id: shown.current,
        description: state.description,
        duration: Infinity,
        closeButton: false,
        className: "undo-toast",
        classNames: {
          title: "toast-title",
          description: "toast-description",
          actionButton: "toast-action",
        },
        action:
          state.kind === "trashed"
            ? {
                label: (
                  <>
                    <span className="toast-action-label">{undo}</span>
                    <kbd className="toast-key">{key}</kbd>
                  </>
                ),
                onClick: (event) => {
                  // The toast stays: the controller turns it into "Restored" or leaves it when nothing waits.
                  event.preventDefault();
                  void model.undoTrash();
                },
              }
            : undefined,
        // A swipe ends it as the controller would; an older toast leaving (which Sonner also
        // reports) must not close the one that replaced it.
        onDismiss: () => {
          if (model.toastState?.show === state.show) model.dismissToast();
        },
      });
    } else if (shown.current) {
      toast.dismiss(shown.current);
      shown.current = "";
    }
  }, [open, state, undo, key]);
  useEffect(
    () => () => {
      if (shown.current) toast.dismiss(shown.current);
    },
    [],
  );
  // Sonner's action button takes no attributes: name its shortcut for assistive technology once it is drawn.
  const host = useRef<HTMLDivElement>(null),
    shortcut = model.platform() === "darwin" ? "Meta+Z" : "Control+Z";
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const name = (): void => {
      for (const button of node.querySelectorAll(".undo-toast .toast-action"))
        if (button.getAttribute("aria-keyshortcuts") !== shortcut) button.setAttribute("aria-keyshortcuts", shortcut);
      // A toast sliding out under a newer one cannot be reached: its Undo would act on the newer trash (review of
      // 2026-10-07).
      for (const leaving of node.querySelectorAll<HTMLElement>('.undo-toast[data-removed="true"]:not([inert])'))
        leaving.inert = true;
    };
    name();
    const observer = new MutationObserver(name);
    observer.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-removed"] });
    return () => observer.disconnect();
  }, [shortcut]);
  const inToast = (target: EventTarget | null): boolean =>
    target instanceof Element && Boolean(target.closest('.undo-toast:not([data-removed="true"])'));
  return (
    <div
      ref={host}
      className="contents"
      onMouseOver={(event) => {
        if (inToast(event.target)) model.holdToast("pointer", true);
      }}
      onMouseOut={(event) => {
        if (inToast(event.target) && !inToast(event.relatedTarget))
          model.holdToast("pointer", false);
      }}
      // Focus is the controller's: it holds the toast, and on closing it returns focus to the tab. Sonner's list would
      // remember where focus came from and pull it back there as the toast leaves, so its focus events stop here
      // (review of 2026-10-07).
      onFocusCapture={(event) => {
        event.stopPropagation();
        if (inToast(event.target)) model.holdToast("focus", true);
      }}
      onBlurCapture={(event) => {
        event.stopPropagation();
        if (inToast(event.target) && !inToast(event.relatedTarget))
          model.holdToast("focus", false);
      }}
    >
      <Toaster
        ref={(node) => {
          node?.setAttribute("aria-live", "off");
        }}
        hotkey={[]}
        theme="system"
        // Sonner's own layer is above everything; the toast stays under the player and other dialogs.
        style={{ zIndex: 40 }}
        position="bottom-right"
        visibleToasts={1}
      />
    </div>
  );
}
