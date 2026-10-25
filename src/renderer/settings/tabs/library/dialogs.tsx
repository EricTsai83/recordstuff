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

/** The ids a name dialog's parts carry; the page's controller and its tests find them by these. */
interface NameDialogIds { dialog: string; input: string; error: string; cancel: string; confirm: string; title?: string }

/**
 * One name field in a dialog, for a category's name and a recording's: the field is selected as it opens, Enter (not
 * while composing) confirms, Escape and Cancel leave it, and an error is said under the field.
 */
function NameDialog({ ids, open, draft, title, description, label, placeholder, suffix, confirm, onCancel, onDraft, onSubmit }: {
  ids: NameDialogIds;
  open: boolean;
  draft: { name: string; error: string; pending: boolean } | undefined;
  title: string;
  description: string;
  label: string;
  placeholder?: string | undefined;
  /** Shown after the field and not part of it: a recording's extension. */
  suffix?: string | undefined;
  confirm: string;
  onCancel: () => void;
  onDraft: (name: string) => void;
  onSubmit: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        id={ids.dialog}
        className="clip-rename max-h-[calc(100dvh-32px)] overflow-y-auto"
        showCloseButton={false}
        initialFocus={() => {
          const field = document.getElementById(ids.input) as HTMLInputElement | null;
          field?.select();
          return field;
        }}
        finalFocus={false}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle id={ids.title} className="[overflow-wrap:anywhere]">
            {title}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {description}
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel className="sr-only" htmlFor={ids.input}>
            {label}
          </FieldLabel>
          <InputGroup className="clip-rename-field bg-card">
            <InputGroupInput
              id={ids.input}
              value={draft?.name ?? ""}
              placeholder={placeholder}
              spellCheck={false}
              autoComplete="off"
              aria-describedby={draft?.error ? ids.error : undefined}
              aria-invalid={Boolean(draft?.error)}
              onInput={(event) => onDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !isComposing(event)) {
                  event.preventDefault();
                  onSubmit();
                }
              }}
            />
            {suffix !== undefined && (
              <InputGroupAddon align="inline-end">
                <InputGroupText className="clip-rename-extension">{suffix}</InputGroupText>
              </InputGroupAddon>
            )}
          </InputGroup>
          <FieldError role={undefined} id={ids.error} className="clip-rename-error" hidden={!draft?.error}>
            {draft?.error}
          </FieldError>
        </Field>
        <DialogFooter className="clip-rename-buttons">
          <Button id={ids.cancel} variant="outline" onClick={onCancel}>
            {model.text("Cancel")}
          </Button>
          <Button id={ids.confirm} aria-disabled={draft?.pending} onClick={onSubmit}>
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** New folder, or Rename folder… for the folder shown: one name, checked as main will before it is sent. */
export function FolderDialog() {
  const dialog = model.folderDialog,
    language = model.view?.language,
    creating = dialog?.folder === undefined;
  return (
    <NameDialog
      ids={{ dialog: "library-folder-dialog", input: "library-folder-input", error: "library-folder-error",
        cancel: "library-folder-cancel", confirm: "library-folder-confirm" }}
      open={Boolean(dialog)}
      draft={dialog}
      title={creating ? model.text("New category") : translate("New name for {title}", language, { title: dialog?.folder ?? "" })}
      description={model.text(creating ? "New category" : "Rename category…")}
      label={model.text("Category name")}
      placeholder={model.text("Category name")}
      confirm={model.text(creating ? "Create" : "Rename")}
      onCancel={() => model.cancelFolderDialog()}
      onDraft={(name) => model.folderDraft(name)}
      onSubmit={() => void model.submitFolderDialog()}
    />
  );
}

/** A recording's Rename…: its name, with the extension shown beside the field and kept. */
export function RenameDialog() {
  const rename = model.renaming,
    item = model.view?.library?.items.find((item) => item.id === rename?.id);
  return (
    <NameDialog
      ids={{ dialog: "clip-rename", input: "clip-rename-input", error: "clip-rename-error",
        cancel: "clip-rename-cancel", confirm: "clip-rename-confirm", title: "clip-rename-label" }}
      open={Boolean(rename)}
      draft={rename}
      title={translate("New name for {title}", model.view?.language, { title: item?.title ?? "" })}
      description={model.text("Rename…")}
      label={model.text("Rename")}
      // Kept while the dialog closes and `renaming` is already gone, so the field does not change width mid-animation.
      suffix={rename?.extension ?? ""}
      confirm={model.text("Rename")}
      onCancel={() => model.cancelRename()}
      onDraft={(name) => model.renameDraft(name)}
      onSubmit={() => void model.submitRename()}
    />
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
        className="player aspect-video rounded-[14px] shadow-player ring-0 w-[min(calc(100vw-2*var(--dialog-margin)),calc((100dvh-2*var(--dialog-margin)-var(--dialog-top-reserve))*16/9))] max-w-none gap-0 overflow-hidden bg-media p-0 text-media-foreground sm:max-w-none top-[calc(50%+var(--dialog-top-reserve)/2)]"
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
