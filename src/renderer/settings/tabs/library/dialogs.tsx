/**
 * The Recordings tab's dialogs: New category and Rename category, a recording's Rename, and the embedded player.
 */
import { useRef } from "react";
import { X, Maximize } from "lucide-react";
import type { LibraryItemView } from "../../../../shared/settings-panel";
import { phrases, translate } from "../../../../shared/i18n";
import { Button } from "../../../components/ui/button";
import { Field, FieldLabel, FieldError } from "../../../components/ui/field";
import { InputGroup, InputGroupInput, InputGroupAddon, InputGroupText } from "../../../components/ui/input-group";
import { ControlTooltip } from "../../../components/control-tooltip";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogHeader, DialogFooter } from "../../../components/ui/dialog";
import { Player } from "../../../player/player";
import * as model from "../../settings-controller";

/** A key an input method is still composing with (keyCode 229 where `isComposing` is not set): it is the method's, not ours. */
export function isComposing(event: React.KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/** New folder, or Rename folder… for the folder shown: one name, checked as main will before it is sent. */
export function FolderDialog() {
  const dialog = model.folderDialog,
    language = model.view?.language;
  return (
    <Dialog
      open={Boolean(dialog)}
      onOpenChange={(open) => {
        if (!open) model.cancelFolderDialog();
      }}
    >
      <DialogContent
        id="library-folder-dialog"
        className="clip-rename max-h-[calc(100dvh-32px)] overflow-y-auto"
        showCloseButton={false}
        initialFocus={() => {
          const field = document.getElementById("library-folder-input") as HTMLInputElement | null;
          field?.select();
          return field;
        }}
        finalFocus={false}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            model.cancelFolderDialog();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="[overflow-wrap:anywhere]">
            {dialog?.folder === undefined
              ? model.text("New category")
              : translate("New name for {title}", language, { title: dialog.folder })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {model.text(dialog?.folder === undefined ? "New category" : "Rename category…")}
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel className="sr-only" htmlFor="library-folder-input">
            {model.text("Category name")}
          </FieldLabel>
          <InputGroup className="clip-rename-field bg-card">
            <InputGroupInput
              id="library-folder-input"
              value={dialog?.name ?? ""}
              placeholder={model.text("Category name")}
              spellCheck={false}
              autoComplete="off"
              aria-describedby={dialog?.error ? "library-folder-error" : undefined}
              aria-invalid={Boolean(dialog?.error)}
              onInput={(event) => model.folderDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !isComposing(event)) {
                  event.preventDefault();
                  void model.submitFolderDialog();
                }
              }}
            />
          </InputGroup>
          <FieldError role={undefined} id="library-folder-error" className="clip-rename-error" hidden={!dialog?.error}>
            {dialog?.error}
          </FieldError>
        </Field>
        <DialogFooter className="clip-rename-buttons">
          <Button id="library-folder-cancel" variant="outline" onClick={() => model.cancelFolderDialog()}>
            {model.text("Cancel")}
          </Button>
          <Button id="library-folder-confirm" aria-disabled={dialog?.pending} onClick={() => void model.submitFolderDialog()}>
            {model.text(dialog?.folder === undefined ? "Create" : "Rename")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
export function RenameDialog() {
  const rename = model.renaming,
    item = model.view?.library?.items.find((item) => item.id === rename?.id);
  return (
    <Dialog
      open={Boolean(rename)}
      onOpenChange={(open) => {
        if (!open) model.cancelRename();
      }}
    >
      <DialogContent
        id="clip-rename"
        className="clip-rename max-h-[calc(100dvh-32px)] overflow-y-auto"
        showCloseButton={false}
        initialFocus={() => {
          const field = document.getElementById(
            "clip-rename-input",
          ) as HTMLInputElement | null;
          field?.select();
          return field;
        }}
        finalFocus={false}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            model.cancelRename();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle id="clip-rename-label" className="[overflow-wrap:anywhere]">
            {translate("New name for {title}", model.view?.language, {
              title: item?.title ?? "",
            })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {model.text("Rename…")}
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel className="sr-only" htmlFor="clip-rename-input">
            {model.text("Rename")}
          </FieldLabel>
          <InputGroup className="clip-rename-field bg-card">
            <InputGroupInput
              id="clip-rename-input"
              value={rename?.name ?? ""}
              spellCheck={false}
              autoComplete="off"
              aria-describedby={rename?.error ? "clip-rename-error" : undefined}
              aria-invalid={Boolean(rename?.error)}
              onInput={(event) => model.renameDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !isComposing(event)) {
                  event.preventDefault();
                  void model.submitRename();
                }
              }}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupText className="clip-rename-extension">{rename?.extension}</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
          <FieldError role={undefined}
            id="clip-rename-error"
            className="clip-rename-error"
            hidden={!rename?.error}
          >
            {rename?.error}
          </FieldError>
        </Field>
        <DialogFooter className="clip-rename-buttons">
          <Button
            id="clip-rename-cancel"
            variant="outline"
            onClick={() => model.cancelRename()}
          >
            {model.text("Cancel")}
          </Button>
          <Button
            id="clip-rename-confirm"
            aria-disabled={rename?.pending}
            onClick={() => void model.submitRename()}
          >
            {model.text("Rename")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
export function PlayerDialog() {
  const cached = useRef<LibraryItemView | undefined>(undefined);
  if (model.playingItem) cached.current = model.playingItem;
  const item = cached.current;
  return (
    <Dialog
      open={Boolean(model.playingItem)}
      onOpenChange={(open, details) => {
        if (!open) {
          if (details.reason === "escape-key") model.markEscapeClosed();
          model.closePlayer();
        }
      }}
    >
      <DialogContent
        keepMounted
        // The player's stage: as wide as the window allows at 16:9, black in both themes, below the title bar on macOS.
        // The backdrop only darkens; ui.css blurs the page under it (#root), which costs nothing per video frame.
        overlayClassName="bg-media-backdrop supports-backdrop-filter:backdrop-blur-none"
        className="player aspect-video rounded-[14px] shadow-player ring-0 w-[min(calc(100vw-48px),calc((100dvh-72px)*16/9))] max-w-none gap-0 overflow-hidden bg-media p-0 text-media-foreground sm:max-w-none darwin:top-[calc(50%+24px)]"
        data-id={item?.id}
        showCloseButton={false}
        initialFocus={() => model.playerVideo}
        finalFocus={false}
        onKeyDown={(event) => {
          if (
            event.key === "Escape" &&
            (event.repeat || model.fullScreenPending)
          )
            event.preventDefault();
        }}
      >
        <DialogTitle id="player-title" className="sr-only">
          {item?.title}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {model.text("Play")}
        </DialogDescription>
        {item && (
          <Player
            id="player"
            source={model.playingItem?.video ?? ""}
            title={item.title}
            meta={[
              phrases([item.day, item.time], model.view?.language),
              item.duration,
              item.size,
            ]
              .filter(Boolean)
              .join(" · ")}
            language={model.view?.language ?? "en"}
            videoRef={model.attachVideo}
            onError={model.playerFailed}
            onDoubleClick={() => void model.playFullScreen()}
            onPlay={() => {
              if (model.fullScreenPending) model.playerVideo?.pause();
            }}
            fullScreen={() => void model.playFullScreen()}
            error={model.playerError}
            trailing={
              <ControlTooltip label={model.text("Full screen")}>
                <Button
                  variant="media"
                  size="icon-media"
                  id="player-fullscreen"
                  aria-label={model.text("Full screen")}
                  onClick={() => void model.playFullScreen()}
                >
                  <Maximize />
                </Button>
              </ControlTooltip>
            }
            close={
              <ControlTooltip label={model.text("Close")}>
                <Button
                  variant="media"
                  size="icon-media"
                  id="player-close"
                  aria-label={model.text("Close")}
                  onClick={() => model.closePlayer()}
                >
                  <X />
                </Button>
              </ControlTooltip>
            }
          />
        )}
        <p
          id="player-feedback"
          className="sr-only"
          role="status"
          aria-live="polite"
        >
          {model.feedbackText}
        </p>
      </DialogContent>
    </Dialog>
  );
}
