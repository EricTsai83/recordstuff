/**
 * The edit view (plan 085): a recording's player above a timeline of its parts. A part is selected by clicking it, split
 * at the playhead (S) and removed or kept again (Delete); Undo (⌘Z / Ctrl+Z) takes the last change back and Redo
 * (⇧⌘Z / Ctrl+Shift+Z or Ctrl+Y) makes it again. The preview plays only what is kept, over a strip of the recording's
 * pictures. Export writes a new file beside the recording, which stays as it is.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FolderOpen, Redo2, RotateCcw, Scissors, Trash2, Undo2, Upload, X } from "lucide-react";
import type { LibraryItemView } from "../../../../shared/settings-panel";
import { phrases, translate } from "../../../../shared/i18n";
import { Button } from "../../../components/ui/button";
import { ControlTooltip } from "../../../components/control-tooltip";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../../components/ui/dialog";
import { Player } from "../../../player/player";
import * as model from "../../settings-controller";
import { EditorCamera, EditorSceneControls } from "./editor-scene";

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

/** Resolves once `media` fires `event`, or rejects after `ms`: a picture the strip waits for never holds it up for long. */
function once(media: HTMLMediaElement, event: string, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (): void => { clearTimeout(timer); media.removeEventListener(event, done); resolve(); };
    const timer = setTimeout(() => { media.removeEventListener(event, done); reject(new Error(`no ${event}`)); }, ms);
    media.addEventListener(event, done);
  });
}

/**
 * The recording's pictures along the timeline (2026-10-25, at the maintainer's request): one frame per tile, as many
 * tiles as fit the timeline's width at its height, read by a hidden video of its own one seek at a time, so a long
 * recording costs a few dozen decodes, once per view. The parts are drawn over it.
 */
function TimelineStrip({ source }: { source: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = canvas.current;
    const context = target?.getContext?.("2d");
    if (!target || !context || target.clientWidth === 0) return;
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    let stopped = false;
    void (async () => {
      const loaded = once(video, "loadedmetadata");
      video.src = source;
      await loaded;
      const ratio = window.devicePixelRatio || 1;
      const width = target.clientWidth, height = target.clientHeight;
      target.width = Math.round(width * ratio);
      target.height = Math.round(height * ratio);
      const tile = video.videoHeight > 0 ? height * video.videoWidth / video.videoHeight : height;
      const count = Math.max(1, Math.ceil(width / tile));
      for (let index = 0; index < count && !stopped; index++) {
        const seeked = once(video, "seeked");
        video.currentTime = ((index + 0.5) / count) * video.duration;
        await seeked;
        if (stopped) return;
        context.drawImage(video, index * tile * ratio, 0, tile * ratio, height * ratio);
      }
    })().catch(() => undefined);
    return () => {
      stopped = true;
      video.removeAttribute("src");
      video.load();
    };
  }, [source]);
  return <canvas ref={canvas} className="editor-strip" aria-hidden="true" />;
}

/** Keys of the edit view that are not the player's: Split, Remove or keep, Undo, Redo. */
function editorKey(event: React.KeyboardEvent): void {
  const target = event.target as HTMLElement;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  const command = model.platform() === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  const key = event.key.toLowerCase();
  const redo = command && !event.altKey && ((event.shiftKey && key === "z") || (model.platform() !== "darwin" && !event.shiftKey && key === "y"));
  if (redo || (command && !event.shiftKey && !event.altKey && key === "z")) {
    event.preventDefault();
    event.stopPropagation();
    void (redo ? model.redoEdit() : model.undoEdit());
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
  // Every view drawn: an editable recording's gains at its scene, any other recording's at unity (plan 087).
  useEffect(() => model.syncPreviewAudio());
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
              // Its sound goes through Web Audio at an editable recording's volumes (plan 087), which needs CORS.
              crossOrigin="anonymous"
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
          {item && editor?.state === "ready" && editor.editable && <EditorCamera editor={editor} />}
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
  // Unavailable while a change saves or an export runs, but still focusable (aria-disabled): a control disabled under
  // the keyboard's focus would drop it, and the edit view's shortcuts with it (2026-10-25).
  const busy = model.editorSaving || editor.export.phase === "exporting";
  const percent = (ticks: number): string => `${(ticks / editor.duration) * 100}%`;
  const at = (seconds: number): string => model.clock(seconds);
  const removing = selected && !selected.removed;
  const editingSource = model.editingItem?.video;
  return (
    <div className="editor-panel">
      <div className="editor-timeline" role="group" aria-label={model.text("Timeline")}>
        {editingSource && <TimelineStrip source={editingSource} />}
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
          <Button id="editor-split" variant="outline" size="sm" aria-disabled={busy} onClick={() => { if (!busy) model.splitAtPlayhead(); }}>
            <Scissors />
            {model.text("Split")}
          </Button>
        </ControlTooltip>
        <ControlTooltip label={model.text(removing ? "Remove the selected part (Delete)" : "Keep the selected part (Delete)")}>
          <Button id="editor-remove" variant="outline" size="sm" aria-disabled={busy || !selected} onClick={() => { if (!busy && selected) void model.toggleSelected(); }}>
            {removing || !selected ? <Trash2 /> : <RotateCcw />}
            {model.text(removing || !selected ? "Remove part" : "Keep part")}
          </Button>
        </ControlTooltip>
        <ControlTooltip label={model.text(model.platform() === "darwin" ? "Undo (⌘Z)" : "Undo (Ctrl+Z)")}>
          <Button id="editor-undo" variant="outline" size="sm" aria-disabled={busy || !model.canUndo()} onClick={() => void model.undoEdit()}>
            <Undo2 />
            {model.text("Undo")}
          </Button>
        </ControlTooltip>
        <ControlTooltip label={model.text(model.platform() === "darwin" ? "Redo (⇧⌘Z)" : "Redo (Ctrl+Y)")}>
          <Button id="editor-redo" variant="outline" size="sm" aria-disabled={busy || !model.canRedo()} onClick={() => void model.redoEdit()}>
            <Redo2 />
            {model.text("Redo")}
          </Button>
        </ControlTooltip>
        <span className="editor-spacer" />
        <span className="editor-length text-muted-foreground">
          {translate("Export length {length}", language, { length: at(editor.outputSeconds) })}
        </span>
        <ExportControls />
      </div>
      <EditorSceneControls editor={editor} />
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
          {/* Once exported, finding the file is what comes next: the main button, Export again beside it. */}
          <Button id="editor-reveal" size="sm" onClick={() => void model.revealExport()}>
            <FolderOpen />
            {model.text(model.platform() === "darwin" ? "Show in Finder" : "Open folder")}
          </Button>
        </>
      )}
      {state.phase === "failed" && <span className="editor-failure" role="alert">{state.message}</span>}
      <ControlTooltip label={editor.blocked ?? model.text(editor.editable ? "Write the recording with the camera and sound set here to a new file beside it" : "Write the kept parts to a new file beside the recording")}>
        <Button
          id="editor-export"
          size="sm"
          variant={state.phase === "done" ? "outline" : "default"}
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
