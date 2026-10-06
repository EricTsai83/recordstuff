/** The toast a move to the Trash and its undo show, hosted by sonner without its own styling. */
import { useEffect, useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Kbd } from "../components/ui/kbd";
import { Toaster } from "../components/ui/sonner";
import { toast } from "sonner";
import * as model from "./settings-controller";

export function UndoToast() {
  useSyncExternalStore(model.subscribe, model.snapshot);
  const state = model.toastState;
  return (
    <Card
      id="toast"
      className="undo-toast"
      data-kind={state?.kind}
      data-state={state?.open ? "open" : "closed"}
      hidden={!state?.visible}
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
        id="toast-close"
        variant="outline"
        size="icon-xs"
        className="toast-close"
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
        id="toast-action"
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
        <Kbd className="toast-key">
          {model.platform() === "darwin" ? "⌘Z" : "Ctrl+Z"}
        </Kbd>
      </Button>
    </Card>
  );
}
export function ToastHost() {
  useEffect(() => {
    toast.custom(() => <UndoToast />, {
      id: "recordstuff-undo",
      duration: Infinity,
      unstyled: true,
    });
  }, []);
  useEffect(
    () => () => {
      toast.dismiss("recordstuff-undo");
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
      position="bottom-right"
      visibleToasts={1}
      toastOptions={{
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
