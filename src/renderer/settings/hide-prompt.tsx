/**
 * The window's hide prompt (2026-10-26, the maintainer's request: a stray Escape hid the window too easily): a first
 * Escape that nothing in the page takes opens it over the whole window, and a second Escape, or Hide window, hides it;
 * Cancel, a press outside it or the window losing the focus leaves it, the window staying. Its Escape is the
 * controller's (core.ts `hidePrompt`), so the dialog's own dismissal on Escape is not used.
 */
import { useSyncExternalStore } from "react";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import * as model from "./settings-controller";

export function HidePrompt() {
  useSyncExternalStore(model.subscribe, model.snapshot);
  return (
    <Dialog
      open={model.hidePrompt}
      onOpenChange={(open, details) => {
        if (!open && details.reason !== "escape-key") model.dismissHidePrompt();
      }}
    >
      <DialogContent
        id="hide-prompt"
        role="alertdialog"
        className="hide-prompt max-w-sm"
        showCloseButton={false}
        initialFocus={() => document.getElementById("hide-prompt-hide")}
      >
        <DialogHeader>
          <DialogTitle id="hide-prompt-title">{model.text("Press Esc again to hide the window")}</DialogTitle>
          <DialogDescription>{model.text("RecordStuff keeps running in the menu bar.")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button id="hide-prompt-cancel" variant="outline" onClick={() => model.dismissHidePrompt()}>
            {model.text("Cancel")}
          </Button>
          <Button id="hide-prompt-hide" onClick={() => model.confirmHide()}>
            {model.text("Hide window")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
