/**
 * The edit view (plan 085): a recording's player above a timeline of its parts. A part is selected by clicking it, split
 * at the playhead (S) and removed or kept again (Delete); Undo (⌘Z / Ctrl+Z) takes the last change back and Redo
 * (⇧⌘Z / Ctrl+Shift+Z or Ctrl+Y) makes it again. The preview plays only what is kept, over a strip of the recording's
 * pictures. Export writes a new file beside the recording, which stays as it is.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronLeft, ChevronRight, FolderOpen, Keyboard, Redo2, RotateCcw, ScanEye, Scissors, Trash2, Undo2, Upload, X } from "lucide-react";
import type { LibraryItemView } from "../../../../shared/settings-panel";
import { phrases, translate, type PlainMessageKey } from "../../../../shared/i18n";
import { Button } from "../../../components/ui/button";
import { ControlTooltip } from "../../../components/control-tooltip";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../../components/ui/dialog";
import { Player } from "../../../player/player";
import { Kbd } from "../../../components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
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
  // By the key's place, not its character (2026-10-25): with an input method such as Zhuyin on, S reports no "s".
  const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
  const redo = command && !event.altKey && ((event.shiftKey && key === "z") || (model.platform() !== "darwin" && !event.shiftKey && key === "y"));
  if (redo || (command && !event.shiftKey && !event.altKey && key === "z")) {
    event.preventDefault();
    event.stopPropagation();
    void (redo ? model.redoEdit() : model.undoEdit());
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  // On the timeline, as in other editors: Space plays or pauses, and ← → step a frame (Shift, a second). A part is a
  // button, which Space would otherwise press.
  const onTimeline = target.closest(".editor-trimmer") !== null;
  if (onTimeline && event.key === " ") {
    event.preventDefault();
    model.togglePlayback();
    return;
  }
  if (onTimeline && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    model.stepPlayhead((event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 0 : 1), event.shiftKey ? (event.key === "ArrowLeft" ? -1 : 1) : 0);
    return;
  }
  if (key === "s") {
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
        // As wide as the window allows with the panel under a 16:9 picture: the timeline, its ruler and hint, the actions,
        // and an editable recording's camera and sound controls, which need more of the height (known from the card before
        // the view arrives, so the dialog does not change its size as it opens).
        className={`editor flex ${editor?.editable ?? item?.editable ? "w-[min(calc(100vw-48px),calc((100dvh-330px)*16/9))]" : "w-[min(calc(100vw-48px),calc((100dvh-270px)*16/9))]"} max-h-[calc(100dvh-72px)] max-w-none flex-col gap-0 overflow-y-auto rounded-[14px] p-0 shadow-player ring-0 sm:max-w-none darwin:top-[calc(50%+24px)]`}
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

/** The ruler's step: the first that puts no more than eight marks along the recording. */
const RULER_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
function rulerMarks(seconds: number): { step: number; marks: number[] } {
  const step = RULER_STEPS.find((candidate) => seconds / candidate <= 8) ?? RULER_STEPS[RULER_STEPS.length - 1]!;
  const marks: number[] = [];
  for (let mark = 0; mark < seconds - step / 4; mark += step) marks.push(+mark.toFixed(3));
  return { step, marks };
}
/** A ruler mark's time: whole seconds as m:ss, tenths only while the step needs them. */
function rulerTime(seconds: number, step: number): string {
  if (step < 1) return model.clock(seconds);
  const whole = Math.round(seconds), hours = Math.floor(whole / 3600), minutes = Math.floor((whole % 3600) / 60), rest = whole % 60;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}` : `${minutes}:${String(rest).padStart(2, "0")}`;
}

/** A time to the hundredth, m:ss.ss: fine enough that a frame's step shows. */
function precise(seconds: number): string {
  const hundredths = Math.max(0, Math.round(seconds * 100));
  const minutes = Math.floor(hundredths / 6000), rest = (hundredths % 6000) / 100;
  return `${minutes}:${rest.toFixed(2).padStart(5, "0")}`;
}

/** What a press on the timeline turned into: a click until it moves, a range once it does, or the playhead dragged. */
interface TimelineGesture {
  pointer: number; startX: number; start: number; mode: "click" | "range" | "scrub" | model.TrimEdge;
  /** For a trim handle: how far from its edge it was taken hold of, in the video's timescale, kept while it moves. */
  offset?: number;
}
/** A trim handle's width, and how far beyond it a press still takes hold of it, in CSS pixels. */
const TRIM_HANDLE = 12;
const TRIM_REACH = 10;

function EditorPanel() {
  const editor = model.editorView();
  const time = usePlayhead();
  const gesture = useRef<TimelineGesture | null>(null);
  /** The track of pictures and parts, whose width the recording's time spans; the handles stand outside it. */
  const track = useRef<HTMLDivElement | null>(null);
  /** The trim handle with the keyboard's focus, whose edge the times' row keeps saying. */
  const [focusedEdge, setFocusedEdge] = useState<model.TrimEdge | undefined>(undefined);
  // However a press ends, the gesture does: a release anywhere in the window, or the window losing the pointer.
  useEffect(() => {
    const end = (): void => {
      const held = gesture.current;
      if (!held) return;
      gesture.current = null;
      if (held.mode === "start" || held.mode === "end") void model.commitTrim();
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("blur", end);
    };
  }, []);
  // A change can take the focused part away (an Undo merging it, a removal joining it to its neighbour): focus then
  // falls to the page or behind the dialog (a tab, in CI), and the edit view's keys stop (2026-10-25, a hands-on round).
  // It goes back to the selected part, or the timeline.
  useEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body && active.closest("#editor, #editor-keys-popup")) return;
    const target = document.querySelector<HTMLElement>("#editor .editor-part[aria-pressed='true']") ?? document.querySelector<HTMLElement>("#editor .editor-timeline");
    target?.focus({ preventScroll: true });
  });
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
  // 2026-10-25, after a hands-on walkthrough: a click on the timeline puts the playhead there and selects the part
  // there; a drag across it chooses a range Remove takes out; a drag that starts on the playhead scrubs; and the handles
  // at either end trim the recording's start and end. Split stays for cutting the timeline into parts by hand.
  /** The recording's time under `clientX`, kept within it unless `free` (a handle's grip may lie beyond the track). */
  const ticksAt = (clientX: number, free = false): number | undefined => {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return undefined;
    const fraction = (clientX - box.left) / box.width;
    return Math.round((free ? fraction : Math.min(1, Math.max(0, fraction))) * editor.duration);
  };
  const placeAt = (ticks: number): void => {
    const part = model.partAt(parts, ticks);
    if (part) model.selectPart(part, false);
    model.seekTo(ticks / editor.timescale);
  };
  const follow = (pointer: number, clientX: number): void => {
    const held = gesture.current, ticks = ticksAt(clientX, held?.mode === "start" || held?.mode === "end");
    if (!held || held.pointer !== pointer || ticks === undefined) return;
    if (held.mode === "click" && Math.abs(clientX - held.startX) > 4) held.mode = "range";
    if (held.mode === "scrub") placeAt(ticks);
    else if (held.mode === "range") {
      // The preview follows the end being dragged, so the cut is chosen by its picture (2026-10-25).
      model.selectRange(held.start, ticks);
      model.editorVideo?.pause();
      model.seekTo(ticks / editor.timescale);
    }
    // The edge keeps its distance from the pointer: taken hold of in the middle of the bar, it does not jump there.
    else if (held.mode === "start" || held.mode === "end") model.moveTrim(held.mode, ticks - (held.offset ?? 0));
  };
  const mac = model.platform() === "darwin";
  const shortcuts: Array<[string, PlainMessageKey]> = [
    [model.text("Space"), "Play or pause"], ["← →", "Move a frame"], ["Shift ← →", "Move a second"], ["S", "Split"],
    ["Delete", "Remove the selection"], [mac ? "⌘Z" : "Ctrl+Z", "Undo"], [mac ? "⇧⌘Z" : "Ctrl+Y", "Redo"],
    ["← →", "On a trim handle: move its edge a frame, Shift a second"],
  ];
  const keys = translate("Space play or pause · ← → a frame, Shift+← → a second · S split · Delete remove · {undo} undo · {redo} redo · on a trim handle, ← → move its edge", language, {
    undo: model.platform() === "darwin" ? "⌘Z" : "Ctrl+Z",
    redo: model.platform() === "darwin" ? "⇧⌘Z" : "Ctrl+Y",
  });
  const trim = model.shownTrim(editor);
  // While a handle moves, the times' row says where the export will start or end, to the hundredth.
  const trimming = model.trimming() ?? focusedEdge;
  const range = model.rangeSelection;
  const ruler = rulerMarks(editor.seconds);
  const trimHandle = (edge: model.TrimEdge) => {
    const value = trim[edge];
    const step = (event: React.KeyboardEvent): number | undefined => {
      // A frame, or a second with Shift, as ← → move the playhead on the timeline.
      const by = event.shiftKey ? editor.timescale : editor.timescale / Math.max(1, editor.frameRate);
      if (event.key === "ArrowLeft" || event.key === "ArrowDown") return value - by;
      if (event.key === "ArrowRight" || event.key === "ArrowUp") return value + by;
      if (event.key === "Home") return 0;
      if (event.key === "End") return editor.duration;
      return undefined;
    };
    return (
      <span
        key={edge}
        id={`editor-trim-${edge}`}
        className="editor-trim"
        data-edge={edge}
        role="slider"
        tabIndex={0}
        aria-label={model.text(edge === "start" ? "Start of the export" : "End of the export")}
        aria-valuemin={0}
        aria-valuemax={+editor.seconds.toFixed(1)}
        aria-valuenow={+(value / editor.timescale).toFixed(2)}
        aria-valuetext={precise(value / editor.timescale)}
        aria-disabled={busy || undefined}
        style={{ "--at": value / editor.duration } as React.CSSProperties}
        // The timeline's own press takes hold of it (2026-10-25: a handle following the pointer by itself did not move
        // under a real pointer in a hands-on round, where the timeline's drags did).
        onKeyDown={(event) => {
          const next = step(event);
          if (next === undefined || editor.export.phase === "exporting") return;
          event.preventDefault();
          event.stopPropagation();
          model.moveTrim(edge, next);
        }}
        onKeyUp={(event) => { if (step(event) !== undefined) void model.commitTrim(); }}
        onFocus={() => setFocusedEdge(edge)}
        onBlur={() => {
          setFocusedEdge(undefined);
          void model.commitTrim();
        }}
      >
        {edge === "start" ? <ChevronLeft aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
      </span>
    );
  };
  return (
    <div className="editor-panel">
      {/* The trimmer, as iPhone's and QuickTime's: the handles stand outside the kept recording with ‹ ›, lines join them
          above and below, and the track pads its sides so a handle at the very start or end is seen whole (2026-10-25). */}
      <div
        className="editor-trimmer"
        onPointerDown={(event) => {
          const ticks = ticksAt(event.clientX);
          const box = track.current?.getBoundingClientRect();
          if (busy || event.button !== 0 || ticks === undefined || !box) return;
          model.keepSkimmed();
          event.currentTarget.setPointerCapture(event.pointerId);
          const xOf = (at: number): number => box.left + (at / editor.duration) * box.width;
          // A trim handle, pressed or pressed beside: the start's reaches in from its edge, the end's back from its.
          const handle = (event.target as HTMLElement).closest?.(".editor-trim")?.getAttribute("data-edge");
          const edge: model.TrimEdge | undefined = handle === "start" || handle === "end" ? handle
            : event.clientX >= xOf(trim.start) - TRIM_HANDLE - TRIM_REACH && event.clientX <= xOf(trim.start) + TRIM_REACH ? "start"
            : event.clientX <= xOf(trim.end) + TRIM_HANDLE + TRIM_REACH && event.clientX >= xOf(trim.end) - TRIM_REACH ? "end" : undefined;
          if (edge) {
            gesture.current = { pointer: event.pointerId, startX: event.clientX, start: ticks, mode: edge, offset: (ticksAt(event.clientX, true) ?? ticks) - trim[edge] };
            document.getElementById(`editor-trim-${edge}`)?.focus({ preventScroll: true });
            model.moveTrim(edge, trim[edge]);
            return;
          }
          const now = model.editorVideo?.currentTime ?? time;
          const playheadX = box.left + Math.min(1, now / Math.max(editor.seconds, 0.001)) * box.width;
          const onPlayhead = Math.abs(event.clientX - playheadX) <= 6;
          gesture.current = { pointer: event.pointerId, startX: event.clientX, start: ticks, mode: onPlayhead ? "scrub" : "click" };
          if (onPlayhead) placeAt(ticks);
        }}
        onPointerMove={(event) => {
          if (gesture.current) follow(event.pointerId, event.clientX);
          else if (model.skimming && event.pointerType === "mouse") {
            const ticks = ticksAt(event.clientX);
            if (ticks !== undefined) model.skimTo(ticks);
          }
        }}
        onPointerLeave={() => { if (!gesture.current) model.endSkim(); }}
        // Where it is let go too: a drag whose moves did not come (a jump of the pointer) still ends there.
        onPointerUp={(event) => {
          follow(event.pointerId, event.clientX);
          const held = gesture.current, ticks = ticksAt(event.clientX);
          if (held?.pointer === event.pointerId && held.mode === "click" && ticks !== undefined) placeAt(ticks);
          if (held?.pointer === event.pointerId && (held.mode === "start" || held.mode === "end")) void model.commitTrim();
          gesture.current = null;
        }}
        onPointerCancel={() => {
          if (gesture.current?.mode === "start" || gesture.current?.mode === "end") void model.commitTrim();
          gesture.current = null;
        }}
        // Let go outside the window, the press ends with no release here (a hands-on round, on a display the dialog
        // filled): a handle so dragged stayed drawn where it was and never saved. The lost hold ends it as a release does.
        onLostPointerCapture={(event) => {
          const held = gesture.current;
          if (held?.pointer !== event.pointerId) return;
          if (held.mode === "start" || held.mode === "end") void model.commitTrim();
          gesture.current = null;
        }}
      >
        <div ref={track} className="editor-timeline" role="group" tabIndex={-1} aria-label={model.text("Timeline")}>
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
              // The pointer's press already chose the place; Enter or Space selects the part from its start.
              onClick={(event) => { if (event.detail === 0) model.selectPart(part); }}
            />
          );
        })}
        {editor.notes.map((note) => (
          <span key={note.at} className="editor-note-mark" style={{ left: `${(note.at / editor.seconds) * 100}%` }} aria-hidden="true" />
        ))}
        {range && <span className="editor-range" style={{ left: percent(range[0]), width: percent(range[1] - range[0]) }} aria-hidden="true" />}
        {model.skimAt !== undefined && <span className="editor-skimmer" style={{ left: percent(model.skimAt) }} aria-hidden="true" />}
        <span className="editor-playhead" style={{ left: `${Math.min(100, (time / Math.max(editor.seconds, 0.001)) * 100)}%` }} aria-hidden="true" />
        </div>
        <span className="editor-trim-frame" style={{ "--from": trim.start / editor.duration, "--to": trim.end / editor.duration } as React.CSSProperties} aria-hidden="true" />
        {trimHandle("start")}
        {trimHandle("end")}
        {/* While a handle is dragged, its time above it, where the eye is (2026-10-25). */}
        {model.trimming() && (
          <span className="editor-trim-time" style={{ "--at": trim[model.trimming()!] / editor.duration } as React.CSSProperties} aria-hidden="true">
            {precise(trim[model.trimming()!] / editor.timescale)}
          </span>
        )}
      </div>
      <div className="editor-ruler" aria-hidden="true">
        {ruler.marks.map((mark) => (
          <span key={mark} style={{ left: `${(mark / Math.max(editor.seconds, 0.001)) * 100}%` }}>{rulerTime(mark, ruler.step)}</span>
        ))}
        <i className="editor-ruler-playhead" style={{ left: `${Math.min(100, (time / Math.max(editor.seconds, 0.001)) * 100)}%` }} />
      </div>
      {/* A row of its own for the times (2026-10-25): a range's longer readout among the buttons pushed Export onto a
          new row and moved the picture. The playhead's time is to the hundredth, so a frame's step shows (the player's
          own clock shows whole seconds); a range being chosen shows where it runs and how long it is instead. */}
      <div className="editor-status text-muted-foreground">
        <span className="editor-position">
          {trimming
            ? translate(trimming === "start" ? "The export starts at {time}" : "The export ends at {time}", language, { time: precise(trim[trimming] / editor.timescale) })
            : range
            ? translate("Selection {from}–{to} ({length})", language, {
              from: precise(range[0] / editor.timescale), to: precise(range[1] / editor.timescale), length: precise((range[1] - range[0]) / editor.timescale),
            })
            : translate("Playhead {time}", language, { time: precise(time) })}
        </span>
        <span className="editor-length">
          {/* To the hundredth, as the times beside it (a hands-on round). */}
          {translate("Export length {length}", language, { length: precise(editor.outputSeconds) })}
        </span>
      </div>
      {/* How to cut, kept in sight since the gestures cannot be seen until they are tried, and the keys behind a button
          beside it: listed in full they took three lines of a small window. */}
      <div className="editor-hint">
        {/* An export's outcome takes the hint's place, one line, so nothing below moves (2026-10-25: a row of its own
            appeared under the buttons and pushed the camera and sound down). */}
        {editor.export.phase === "done" ? (
          <span className="editor-done" role="status" title={editor.export.message}>{editor.export.message}</span>
        ) : editor.export.phase === "failed" ? (
          <span className="editor-failure" role="alert">{editor.export.message}</span>
        ) : (
          <span>{model.text("Drag the ends to trim, or across the timeline to choose a range.")}</span>
        )}
        {/* The keys, opened by a click as well as named to assistive technology (a hands-on round found a tooltip alone
            showed nothing on a click). */}
        <Popover>
          <PopoverTrigger render={<Button variant="ghost" size="sm" />} id="editor-keys" className="editor-keys" aria-label={`${model.text("Keyboard shortcuts")}: ${keys}`}>
            <Keyboard />
            {model.text("Keyboard shortcuts")}
          </PopoverTrigger>
          <PopoverContent side="top" align="end" id="editor-keys-popup" className="editor-keys-popup" finalFocus={false}>
            <p className="editor-keys-title">{model.text("Editing shortcuts")}</p>
            <dl>
              {shortcuts.map(([key, action]) => (
                <div key={action}>
                  <dt><Kbd>{key}</Kbd></dt>
                  <dd>{model.text(action)}</dd>
                </div>
              ))}
            </dl>
          </PopoverContent>
        </Popover>
      </div>
      <div className="editor-actions">
        <ControlTooltip label={model.text(range ? "Remove the selected range (Delete)" : removing ? "Remove the selected part (Delete)" : "Keep the selected part (Delete)")}>
          <Button id="editor-remove" variant="outline" size="sm" aria-disabled={busy || (!selected && !range)} onClick={() => { if (!busy && (selected || range)) void model.toggleSelected(); }}>
            {range || removing || !selected ? <Trash2 /> : <RotateCcw />}
            {/* As wide as its widest name, so the buttons after it stay put as its name changes (a hands-on round). */}
            <span className="editor-swap">
              {(["Remove selection", "Remove part", "Keep part"] as const).map((name) => (
                <span key={name} data-shown={name === (range ? "Remove selection" : removing || !selected ? "Remove part" : "Keep part") || undefined}>{model.text(name)}</span>
              ))}
            </span>
          </Button>
        </ControlTooltip>
        <ControlTooltip label={model.text("Split at the playhead (S)")}>
          <Button id="editor-split" variant="outline" size="sm" aria-disabled={busy} onClick={() => { if (!busy) model.splitAtPlayhead(); }}>
            <Scissors />
            {model.text("Split")}
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
        {/* Its state is written beside its name (2026-10-25): a filled button alone read as a hover. */}
        <ControlTooltip label={model.text("Move over the timeline to preview; moving away returns to the playhead, and a click sets it.")}>
          <Button id="editor-skim" variant="outline" size="sm" className="editor-skim" aria-pressed={model.skimming} onClick={() => model.toggleSkimming()}>
            <ScanEye />
            {model.text("Skimming")}
            <span className="editor-skim-state" aria-hidden="true">{model.text(model.skimming ? "On" : "Off")}</span>
          </Button>
        </ControlTooltip>
        <span className="editor-spacer" />
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
  // One width in every state (min-width in ui.css), its outcome written in the hint's row: the buttons beside it and the
  // rows under it stay where they are as an export starts, runs and ends (2026-10-25).
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
  const again = state.phase === "failed" || state.phase === "done";
  return (
    <span className="editor-export">
      {state.phase === "done" && (
        // Once exported, finding the file is what comes next: the main button, Export again beside it as an icon.
        <Button id="editor-reveal" size="sm" onClick={() => void model.revealExport()}>
          <FolderOpen />
          {model.text(model.platform() === "darwin" ? "Show in Finder" : "Open folder")}
        </Button>
      )}
      <ControlTooltip label={editor.blocked ?? model.text(state.phase === "done" ? "Export again" : editor.editable ? "Write the recording with the camera and sound set here to a new file beside it" : "Write the kept parts to a new file beside the recording")}>
        <Button
          id="editor-export"
          size={state.phase === "done" ? "icon-sm" : "sm"}
          variant={state.phase === "done" ? "outline" : "default"}
          // Not while a change is being saved: the export takes the edit as saved.
          aria-disabled={!editor.exportable || model.editorSaving}
          onClick={() => {
            if (editor.exportable && !model.editorSaving) void model.exportEdit();
          }}
        >
          {state.phase === "done" ? <RotateCcw /> : <Upload />}
          <span className={state.phase === "done" ? "sr-only" : undefined}>{model.text(again ? "Export again" : "Export")}</span>
        </Button>
      </ControlTooltip>
    </span>
  );
}
