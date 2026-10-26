/**
 * The edit view (plan 085): a recording's player above a timeline of its parts. A part is selected by clicking it, split
 * at the playhead (S) and removed or kept again (Delete); Undo (⌘Z / Ctrl+Z) takes the last change back and Redo
 * (⇧⌘Z / Ctrl+Shift+Z or Ctrl+Y) makes it again. The preview plays only what is kept, over a strip of the recording's
 * pictures. Export writes a new file beside the recording, which stays as it is.
 *
 * An editable recording with a camera (2026-10-26, the maintainer's request) has a lane under the pictures that shows
 * where the camera is in the picture and where it is hidden; the camera button (C) hides it over the selected range or
 * part, or shows it there again, and a click on the lane selects one of its stretches. Each sound input has a lane too
 * (2026-10-26): its own volume, or a stretch's (muted, or a percent), set over the selection by the Volume popup (V).
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronLeft, ChevronRight, Keyboard, Mic, MicOff, Pause, Play, Redo2, RotateCcw, Scissors, Trash2, Undo2, Upload, UserRound, UserRoundX, Volume2, VolumeX, X } from "lucide-react";
import { toast } from "sonner";
import type { LibraryItemView } from "../../../../shared/settings-panel";
import type { VolumeInput } from "../../../../shared/editable";
import { phrases, translate, type PlainMessageKey } from "../../../../shared/i18n";
import { Button } from "../../../components/ui/button";
import { ControlTooltip } from "../../../components/control-tooltip";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../../components/ui/dialog";
import { Player } from "../../../player/player";
import { Kbd } from "../../../components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { Toaster } from "../../../components/ui/sonner";
import * as model from "../../settings-controller";
import { EditorCamera, EditorOptions, VolumeButton } from "./editor-scene";

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

/** Whether the preview plays, for the toolbar's Play and Pause. */
function usePlaying(): boolean {
  const video = model.editorVideo;
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!video) return;
    const show = (): void => setPlaying(!video.paused);
    show();
    for (const name of ["play", "pause", "ended", "emptied"]) video.addEventListener(name, show);
    return () => { for (const name of ["play", "pause", "ended", "emptied"]) video.removeEventListener(name, show); };
  }, [video]);
  return playing;
}

/** The export's toasts' own Sonner list, drawn inside the edit view: the page's sits under the dialog. */
const EXPORT_TOASTER = "editor-export";

/**
 * Says an export's outcome once it ends (2026-10-26, in place of words and buttons in the toolbar, the maintainer's
 * choice): a toast over the edit view whose Play opens the new file in the player, or one saying why it failed. Only the
 * export this view asked for is said (the controller's `exportWatched`), so reopening the view says nothing again, and a
 * start that failed before it ran is said too.
 */
