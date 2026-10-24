/**
 * The edit view (plan 085): a recording's player above a timeline of its parts. A part is selected by clicking it, split
 * at the playhead (S) and removed or kept again (Delete); Undo (⌘Z / Ctrl+Z) takes the last change back. The preview
 * plays only what is kept. Export writes a new file beside the recording, which stays as it is.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FolderOpen, RotateCcw, Scissors, Trash2, Undo2, Upload, X } from "lucide-react";
import type { LibraryItemView } from "../../../../shared/settings-panel";
import { phrases, translate } from "../../../../shared/i18n";
import { Button } from "../../../components/ui/button";
import { ControlTooltip } from "../../../components/control-tooltip";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../../components/ui/dialog";
import { Player } from "../../../player/player";
import * as model from "../../settings-controller";

/**
 * Follows the preview's position to draw the playhead: on each frame shown while it plays, and on each seek. Nothing
 * runs while it is paused.
 */
function usePlayhead(): number {
  const video = model.editorVideo;
  const [time, setTime] = useState(0);
  useEffect(() => {
    if (!video) return;
    let callback: number | undefined;
    const show = (): void => setTime(video.currentTime || 0);
    const frame = (): void => {
      show();
      callback = video.requestVideoFrameCallback(frame);
    };
    const play = (): void => {
      if (callback === undefined && typeof video.requestVideoFrameCallback === "function") callback = video.requestVideoFrameCallback(frame);
    };
    const pause = (): void => {
      if (callback !== undefined) video.cancelVideoFrameCallback(callback);
      callback = undefined;
      show();
    };
    const events: Array<[string, () => void]> = [["seeked", show], ["timeupdate", show], ["loadedmetadata", show], ["play", play], ["pause", pause]];
    for (const [name, listener] of events) video.addEventListener(name, listener);
    show();
    if (!video.paused) play();
    return () => {
      for (const [name, listener] of events) video.removeEventListener(name, listener);
      if (callback !== undefined) video.cancelVideoFrameCallback(callback);
    };
  }, [video]);
  return time;
}

/** Keys of the edit view that are not the player's: Split, Remove or keep, Undo. */
function editorKey(event: React.KeyboardEvent): void {
  const target = event.target as HTMLElement;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  const command = model.platform() === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (command && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z") {
    event.preventDefault();
    event.stopPropagation();
    void model.undoEdit();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "s" || event.key === "S") {
    event.preventDefault();
    model.splitAtPlayhead();
  } else if ((event.key === "Delete" || event.key === "Backspace") && target.closest(".editor-panel")) {
    event.preventDefault();
    void model.toggleSelected();
  }
}

export function EditorDialog() {
  useSyncExternalStore(model.subscribe, model.snapshot);
  const cached = useRef<LibraryItemView | undefined>(undefined);
  if (model.editingItem) cached.current = model.editingItem;
  const item = cached.current;
  const editor = model.editorView();
  const language = model.view?.language ?? "en";
  const exporting = editor?.export.phase === "exporting";
  return (
    <Dialog
      open={Boolean(model.editingItem)}
      onOpenChange={(open) => {
        if (!open) model.closeEditor();
      }}
    >
      <DialogContent
        keepMounted
        id="editor"
        overlayClassName="bg-media-backdrop supports-backdrop-filter:backdrop-blur-none"
        // As wide as the window allows with the timeline under a 16:9 picture.
        className="editor flex w-[min(calc(100vw-48px),calc((100dvh-232px)*16/9))] max-w-none flex-col gap-0 overflow-hidden rounded-[14px] p-0 shadow-player ring-0 sm:max-w-none darwin:top-[calc(50%+24px)]"
        data-id={item?.id}
        showCloseButton={false}
        initialFocus={() => model.editorVideo}
        finalFocus={false}
        onKeyDown={editorKey}
      >
        <DialogTitle id="editor-title" className="sr-only">
          {translate("Edit {title}", language, { title: item?.title ?? "" })}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {model.text("Select a part of the timeline, then remove it. Split at the playhead to mark where a part starts or ends.")}
        </DialogDescription>
        <div className="editor-stage aspect-video bg-media text-media-foreground">
          {item && (
            <Player
              id="editor-player"
              source={item.video}
              title={translate("Edit {title}", language, { title: item.title })}
              meta={[phrases([item.day, item.time], language), item.duration, item.size].filter(Boolean).join(" · ")}
              language={language}
              videoRef={model.attachEditorVideo}
              onDoubleClick={() => undefined}
              fullScreen={() => undefined}
              trailing={null}
              close={
                <ControlTooltip label={exporting ? model.text("Cancel the export to close") : model.text("Close")}>
                  <Button
                    variant="media"
                    size="icon-media"
                    id="editor-close"
                    aria-label={model.text("Close")}
                    aria-disabled={exporting}
                    onClick={() => model.closeEditor()}
                  >
                    <X />
                  </Button>
                </ControlTooltip>
              }
            />
          )}
        </div>
        {item && <EditorPanel />}
        <p id="editor-feedback" className="sr-only" role="status" aria-live="polite">
          {model.feedbackText}
        </p>
      </DialogContent>
    </Dialog>
  );
}

