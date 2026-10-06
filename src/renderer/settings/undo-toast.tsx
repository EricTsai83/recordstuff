/**
 * The toast a move to the Trash and its undo show. Sonner owns its life on screen (2026-10-07): each show mounts it and
 * Sonner slides it up in, a dismissal slides it down out and unmounts it, and "Restored" updates the same toast in place.
 * The controller keeps the timing (held by the pointer or focus, Escape, ⌘Z); the card is ours, unstyled by Sonner.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Kbd } from "../components/ui/kbd";
import { Toaster } from "../components/ui/sonner";
import { toast } from "sonner";
import * as model from "./settings-controller";

/** Sonner's id for the toast of one opening (the controller's `show`). */
const toastIdOf = (show: number): string => `recordstuff-undo-${show}`;
/** The newest toast; an older one still sliding out under a newer one keeps what it said, without the ids. */
export function UndoToast({ toastId }: { toastId: string | number }) {
  useSyncExternalStore(model.subscribe, model.snapshot);
  const live = model.toastState !== undefined && toastId === toastIdOf(model.toastState.show),
    kept = useRef(model.toastState && { ...model.toastState });
  if (live) kept.current = model.toastState && { ...model.toastState };
  const state = live ? model.toastState : kept.current && { ...kept.current, open: false };
  return (
    <Card
      id={live ? "toast" : undefined}
      inert={!live}
      // The close button sits on the card's corner, so the card does not clip; it fills Sonner's slot, which spans the
      // window's foot when narrow.
      className="undo-toast w-full flex-row gap-3 overflow-visible px-4 py-3.5 shadow-toast"
      data-kind={state?.kind}
      data-state={state?.open ? "open" : "closed"}
      onMouseEnter={() => model.holdToast("pointer", true)}
      onMouseLeave={() => model.holdToast("pointer", false)}
      onFocus={() => model.holdToast("focus", true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          model.holdToast("focus", false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          model.dismissToast();
        }
      }}
    >
      <Button
        id={live ? "toast-close" : undefined}
        variant="outline"
        size="icon-xs"
        className="toast-close rounded-full"
        aria-label={model.text("Close")}
        onClick={model.dismissToast}
      >
        <X />
      </Button>
      <div className="toast-content">
        <p className="toast-title">{state?.title}</p>
        <p className="toast-description">{state?.description}</p>
      </div>
      <Button
        id={live ? "toast-action" : undefined}
        size="sm"
        className="toast-action"
        hidden={state?.kind !== "trashed"}
        aria-disabled={model.undoPending()}
        aria-keyshortcuts={
          model.platform() === "darwin" ? "Meta+Z" : "Control+Z"
        }
        onClick={() => void model.undoTrash()}
      >
        <span className="toast-action-label">
          {model.view?.library?.trashed?.undo ?? model.text("Undo")}
        </span>
        <Kbd className="toast-key" variant="inline" size="md">
          {model.platform() === "darwin" ? "⌘Z" : "Ctrl+Z"}
        </Kbd>
      </Button>
    </Card>
  );
}
export function ToastHost() {
  useSyncExternalStore(model.subscribe, model.snapshot);
  const state = model.toastState,
    open = Boolean(state?.open);
  // One Sonner toast per time it opens: "Restored" updates the open toast in place, while a toast shown as the last one
  // slides out is a new one, which Sonner would otherwise merge into the leaving toast and remove with it (review of
  // 2026-10-07).
  const shown = useRef("");
  useEffect(() => {
    if (open && state) {
      shown.current = toastIdOf(state.show);
      toast.custom((id) => <UndoToast toastId={id} />, {
        id: shown.current,
        duration: Infinity,
        unstyled: true,
        // The controller decides when it leaves; a swipe would end the Undo behind its back.
        dismissible: false,
      });
    } else if (shown.current) {
      // It keeps its ids while it slides out, until a newer toast takes them.
      toast.dismiss(shown.current);
      shown.current = "";
    }
  }, [open, state]);
  useEffect(
    () => () => {
      if (shown.current) toast.dismiss(shown.current);
    },
    [],
  );
  return (
    <Toaster
      ref={(node) => {
        node?.setAttribute("aria-live", "off");
      }}
      hotkey={[]}
      theme="system"
      // Sonner's own layer is above everything; the toast stays under the player and other dialogs, as before.
      style={{ zIndex: 40 }}
      position="bottom-right"
      visibleToasts={1}
      toastOptions={{
        // Sonner sizes only its styled toasts: the unstyled one takes the toaster's width too, and narrow, Sonner's
        // own rule still spans the window's foot (review of 2026-10-07).
        className: "w-(--width)",
        style: {
          background: "transparent",
          border: 0,
          padding: 0,
          boxShadow: "none",
        },
      }}
    />
  );
}