function useExportToast(): void {
  const editor = model.editorView();
  const outcome = editor?.export;
  const watched = editor !== undefined && model.exportWatched === editor.id;
  useEffect(() => {
    if (!editor || !outcome || !watched || (outcome.phase !== "done" && outcome.phase !== "failed")) return;
    model.exportSaid();
    const id = `${EXPORT_TOASTER}-${editor.id}`;
    if (outcome.phase === "done") {
      const name = outcome.name;
      toast(translate("Exported “{title}”", model.view?.language, { title: name.replace(/\.mp4$/i, "") }), {
        toasterId: EXPORT_TOASTER,
        id,
        description: model.text("Saved in the recording's folder."),
        duration: 8000,
        className: "undo-toast editor-export-toast",
        classNames: { title: "toast-title", description: "toast-description", actionButton: "toast-action" },
        action: { label: model.text("Play"), onClick: () => void model.playExport(name, editor.id) },
      });
    } else {
      toast(model.text("The export failed"), {
        toasterId: EXPORT_TOASTER,
        id,
        description: outcome.message,
        duration: 12000,
        className: "undo-toast editor-export-toast",
        classNames: { title: "toast-title", description: "toast-description" },
      });
    }
    model.announce(outcome.message);
  }, [outcome, watched, editor]);
  // The view closing takes its toast with it; the page's own toasts (the Trash's) are left alone.
  const open = Boolean(model.editingItem);
  const shown = useRef<string | undefined>(undefined);
  if (editor) shown.current = `${EXPORT_TOASTER}-${editor.id}`;
  useEffect(() => { if (!open && shown.current) toast.dismiss(shown.current); }, [open]);
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
    void model.splitAtPlayhead();
  } else if (key === "c" && target.closest(".editor-panel, .editor-stage")) {
    event.preventDefault();
    void model.toggleCameraInSelection();
  } else if (key === "v" && target.closest(".editor-panel, .editor-stage")) {
    event.preventDefault();
    model.openVolume();
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
  useExportToast();
  return (
    <Dialog
      open={Boolean(model.editingItem)}
      onOpenChange={(open, details) => {
        // Escape never closes it (2026-10-26): it lets go of a selection instead. An open popup inside takes it first.
        if (open) return;
        if (details.reason === "escape-key") model.escapeEditor();
        else void model.closeEditor();
      }}
    >
      <DialogContent
        keepMounted
        id="editor"
        overlayClassName="bg-media-backdrop supports-backdrop-filter:backdrop-blur-none"
        // The whole window but its margins, as the player's (2026-10-25, at the maintainer's request: a picture sized
        // to 16:9 over the panel left wide bands of the page either side): the panel at the foot, the stage taking the
        // rest of the height, the picture contained in it. A window too short for both scrolls.
        className="editor flex h-[calc(100dvh-2*var(--dialog-margin)-var(--dialog-top-reserve))] w-[calc(100vw-2*var(--dialog-margin))] max-w-none flex-col gap-0 overflow-y-auto rounded-[14px] p-0 shadow-player ring-0 sm:max-w-none top-[calc(50%+var(--dialog-top-reserve)/2)]"
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
          {/* An editable recording's camera too (Codex's computer-use round, 2026-10-26). */}
          {editor?.editable?.camera ? ` ${model.text("Select a stretch of the timeline, then press C to hide or show the camera there.")}` : ""}
        </DialogDescription>
        <div className="editor-stage bg-media text-media-foreground">
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
              controls={false}
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
                    onClick={() => void model.closeEditor()}
                  >
                    <X />
                  </Button>
                </ControlTooltip>
              }
            />
          )}
          {item && editor?.state === "ready" && editor.editable && <EditorCamera editor={editor} />}
          {/* Over the stage's foot, inside the dialog, so the dialog neither covers it nor takes its clicks as outside.
              Only while the view is open: a second Sonner list drawn the rest of the time held the page's Trash toast
              open after the pointer left it. */}
          {model.editingItem && <Toaster id={EXPORT_TOASTER} hotkey={[]} position="bottom-right" visibleToasts={1} offset={12} />}
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
  /** Pressed on a lane (the camera's or an input's): a click there selects the lane's stretch rather than the part. */
  lane?: "camera" | VolumeInput | undefined;
  /** For a trim handle: how far from its edge it was taken hold of, in the video's timescale, kept while it moves. */
  offset?: number;
}
/** A trim handle's width, and how far beyond it a press still takes hold of it, in CSS pixels. */
const TRIM_HANDLE = 12;
const TRIM_REACH = 10;