function EditorPanel() {
  const editor = model.editorView();
  const time = usePlayhead();
  const language = model.view?.language ?? "en";
  if (!editor || editor.state === "loading") {
    return (
      <div className="editor-panel" aria-busy="true">
        <p className="editor-message text-muted-foreground">{model.text("Loading the recording…")}</p>
      </div>
    );
  }
  if (editor.state !== "ready") {
    return (
      <div className="editor-panel">
        <p className="editor-message" role="alert">{editor.message}</p>
        <div className="editor-actions">
          {(editor.state === "stale" || editor.state === "unreadable") && (
            <Button id="editor-discard" variant="outline" onClick={() => void model.discardEdit()}>
              <RotateCcw />
              {model.text("Discard edit")}
            </Button>
          )}
          <span className="editor-spacer" />
          <Button id="editor-done" variant="outline" onClick={() => model.closeEditor()}>{model.text("Close")}</Button>
        </div>
      </div>
    );
  }
  const parts = model.timelineParts(editor);
  const selected = model.selectedPart(editor);
  const busy = model.editorSaving || editor.export.phase === "exporting";
  const percent = (ticks: number): string => `${(ticks / editor.duration) * 100}%`;
  const at = (seconds: number): string => model.clock(seconds);
  const removing = selected && !selected.removed;
  return (
    <div className="editor-panel">
      <div className="editor-timeline" role="group" aria-label={model.text("Timeline")}>
        {parts.map((part) => {
          const label = translate(part.removed ? "{from} to {to}, removed" : "{from} to {to}, kept", language, {
            from: at(part.from / editor.timescale),
            to: at(part.to / editor.timescale),
          });
          return (
            <button
              key={`${part.from}-${part.to}`}
              type="button"
              className="editor-part"
              data-removed={part.removed || undefined}
              data-selected={selected?.from === part.from || undefined}
              style={{ left: percent(part.from), width: percent(part.to - part.from) }}
              aria-label={label}
              aria-pressed={selected?.from === part.from}
              disabled={busy}
              onClick={() => model.selectPart(part)}
            />
          );
        })}
        {editor.notes.map((note) => (
          <span key={note.at} className="editor-note-mark" style={{ left: `${(note.at / editor.seconds) * 100}%` }} aria-hidden="true" />
        ))}
        <span className="editor-playhead" style={{ left: `${Math.min(100, (time / Math.max(editor.seconds, 0.001)) * 100)}%` }} aria-hidden="true" />
      </div>
      <div className="editor-actions">
        <ControlTooltip label={model.text("Split at the playhead (S)")}>
          <Button id="editor-split" variant="outline" size="sm" disabled={busy} onClick={() => model.splitAtPlayhead()}>
            <Scissors />
            {model.text("Split")}
          </Button>
        </ControlTooltip>
        <ControlTooltip label={model.text(removing ? "Remove the selected part (Delete)" : "Keep the selected part (Delete)")}>
          <Button id="editor-remove" variant="outline" size="sm" disabled={busy || !selected} onClick={() => void model.toggleSelected()}>
            {removing || !selected ? <Trash2 /> : <RotateCcw />}
            {model.text(removing || !selected ? "Remove part" : "Keep part")}
          </Button>
        </ControlTooltip>
        <ControlTooltip label={model.text(model.platform() === "darwin" ? "Undo (⌘Z)" : "Undo (Ctrl+Z)")}>
          <Button id="editor-undo" variant="outline" size="sm" disabled={busy || !model.canUndo()} onClick={() => void model.undoEdit()}>
            <Undo2 />
            {model.text("Undo")}
          </Button>
        </ControlTooltip>
        <span className="editor-spacer" />
        <span className="editor-length text-muted-foreground">
          {translate("Export length {length}", language, { length: at(editor.outputSeconds) })}
        </span>
        <ExportControls />
      </div>
      {(editor.notes.length > 0 || editor.saveFailure || (editor.blocked && editor.export.phase !== "exporting")) && (
        <ul className="editor-notes">
          {editor.saveFailure && <li className="editor-failure" role="alert">{editor.saveFailure}</li>}
          {editor.blocked && editor.export.phase !== "exporting" && <li>{editor.blocked}</li>}
          {editor.notes.map((note) => (
            <li key={note.at}>
              <span className="editor-note-time">{at(note.at)}</span> {note.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ExportControls() {
  const editor = model.editorView();
  if (!editor) return null;
  const state = editor.export;
  if (state.phase === "exporting") {
    const percent = Math.round(state.progress * 100);
    return (
      <span className="editor-export">
        <span
          className="editor-progress"
          role="progressbar"
          aria-label={model.text("Export progress")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={{ width: `${percent}%` }} />
        </span>
        <span className="editor-percent">{percent}%</span>
        <Button id="editor-cancel-export" variant="outline" size="sm" aria-disabled={state.cancelling} onClick={() => void model.cancelExport()}>
          {model.text(state.cancelling ? "Cancelling…" : "Cancel export")}
        </Button>
      </span>
    );
  }
  return (
    <span className="editor-export">
      {state.phase === "done" && (
        <>
          <span className="editor-done" role="status">{state.message}</span>
          <Button id="editor-reveal" variant="outline" size="sm" onClick={() => void model.revealExport()}>
            <FolderOpen />
            {model.text(model.platform() === "darwin" ? "Show in Finder" : "Open folder")}
          </Button>
        </>
      )}
      {state.phase === "failed" && <span className="editor-failure" role="alert">{state.message}</span>}
      <ControlTooltip label={editor.blocked ?? model.text("Write the kept parts to a new file beside the recording")}>
        <Button
          id="editor-export"
          size="sm"
          // Not while a change is being saved: the export takes the edit as saved.
          aria-disabled={!editor.exportable || model.editorSaving}
          onClick={() => {
            if (editor.exportable && !model.editorSaving) void model.exportEdit();
          }}
        >
          <Upload />
          {model.text(state.phase === "failed" || state.phase === "done" ? "Export again" : "Export")}
        </Button>
      </ControlTooltip>
    </span>
  );
}