function EditorPanel() {
  const editor = model.editorView();
  const time = usePlayhead();
  const playing = usePlaying();
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
    // The Volume popup too (Codex's computer-use round, 2026-10-26: its slider lost the focus at every save, and the
    // next arrow key moved the playhead).
    if (active && active !== document.body && active.closest("#editor, #editor-keys-popup, #editor-options-popup, #editor-volume-popup")) return;
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
          <Button id="editor-done" variant="outline" onClick={() => void model.closeEditor()}>{model.text("Close")}</Button>
        </div>
      </div>
    );
  }
  const parts = model.timelineParts(editor);
  const selected = model.selectedPart(editor);
  // Unavailable only while an export runs (2026-10-26, the maintainer's report: a save, a few tens of milliseconds,
  // dimmed the trim handles, the parts and the toolbar each time, a flicker at every change); a change pressed while
  // another saves waits its turn in the controller. Still focusable (aria-disabled) where it can be.
  const busy = editor.export.phase === "exporting";
  const percent = (ticks: number): string => `${(ticks / editor.duration) * 100}%`;
  const at = (seconds: number): string => model.clock(seconds);
  const removing = selected && !selected.removed;
  // An editable recording's camera, hidden or shown over the selection (2026-10-26).
  const camera = model.hasCamera(editor);
  const cameraTarget = camera ? model.cameraTarget(editor) : undefined;
  const showingCamera = cameraTarget !== undefined && model.cameraHiddenOver(editor, cameraTarget);
  // Hidden throughout in Options: the stretches wait, and so does the button.
  const allHidden = camera && model.cameraHiddenThroughout(editor);
  const stretches = camera ? model.cameraStretches(editor) : [];
  // An editable recording's sound inputs, each with a lane of its volume (2026-10-26).
  const inputs = editor.editable ? model.volumeInputs(editor) : [];
  // The lanes shown: Options hides any of them (2026-10-26); what a hidden one holds is still exported.
  const cameraLane = camera && model.laneShown("camera");
  const inputLanes = inputs.filter((input) => model.laneShown(input));
  const lanes = (cameraLane ? 1 : 0) + inputLanes.length;
  /** A lane's stretches, as a click there chooses one. */
  /** A lane's stretches, as a click there chooses one; `set` for one the edit set (hidden, or a volume of its own). */
  const laneStretches = (lane: "camera" | VolumeInput): Array<{ from: number; to: number; set: boolean }> => (lane === "camera"
    ? stretches.map((one) => ({ ...one, set: one.hidden }))
    : model.volumeLane(editor, lane).map((one) => ({ ...one, set: one.volume !== undefined })));
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
    ...(camera ? [["C", "Hide or show the camera in the selection"] as [string, PlainMessageKey]] : []),
    ...(inputs.length > 0 ? [["V", "Set the volume of the selection"] as [string, PlainMessageKey]] : []),
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
      {/* One row over the timeline (2026-10-25, the maintainer's choice of layouts, to simplify the view and give the
          picture more of the height): Play, as the picture has no controls of its own (2026-10-26); the edits; the
          options behind one named button (editor-scene.tsx); where the playhead is and how long the export runs; the
          keys against Export. An export's outcome is a toast (useExportToast), so nothing in the row moves. The playhead's
          time is to the hundredth, so a frame's step shows; a range being chosen or an edge being trimmed shows that instead. */}
      <div className="editor-toolbar">
        <ControlTooltip label={`${model.text(playing ? "Pause" : "Play")} (${model.text("Space")})`}>
          <Button id="editor-play" variant="ghost" size="icon" aria-label={model.text(playing ? "Pause" : "Play")} onClick={() => model.togglePlayback()}>
            {playing ? <Pause /> : <Play />}
          </Button>
        </ControlTooltip>
        <span className="editor-divider" aria-hidden="true" />
        <ControlTooltip label={model.text(model.platform() === "darwin" ? "Undo (⌘Z)" : "Undo (Ctrl+Z)")}>
          <Button id="editor-undo" variant="ghost" size="icon" aria-label={model.text("Undo")} aria-disabled={busy || !model.canUndo()} onClick={() => void model.undoEdit()}>
            <Undo2 />
          </Button>
        </ControlTooltip>
        <ControlTooltip label={model.text(model.platform() === "darwin" ? "Redo (⇧⌘Z)" : "Redo (Ctrl+Y)")}>
          <Button id="editor-redo" variant="ghost" size="icon" aria-label={model.text("Redo")} aria-disabled={busy || !model.canRedo()} onClick={() => void model.redoEdit()}>
            <Redo2 />
          </Button>
        </ControlTooltip>
        <span className="editor-divider" aria-hidden="true" />
        <ControlTooltip label={model.text("Split at the playhead (S)")}>
          <Button id="editor-split" variant="ghost" size="icon" aria-label={model.text("Split")} aria-disabled={busy} onClick={() => { if (!busy) void model.splitAtPlayhead(); }}>
            <Scissors />
          </Button>
        </ControlTooltip>
        <ControlTooltip label={model.text(range ? "Remove the selected range (Delete)" : removing ? "Remove the selected part (Delete)" : "Keep the selected part (Delete)")}>
          <Button id="editor-remove" variant="ghost" size="icon" aria-label={model.text(range ? "Remove selection" : removing || !selected ? "Remove part" : "Keep part")} aria-disabled={busy || (!selected && !range)} onClick={() => { if (!busy && (selected || range)) void model.toggleSelected(); }}>
            {range || removing || !selected ? <Trash2 /> : <RotateCcw />}
          </Button>
        </ControlTooltip>
        {camera && (
          <ControlTooltip label={model.text(allHidden ? "Turn off Hide the camera throughout in Options to hide or show it over a stretch." : !cameraTarget ? "Select a part or drag across the timeline, then hide or show the camera there (C)" : showingCamera ? "Show the camera in the selection again (C)" : "Hide the camera in the selection (C)")}>
            {/* Named in words beside its icon (2026-10-26, two computer-use rounds: a person alone read as an account's
                button); both names are as long, so nothing after it moves as it turns. */}
            <Button
              id="editor-camera-toggle"
              variant="ghost"
              size="sm"
              className="editor-camera-toggle"
              aria-label={model.text(showingCamera ? "Show camera in selection" : "Hide camera in selection")}
              aria-disabled={busy || !cameraTarget || allHidden}
              onClick={() => { if (!busy && cameraTarget && !allHidden) void model.toggleCameraInSelection(); }}
            >
              {showingCamera ? <UserRound /> : <UserRoundX />}
              <span className="editor-camera-toggle-label">{model.text(showingCamera ? "Show camera" : "Hide camera")}</span>
            </Button>
          </ControlTooltip>
        )}
        {inputs.length > 0 && <VolumeButton editor={editor} />}
        <EditorOptions editor={editor} />
        <span className="editor-divider" aria-hidden="true" />
        <span className="editor-times text-muted-foreground">
          <span className="editor-position">
            {trimming
              ? translate(trimming === "start" ? "The export starts at {time}" : "The export ends at {time}", language, { time: precise(trim[trimming] / editor.timescale) })
              : range
              ? translate("Selection {from}–{to} ({length})", language, {
                from: precise(range[0] / editor.timescale), to: precise(range[1] / editor.timescale), length: precise((range[1] - range[0]) / editor.timescale),
              })
              : translate("Playhead {time}", language, { time: precise(time) })}
          </span>
          {/* To the hundredth, as the times beside it (a hands-on round); following a trim handle as it is dragged. */}
          <span className="editor-length">{translate("Export length {length}", language, { length: precise(model.shownOutputSeconds(editor)) })}</span>
        </span>
        <span className="editor-spacer" />
        {/* The keys, opened by a click as well as named to assistive technology (a
            hands-on round found a tooltip alone showed nothing on a click). Beside Export, drawn as a key cap rather
            than as one of the edits' tools (2026-10-25, the maintainer's request). */}
        <span className="editor-end">
        <Popover>
          <ControlTooltip label={model.text("Keyboard shortcuts")}>
            <PopoverTrigger render={<button type="button" className="editor-keys-trigger" />} id="editor-keys" aria-label={`${model.text("Keyboard shortcuts")}: ${keys}${camera ? ` · ${model.text("C hide or show the camera in the selection")}` : ""}${inputs.length > 0 ? ` · ${model.text("V set the volume of the selection")}` : ""}`}>
              <Keyboard aria-hidden="true" />
            </PopoverTrigger>
          </ControlTooltip>
          {/* The keys alone (2026-10-26: Skimming moved to Options), each key against what it does. */}
          <PopoverContent side="top" align="end" id="editor-keys-popup" className="editor-keys-popup gap-0" finalFocus={false}>
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
        <ExportControls />
        </span>
      </div>
      {/* The trimmer, as iPhone's and QuickTime's: the handles stand outside the kept recording with ‹ ›, lines join them
          above and below, and the track pads its sides so a handle at the very start or end is seen whole (2026-10-25). */}
      <div
        className="editor-trimmer"
        data-lane={lanes > 0 || undefined}
        style={{ "--lanes": lanes } as React.CSSProperties}
        onPointerDown={(event) => {
          const ticks = ticksAt(event.clientX);
          const box = track.current?.getBoundingClientRect();
          if (busy || event.button !== 0 || ticks === undefined || !box) return;
          // The playhead as it stands, read before the press keeps what is skimmed: while skimming the picture is
          // already under the pointer, and every press would read as one on the playhead, a scrub, never a range.
          const now = model.playheadTime() ?? time;
          model.keepSkimmed();
          event.currentTarget.setPointerCapture(event.pointerId);
          const xOf = (at: number): number => box.left + (at / editor.duration) * box.width;
          // A press on the camera's lane is the lane's, never a trim handle's beside it (Codex's review): the handles
          // keep to the pictures above it.
          const laneName = (event.target as HTMLElement).closest?.(".editor-camera-lane")?.getAttribute("data-lane");
          const lane = laneName === "camera" || laneName === "system" || laneName === "microphone" ? laneName : undefined;
          // A trim handle, pressed or pressed beside: the start's reaches in from its edge, the end's back from its.
          const handle = (event.target as HTMLElement).closest?.(".editor-trim")?.getAttribute("data-edge");
          const edge: model.TrimEdge | undefined = lane ? undefined : handle === "start" || handle === "end" ? handle
            : event.clientX >= xOf(trim.start) - TRIM_HANDLE - TRIM_REACH && event.clientX <= xOf(trim.start) + TRIM_REACH ? "start"
            : event.clientX <= xOf(trim.end) + TRIM_HANDLE + TRIM_REACH && event.clientX >= xOf(trim.end) - TRIM_REACH ? "end" : undefined;
          if (edge) {
            gesture.current = { pointer: event.pointerId, startX: event.clientX, start: ticks, mode: edge, offset: (ticksAt(event.clientX, true) ?? ticks) - trim[edge] };
            document.getElementById(`editor-trim-${edge}`)?.focus({ preventScroll: true });
            model.moveTrim(edge, trim[edge]);
            return;
          }
          const playheadX = box.left + Math.min(1, now / Math.max(editor.seconds, 0.001)) * box.width;
          const onPlayhead = !lane && Math.abs(event.clientX - playheadX) <= 6;
          gesture.current = { pointer: event.pointerId, startX: event.clientX, start: ticks, mode: onPlayhead ? "scrub" : "click", lane };
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
          if (held?.pointer === event.pointerId && held.mode === "click" && ticks !== undefined) {
            // On a lane, a stretch the edit set (hidden, muted, a volume of its own) is chosen, as a range the camera
            // button or the Volume popup then acts on; anywhere else on it, as on the pictures: the playhead there and
            // the part there (2026-10-26, the maintainer's report: a lane not yet set is one stretch, and a click chose
            // the whole recording).
            const list = held.lane ? laneStretches(held.lane) : [];
            const stretch = held.lane ? list.find((one) => ticks >= one.from && ticks < one.to) ?? list.at(-1) : undefined;
            if (held.lane) model.chooseLaneInput(held.lane === "camera" ? undefined : held.lane);
            if (stretch?.set) {
              model.selectRange(stretch.from, stretch.to, held.lane);
              model.seekTo(ticks / editor.timescale);
            } else placeAt(ticks);
          }
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
        {parts.map((part, index) => {
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
              data-split={index < parts.length - 1 || undefined}
              style={{ left: percent(part.from), width: percent(part.to - part.from) }}
              aria-label={label}
              aria-pressed={selected?.from === part.from}
              disabled={busy}
              // The pointer's press already chose the place; Enter or Space selects the part from its start.
              onClick={(event) => { if (event.detail === 0) model.selectPart(part); }}
            />
          );
        })}
        {parts.slice(1).map((part) => (
          <span key={part.from} className="editor-split-mark" style={{ left: percent(part.from) }} aria-hidden="true" />
        ))}
        {editor.notes.map((note) => (
          <span key={note.at} className="editor-note-mark" style={{ left: `${(note.at / editor.seconds) * 100}%` }} aria-hidden="true" />
        ))}
        {range && <span className="editor-range" data-outline={model.rangeLane ? true : undefined} style={{ left: percent(range[0]), width: percent(range[1] - range[0]) }} aria-hidden="true" />}
        {model.skimAt !== undefined && <span className="editor-skimmer" style={{ left: percent(model.skimAt) }} aria-hidden="true" />}
        <span className="editor-playhead" style={{ left: `${Math.min(100, (time / Math.max(editor.seconds, 0.001)) * 100)}%` }} aria-hidden="true" />
        </div>
        {/* The camera's lane (2026-10-26): where the camera is in the picture, and where it is hidden, on the same
            time as the pictures above; a stretch is selected by a click, or by Enter on it. */}
        {cameraLane && (
          <div className="editor-camera-lane" data-lane="camera" role="group" aria-label={model.text("Camera")}>
            {stretches.map((stretch) => {
              const chosen = range !== undefined && range[0] === stretch.from && range[1] === stretch.to;
              return (
                <button
                  key={`${stretch.from}-${stretch.to}`}
                  type="button"
                  className="editor-camera-stretch"
                  data-hidden={stretch.hidden || undefined}
                  data-selected={chosen || undefined}
                  style={{ left: percent(stretch.from), width: percent(stretch.to - stretch.from) }}
                  aria-label={translate(stretch.hidden ? "{from} to {to}, camera hidden" : "{from} to {to}, camera shown", language, {
                    from: at(stretch.from / editor.timescale), to: at(stretch.to / editor.timescale),
                  })}
                  aria-pressed={chosen}
                  disabled={busy}
                  onClick={(event) => {
                    if (event.detail !== 0) return;
                    // From the keyboard as from the pointer: a hidden stretch is chosen, else the part where it starts.
                    if (stretch.hidden) {
                      model.selectRange(stretch.from, stretch.to, "camera");
                      model.seekTo(stretch.from / editor.timescale);
                    } else placeAt(stretch.from);
                  }}
                >
                  {stretch.hidden ? <UserRoundX aria-hidden="true" /> : <UserRound aria-hidden="true" />}
                  {/* In words while the stretch is wide enough, so the lane says what it is; cut off when narrow. */}
                  <span aria-hidden="true">{model.text(stretch.hidden ? "Camera hidden" : "Camera shown")}</span>
                </button>
              );
            })}
            {editor.removed.map(([from, to]) => (
              <span key={from} className="editor-camera-removed" style={{ left: percent(from), width: percent(to - from) }} aria-hidden="true" />
            ))}
            {range && <span className="editor-camera-range" data-outline={model.rangeLane && model.rangeLane !== "camera" ? true : undefined} style={{ left: percent(range[0]), width: percent(range[1] - range[0]) }} aria-hidden="true" />}
            <span className="editor-camera-playhead" style={{ left: `${Math.min(100, (time / Math.max(editor.seconds, 0.001)) * 100)}%` }} aria-hidden="true" />
          </div>
        )}
        {/* Each input's lane (2026-10-26): its own volume, or a stretch's, muted or a percent. */}
        {inputLanes.map((input) => {
          const name = model.text(input === "system" ? "System audio" : "Microphone");
          const own = editor.editable && model.editorScene(editor)?.volumes[input];
          return (
            <div key={input} className="editor-camera-lane editor-volume-lane" data-lane={input} role="group" aria-label={name}>
              {model.volumeLane(editor, input).map((stretch) => {
                const chosen = range !== undefined && range[0] === stretch.from && range[1] === stretch.to;
                const muted = stretch.volume === 0;
                const from = at(stretch.from / editor.timescale), to = at(stretch.to / editor.timescale);
                const label = stretch.volume === undefined ? translate("{from} to {to}, {name} at its volume", language, { from, to, name })
                  : muted ? translate("{from} to {to}, {name} muted", language, { from, to, name })
                  : translate("{from} to {to}, {name} at {percent}%", language, { from, to, name, percent: String(stretch.volume) });
                const Icon = input === "system" ? (muted ? VolumeX : Volume2) : (muted ? MicOff : Mic);
                return (
                  <button
                    key={`${stretch.from}-${stretch.to}`}
                    type="button"
                    className="editor-camera-stretch editor-volume-stretch"
                    data-hidden={muted || undefined}
                    data-custom={stretch.volume !== undefined || undefined}
                    data-selected={chosen || undefined}
                    style={{ left: percent(stretch.from), width: percent(stretch.to - stretch.from) }}
                    aria-label={label}
                    aria-pressed={chosen}
                    disabled={busy}
                    onClick={(event) => {
                      if (event.detail !== 0) return;
                      model.chooseLaneInput(input);
                      if (stretch.volume !== undefined) {
                        model.selectRange(stretch.from, stretch.to, input);
                        model.seekTo(stretch.from / editor.timescale);
                      } else placeAt(stretch.from);
                    }}
                  >
                    <Icon aria-hidden="true" />
                    <span aria-hidden="true">
                      {stretch.volume === undefined ? `${name} ${own ?? 100}%` : muted ? model.text("Muted") : `${stretch.volume}%`}
                    </span>
                  </button>
                );
              })}
              {editor.removed.map(([from, to]) => (
                <span key={from} className="editor-camera-removed" style={{ left: percent(from), width: percent(to - from) }} aria-hidden="true" />
              ))}
              {range && <span className="editor-camera-range" data-outline={model.rangeLane && model.rangeLane !== input ? true : undefined} style={{ left: percent(range[0]), width: percent(range[1] - range[0]) }} aria-hidden="true" />}
              <span className="editor-camera-playhead" style={{ left: `${Math.min(100, (time / Math.max(editor.seconds, 0.001)) * 100)}%` }} aria-hidden="true" />
            </div>
          );
        })}
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
  // At the row's end, after the free space, which takes its changes of width: the edits and the times, and the rows
  // under them, stay where they are as an export starts, runs and ends (2026-10-25).
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
  // Export only (2026-10-26): its outcome is a toast, so the button reads the same before an export and after one.
  return (
    <span className="editor-export">
      <ControlTooltip label={editor.blocked ?? model.text(editor.editable ? "Write the recording with the camera and sound set here to a new file beside it" : "Write the kept parts to a new file beside the recording")}>
        <Button
          id="editor-export"
          size="sm"
          // A change still saving is waited for by the export itself (controller's exportEdit), so nothing dims meanwhile.
          aria-disabled={!editor.exportable}
          onClick={() => {
            if (editor.exportable) void model.exportEdit();
          }}
        >
          <Upload />
          {model.text("Export")}
        </Button>
      </ControlTooltip>
    </span>
  );
}
