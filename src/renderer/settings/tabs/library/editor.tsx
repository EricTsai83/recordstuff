/**
 * The edit view (plan 085): a recording's player above a timeline of its parts. A part is selected by clicking it, split
 * at the playhead (S) and removed or kept again (Delete); Undo (⌘Z / Ctrl+Z) takes the last change back and Redo
 * (⇧⌘Z / Ctrl+Shift+Z or Ctrl+Y) makes it again. The preview plays only what is kept, over a strip of the recording's
 * pictures. Save a copy… (plan 100, formerly Export) writes a new file in the form chosen, beside the recording unless
 * another folder is chosen; the recording stays as it is.
 *
 * An editable recording with a camera (2026-10-26, the maintainer's request) has a lane under the pictures that shows
 * where the camera is in the picture and where it is hidden; the camera button (C) hides it over the selected range or
 * part, or shows it there again, and a click on the lane selects one of its stretches. Each sound input has a lane too
 * (2026-10-26): its own volume, or a stretch's (muted, or a percent), set over the selection by the Volume popup (V).
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { Keyboard, Maximize, Merge, Mic, MicOff, PanelBottomClose, PanelBottomOpen, Pause, Play, Redo2, RotateCcw, Scissors, Trash2, Undo2, Upload, UserRound, UserRoundX, Volume2, VolumeX, X } from "lucide-react";
import { toast } from "sonner";
import type { LibraryItemView } from "../../../../shared/settings-panel";
import type { EditorView, EditRange } from "../../../../shared/editing";
import type { CopyForm } from "../../../../shared/provenance";
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
import { EditorCamera, EditorOptions, OverallVolume, TOOL_HOVER, VolumeButton } from "./editor-scene";

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
    // A failed or finished recording is not playing, though Chromium may leave it unpaused (2026-10-26).
    const show = (): void => setPlaying(!video.paused && !video.ended && !video.error);
    show();
    const events = ["play", "pause", "ended", "emptied", "error", "loadstart"];
    for (const name of events) video.addEventListener(name, show);
    return () => { for (const name of events) video.removeEventListener(name, show); };
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
      // Beside the recording, a video the Recordings tab lists plays; anything else is shown in Finder (plan 100).
      const reveal = model.text(model.platform() === "darwin" ? "Show in Finder" : "Show in File Explorer");
      toast(translate("Saved “{title}”", model.view?.language, { title: name.replace(/\.(mp4|m4a)$/i, "") }), {
        toasterId: EXPORT_TOASTER,
        id,
        description: outcome.playable ? model.text("Saved in the recording's folder.") : translate("Saved in {folder}.", model.view?.language, { folder: editor.copy?.folder ?? "" }),
        duration: 8000,
        className: "undo-toast editor-export-toast",
        classNames: { title: "toast-title", description: "toast-description", actionButton: "toast-action" },
        action: outcome.playable
          ? { label: model.text("Play"), onClick: () => void model.playExport(name, editor.id) }
          : { label: reveal, onClick: () => void model.revealExport() },
      });
    } else {
      toast(model.text("The copy could not be saved"), {
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

/** How long the timeline's size must hold before its pictures are read again: a window being resized moves it often. */
const STRIP_SETTLE_MS = 200;

/**
 * The recording's pictures along the timeline (2026-10-25, at the maintainer's request): one frame per tile, as many
 * tiles as fit the timeline's width at its height, read by a hidden video of its own one seek at a time, so a long
 * recording costs a few dozen decodes per view. The parts are drawn over it. Read again, once the size settles, when
 * the window is resized or zoomed (the canvas would otherwise stretch its first pictures), or when the timeline first
 * gets a width.
 */
function TimelineStrip({ source }: { source: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<string>();
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (): void => setSize(target.clientWidth > 0 ? `${target.clientWidth}×${target.clientHeight}@${window.devicePixelRatio || 1}` : undefined);
    read();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(read, STRIP_SETTLE_MS); });
    observer.observe(target);
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, []);
  useEffect(() => {
    const target = canvas.current;
    const context = target?.getContext?.("2d");
    if (!target || !context || !size || target.clientWidth === 0) return;
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
  }, [source, size]);
  return <canvas ref={canvas} className="editor-strip" aria-hidden="true" />;
}

/** Keys of the edit view that are not the player's: Split, Remove or keep, Undo, Redo. */
function editorKey(event: React.KeyboardEvent): void {
  const target = event.target as HTMLElement;
  // A slider's input takes Undo and Redo as the rest of the view does (a native round of 2026-10-26: ⌘Z on a volume did
  // nothing); a field that takes text keeps its own.
  const slider = target instanceof HTMLInputElement && target.type === "range";
  if ((target instanceof HTMLInputElement && !slider) || target instanceof HTMLTextAreaElement) return;
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
  if (event.metaKey || event.ctrlKey || event.altKey || slider) return;
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
  if (key === "t") {
    event.preventDefault();
    model.toggleEnlarged();
  } else if (key === "f") {
    // Full screen from anywhere in the view, the timeline included, as the shortcuts list says (Codex's review); the
    // player takes its own F first when it has the focus.
    event.preventDefault();
    void model.playEditorFullScreen();
  } else if (model.enlarged) {
    // Enlarged, the timeline's keys wait for it to come back; Space and the arrows are the player's.
    return;
  } else if (key === "s") {
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
  // Enlarge preview and full screen, together where a player keeps them (2026-10-27).
  const viewButtons = (
    <>
      <ControlTooltip label={`${model.text(model.enlarged ? "Show the timeline" : "Enlarge preview")} (T)`}>
        <Button
          variant="media"
          size="icon-media"
          id="editor-enlarge"
          aria-label={model.text(model.enlarged ? "Show the timeline" : "Enlarge preview")}
          aria-pressed={model.enlarged}
          onClick={() => model.toggleEnlarged()}
        >
          {model.enlarged ? <PanelBottomOpen /> : <PanelBottomClose />}
        </Button>
      </ControlTooltip>
      <ControlTooltip label={`${model.text("Full screen")} (F)`}>
        <Button
          variant="media"
          size="icon-media"
          id="editor-fullscreen"
          aria-label={model.text("Full screen")}
          aria-disabled={model.editorFullScreenPending || editor?.state !== "ready" || undefined}
          onClick={() => void model.playEditorFullScreen()}
        >
          <Maximize />
        </Button>
      </ControlTooltip>
    </>
  );
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
        className="editor flex h-[calc(100dvh-2*var(--dialog-margin)-var(--dialog-top-reserve))] w-[calc(100vw-2*var(--dialog-margin))] max-w-none flex-col gap-0 overflow-y-auto rounded-xl p-0 shadow-player ring-0 sm:max-w-none top-[calc(50%+var(--dialog-top-reserve)/2)]"
        data-id={item?.id}
        data-enlarged={model.enlarged || undefined}
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
              error={model.editorPreviewError}
              onError={model.editorPreviewFailed}
              // The player's own controls only while the preview is enlarged, the timeline then out of sight (2026-10-27).
              controls={model.enlarged}
              // A double-click or F plays the edit full screen, as the player's (2026-10-27).
              onDoubleClick={() => void model.playEditorFullScreen()}
              fullScreen={() => void model.playEditorFullScreen()}
              // Enlarged, the two ways to see it larger sit at the end of the player's own controls, as its full screen
              // does; otherwise at the picture's bottom right (2026-10-27, the maintainer's review: by Close they were
              // in the wrong corner, where a player keeps them).
              trailing={model.enlarged ? viewButtons : null}
              close={
                <>
                {model.editorPreviewError && (
                  <Button id="editor-reload" variant="media" onClick={() => model.reloadEditorPreview()}>
                    <RotateCcw />
                    {model.text("Reload preview")}
                  </Button>
                )}
                <ControlTooltip label={exporting ? model.text("Cancel saving the copy to close") : model.text("Close")}>
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
                </>
              }
            />
          )}
          {item && editor?.state === "ready" && editor.editable && <EditorCamera editor={editor} />}
          {item && !model.enlarged && <div className="editor-view-buttons">{viewButtons}</div>}
          {/* Over the stage's foot, inside the dialog, so the dialog neither covers it nor takes its clicks as outside.
              Only while the view is open: a second Sonner list drawn the rest of the time held the page's Trash toast
              open after the pointer left it. */}
          {model.editingItem && <Toaster id={EXPORT_TOASTER} hotkey={[]} position="bottom-right" visibleToasts={1} offset={{ bottom: model.enlarged ? 84 : 56, right: 12 }} />}
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
  pointer: number; startX: number; start: number; mode: "click" | "range" | "scrub";
  /** Pressed on a lane (the camera's or an input's): a click there selects the lane's stretch rather than the part. */
  lane?: "camera" | VolumeInput | undefined;
}

/**
 * Remove (Delete) in words, with its key, among a selection's floating actions (2026-10-26: it acts on the selection,
 * so it is where the selection is, and only there). Keep in place of Remove for a removed part; as wide either way, so
 * nothing after it moves.
 */
function RemoveButton({ id }: { id: string }) {
  const editor = model.editorView();
  if (!editor) return null;
  const selected = model.selectedPart(editor), range = model.rangeSelection;
  const busy = editor.export.phase === "exporting";
  const keep = !range && Boolean(selected?.removed);
  return (
    <ControlTooltip label={model.text(range ? "Remove the selected range (Delete)" : !selected ? "Select a part or drag across the timeline, then remove it (Delete)" : keep ? "Keep the selected part (Delete)" : "Remove the selected part (Delete)")}>
      <Button
        id={id}
        variant="ghost"
        size="sm"
        className={`editor-remove ${TOOL_HOVER}`}
        aria-label={model.text(range ? "Remove selection" : keep ? "Keep part" : "Remove part")}
        aria-disabled={busy || (!selected && !range)}
        onClick={() => { if (!busy && (selected || range)) void model.toggleSelected(); }}
      >
        {keep ? <RotateCcw /> : <Trash2 />}
        <span className="editor-remove-label" aria-hidden="true">{model.text(keep ? "Keep" : "Remove")}</span>
        <Kbd aria-hidden="true">{model.platform() === "darwin" ? "⌫" : "Del"}</Kbd>
      </Button>
    </ControlTooltip>
  );
}

/** How far the selection's actions stand above the timeline's top edge, in CSS pixels. */
const ACTIONS_GAP = 9;

/**
 * The line over the timeline (2026-10-26, B′, then the maintainer's review of it): small, close to the timeline and apart
 * from the toolbar; the playhead's time (or a trim handle's) and the export's length together at its end, how to select
 * at its start while nothing is chosen, and, while a part or range is chosen, its actions floating above it, its length
 * first, rising into the room above the line rather than over the toolbar. Always as tall, so nothing below it moves as
 * a selection comes and goes; the actions keep clear of the times.
 */
function EditorActionRow({ editor, track, span, actions: actionsKey, position, length, shortPosition, shortLength, children }: {
  editor: EditorView; track: RefObject<HTMLDivElement | null>; span: EditRange | undefined;
  /** Which actions it holds, so a change to them (Join previous coming or going) measures them afresh in words. */
  actions: string; position: string;
  length: string; shortPosition: string; shortLength: string; children: ReactNode;
}) {
  const row = useRef<HTMLDivElement>(null), bar = useRef<HTMLDivElement>(null), tail = useRef<HTMLSpanElement>(null);
  const [left, setLeft] = useState<number | undefined>(undefined);
  // How far above the line's foot the actions stand: just over the timeline.
  const [rise, setRise] = useState(0);
  // Too narrow for the actions in words beside the export's length (380 px windows, review of 2026-10-26): their icons
  // and keys alone, over the whole line. Decided on their width in words, kept while they show.
  // 0 in full; 1 without the selection's length; 2 with Remove alone in words too (the maintainer's review of
  // 2026-10-26: a 460 px window dropped every name at once). Decided on their full width, kept while they show.
  const [compact, setCompact] = useState<0 | 1 | 2>(0);
  // The actions over the times, which then give way while they show.
  const [covering, setCovering] = useState(false);
  const wide = useRef(0), lengthWide = useRef(0);
  const shown = span !== undefined && editor.export.phase !== "exporting";
  const from = span?.[0], to = span?.[1];
  useLayoutEffect(() => {
    const place = (): void => {
      const line = row.current, actions = bar.current, timeline = track.current;
      if (!shown || from === undefined || to === undefined || !line || !actions || !timeline) {
        // Gone, they are measured afresh in words when they show again (a narrow window's steps were kept otherwise).
        setCovering(false);
        setCompact(0);
        return setLeft(undefined);
      }
      const lineBox = line.getBoundingClientRect(), trackBox = timeline.getBoundingClientRect();
      const middle = trackBox.left - lineBox.left + ((from + to) / 2 / editor.duration) * trackBox.width;
      // Always over the timeline, wherever the selection was chosen: it is a stretch of time across the pictures and
      // every lane (the maintainer's review of 2026-10-26: over the lane clicked, the actions read as that lane's), just
      // above its top edge, centred over the selection; no pointer under them, the frame saying what is chosen.
      setRise(Math.round(lineBox.bottom - trackBox.top) + ACTIONS_GAP);
      // Their width in words, measured every time with any step taken off for the measure (reviews of 2026-10-26: a
      // width kept from other actions, Join previous coming or going, chose the wrong step), then the step put back.
      const step = actions.dataset.compact;
      delete actions.dataset.compact;
      wide.current = actions.offsetWidth;
      lengthWide.current = actions.querySelector<HTMLElement>(".editor-selection-length")?.offsetWidth ?? 0;
      if (step !== undefined) actions.dataset.compact = step;
      // The whole line is theirs: they stand right over the selection, and the times give way only where they meet
      // (the maintainer's review of 2026-10-26: pushed aside for the times, the actions stood away from a selection at
      // the end).
      const room = lineBox.width;
      setCompact(wide.current <= room ? 0 : wide.current - lengthWide.current - 6 <= room ? 1 : 2);
      const width = actions.offsetWidth;
      const placed = Math.round(Math.max(0, Math.min(middle - width / 2, room - width)));
      setLeft(placed);
      const times = tail.current?.getBoundingClientRect();
      setCovering(times !== undefined && lineBox.left + placed + width + 8 > times.left);
    };
    place();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : undefined;
    if (row.current) observer?.observe(row.current);
    if (bar.current) observer?.observe(bar.current);
    // Lanes shown or hidden in Options move the one chosen on, or take it away (review of 2026-10-26).
    if (row.current?.parentElement) observer?.observe(row.current.parentElement);
    return () => observer?.disconnect();
  }, [shown, from, to, editor.duration, track, compact, actionsKey]);
  return (
    <div ref={row} className="editor-action-row">
      {/* How to reach the selection's actions, while none is chosen (2026-10-26: Remove is there only). */}
      <span className="editor-select-hint" data-covered={shown || undefined}>{model.text("Click a part or drag across the timeline to select it")}</span>
      {/* In words where the line has room; a narrow view keeps the numbers alone, "where / how long", their words still
          read aloud. */}
      <span ref={tail} className="editor-readouts" data-covered={(shown && covering) || undefined}>
        <span className="editor-position">{position}</span>
        <span className="editor-length">{length}</span>
        <span className="editor-readouts-short" aria-hidden="true">{shortPosition} / {shortLength}</span>
      </span>
      {shown && (
        <div
          ref={bar}
          id="editor-selection-actions"
          role="toolbar"
          aria-label={model.text("Selection")}
          className="editor-selection-actions"
          data-placed={left !== undefined || undefined}
          data-compact={compact || undefined}
          style={{ left: left ?? 0, bottom: rise }}
        >
          {/* Leaving the selection first, as a selection bar has it (2026-10-27, the maintainer's choice): what Escape does. */}
          <ControlTooltip label={model.text("Deselect (Esc)")}>
            <Button id="editor-deselect" variant="ghost" size="icon-sm" className={`editor-deselect ${TOOL_HOVER}`} aria-label={model.text("Deselect")} onClick={() => model.deselect()}>
              <X />
            </Button>
          </ControlTooltip>
          <span className="editor-selection-divider" aria-hidden="true" />
          {children}
          {/* Its length last and apart, information rather than an action (2026-10-27, the maintainer's review). */}
          <span className="editor-selection-divider editor-selection-length-divider" aria-hidden="true" />
          <span className="editor-selection-length">{translate("Length {length}", model.view?.language, { length: precise(((to ?? 0) - (from ?? 0)) / editor.timescale) })}</span>
          {/* Why a removal was refused, a moment over the actions where it was asked, taking no room (2026-10-27). */}
          {model.refusal && <span id="editor-refusal" className="editor-refusal" role="status">{model.refusal}</span>}
        </div>
      )}
    </div>
  );
}

function EditorPanel() {
  const editor = model.editorView();
  const time = usePlayhead();
  const playing = usePlaying();
  const gesture = useRef<TimelineGesture | null>(null);
  /** The track of pictures and parts, whose width the recording's time spans. */
  const track = useRef<HTMLDivElement | null>(null);
  // The stretch of time a click under the pointer would choose, framed faintly across the pictures and every lane
  // (2026-10-26, the maintainer's review: a selection is one stretch of time, and the pointer says which beforehand).
  const [hovered, setHovered] = useState<EditRange | undefined>(undefined);
  // Worked out again from where the pointer rests at every draw, so a split, an Undo or a lane's change under a still
  // pointer frames what a click would now choose (Codex's review).
  const pointer = useRef<{ clientX: number; lane: model.Lane | undefined } | undefined>(undefined);
  const rehover = useRef<() => void>(() => {});
  useEffect(() => rehover.current());
  // However a press ends, the gesture does: a release anywhere in the window, or the window losing the pointer.
  useEffect(() => {
    const end = (): void => {
      gesture.current = null;
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
    if (active && active !== document.body && active.closest("#editor, #editor-keys-popup, #editor-options-popup, #editor-volume-popup, #editor-mix-popup, #editor-revert-confirm")) return;
    const target = document.querySelector<HTMLElement>("#editor .editor-part[aria-pressed='true']") ?? document.querySelector<HTMLElement>("#editor .editor-timeline");
    target?.focus({ preventScroll: true });
  });
  const language = model.view?.language ?? "en";
  if (!editor || editor.state === "loading") {
    return (
      <div className="editor-panel" aria-busy="true">
        <p className="editor-message my-1 mx-0 wrap-anywhere text-muted-foreground">{model.text("Loading the recording…")}</p>
      </div>
    );
  }
  if (editor.state !== "ready") {
    return (
      <div className="editor-panel">
        <p className="editor-message my-1 mx-0 wrap-anywhere" role="alert">{editor.message}</p>
        <div className="editor-actions">
          {(editor.state === "stale" || editor.state === "unreadable") && (
            <Button id="editor-discard" variant="outline" onClick={() => void model.discardEdit()}>
              <RotateCcw />
              {model.text("Discard edit")}
            </Button>
          )}
          <span className="flex-[1_1_0]" />
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
  // there; a drag across it chooses a range Remove takes out; a drag that starts on the playhead scrubs. Split stays for
  // cutting the timeline into parts by hand. The recording's start and end are cut as any range is, a drag from the
  // timeline's edge and Remove (2026-10-26, the maintainer's review: trim handles at either end did the same once more).
  /** The recording's time under `clientX`, kept within it: a drag past either edge stops at the very start or end. */
  const ticksAt = (clientX: number): number | undefined => {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return undefined;
    return Math.round(Math.min(1, Math.max(0, (clientX - box.left) / box.width)) * editor.duration);
  };
  const placeAt = (ticks: number): void => {
    const part = model.partAt(parts, ticks);
    if (part) model.selectPart(part, false);
    model.seekTo(ticks / editor.timescale);
  };
  /**
   * The stretch of time a click at `ticks` chooses: on a lane, a stretch the edit set (hidden, muted, a volume of its
   * own) whole; anywhere else, the part there. Always across the pictures and every lane (the maintainer's review of
   * 2026-10-26): where it was clicked says which stretch, never which track.
   */
  const setStretchAt = (ticks: number, lane: model.Lane | undefined): { from: number; to: number } | undefined => {
    if (!lane) return undefined;
    const list = laneStretches(lane);
    const stretch = list.find((one) => ticks >= one.from && ticks < one.to) ?? list.at(-1);
    return stretch?.set ? stretch : undefined;
  };
  const spanAt = (ticks: number, lane: model.Lane | undefined): EditRange | undefined => {
    const stretch = setStretchAt(ticks, lane);
    if (stretch) return [stretch.from, stretch.to];
    const part = model.partAt(parts, ticks);
    return part ? [part.from, part.to] : undefined;
  };
  // What a click where the pointer rests would choose, framed faintly; none beside the recording.
  rehover.current = () => {
    const at = pointer.current, ticks = at && ticksAt(at.clientX), box = track.current?.getBoundingClientRect();
    const next = at && !busy && ticks !== undefined && box && at.clientX >= box.left && at.clientX <= box.right
      ? spanAt(ticks, at.lane) : undefined;
    setHovered((now) => (now?.[0] === next?.[0] && now?.[1] === next?.[1] ? now : next));
  };
  const laneAt = (target: EventTarget | null): model.Lane | undefined => {
    const name = (target as HTMLElement | null)?.closest?.(".editor-camera-lane")?.getAttribute("data-lane");
    return name === "camera" || name === "system" || name === "microphone" ? name : undefined;
  };
  const follow = (pointer: number, clientX: number): void => {
    const held = gesture.current, ticks = ticksAt(clientX);
    if (!held || held.pointer !== pointer || ticks === undefined) return;
    if (held.mode === "click" && Math.abs(clientX - held.startX) > 4) held.mode = "range";
    if (held.mode === "scrub") placeAt(ticks);
    else if (held.mode === "range") {
      // The preview follows the end being dragged, so the cut is chosen by its picture (2026-10-25).
      model.selectRange(held.start, ticks);
      model.editorVideo?.pause();
      model.seekTo(ticks / editor.timescale);
    }
  };
  const mac = model.platform() === "darwin";
  const shortcuts: Array<[string, PlainMessageKey]> = [
    [model.text("Space"), "Play or pause"], ["← →", "Move a frame"], ["Shift ← →", "Move a second"], ["S", "Split"],
    ["Delete", "Remove the selection"], [mac ? "⌘Z" : "Ctrl+Z", "Undo"], [mac ? "⇧⌘Z" : "Ctrl+Y", "Redo"],
    ...(camera ? [["C", "Hide or show the camera in the selection"] as [string, PlainMessageKey]] : []),
    ...(inputs.length > 0 ? [["V", "Set the volume of the selection"] as [string, PlainMessageKey]] : []),
    ["T", "Enlarge preview"], ["F", "Full screen"],
  ];
  const keys = translate("Space play or pause · ← → a frame, Shift+← → a second · S split · Delete remove · {undo} undo · {redo} redo", language, {
    undo: model.platform() === "darwin" ? "⌘Z" : "Ctrl+Z",
    redo: model.platform() === "darwin" ? "⇧⌘Z" : "Ctrl+Y",
  });
  const range = model.rangeSelection;
  // What is chosen, a range or else the selected part: one stretch of time, framed across the pictures and every lane
  // (the maintainer's review of 2026-10-26: a frame on each track did not say which was chosen).
  const chosen: EditRange | undefined = range ?? (selected ? [selected.from, selected.to] : undefined);
  const frame = (span: EditRange) => ({ "--from": span[0] / editor.duration, "--to": span[1] / editor.duration }) as React.CSSProperties;
  const ruler = rulerMarks(editor.seconds);
  return (
    <div className="editor-panel">
      {/* One row over the timeline (2026-10-25, the maintainer's choice of layouts, to simplify the view and give the
          picture more of the height): Play, as the picture has no controls of its own (2026-10-26); the edits; the
          options behind one named button (editor-scene.tsx); where the playhead is and how long the export runs; the
          keys against Export. An export's outcome is a toast (useExportToast), so nothing in the row moves. The playhead's
          time is to the hundredth, so a frame's step shows. */}
      <div className="editor-toolbar">
        <ControlTooltip label={`${model.text(playing ? "Pause" : "Play")} (${model.text("Space")})`}>
          <Button id="editor-play" variant="ghost" className={TOOL_HOVER} size="icon" aria-label={model.text(playing ? "Pause" : "Play")} onClick={() => model.togglePlayback()}>
            {playing ? <Pause /> : <Play />}
          </Button>
        </ControlTooltip>
        <span className="editor-divider" aria-hidden="true" />
        <ControlTooltip label={model.text(model.platform() === "darwin" ? "Undo (⌘Z)" : "Undo (Ctrl+Z)")}>
          <Button id="editor-undo" variant="ghost" className={TOOL_HOVER} size="icon" aria-label={model.text("Undo")} aria-disabled={busy || !model.canUndo()} onClick={() => void model.undoEdit()}>
            <Undo2 />
          </Button>
        </ControlTooltip>
        <ControlTooltip label={model.text(model.platform() === "darwin" ? "Redo (⇧⌘Z)" : "Redo (Ctrl+Y)")}>
          <Button id="editor-redo" variant="ghost" className={TOOL_HOVER} size="icon" aria-label={model.text("Redo")} aria-disabled={busy || !model.canRedo()} onClick={() => void model.redoEdit()}>
            <Redo2 />
          </Button>
        </ControlTooltip>
        <span className="editor-divider" aria-hidden="true" />
        {/* The toolbar holds what acts on the whole recording or at the playhead (Split); what acts on a selection, Remove
            among it, floats over the selection (2026-10-26, the maintainer's rule after B′: an action sits where what it
            acts on is). */}
        <ControlTooltip label={model.text("Split at the playhead (S)")}>
          <Button id="editor-split" variant="ghost" size="sm" className={`editor-tool ${TOOL_HOVER}`} aria-label={model.text("Split")} aria-disabled={busy} onClick={() => { if (!busy) void model.splitAtPlayhead(); }}>
            <Scissors />
            <span className="editor-tool-label" aria-hidden="true">{model.text("Split")}</span>
          </Button>
        </ControlTooltip>
        <span className="flex-[1_1_0]" />
        <OverallVolume editor={editor} />
        <EditorOptions editor={editor} />
        {/* The keys, opened by a click as well as named to assistive technology (a
            hands-on round found a tooltip alone showed nothing on a click). Beside Export, drawn as a key cap rather
            than as one of the edits' tools (2026-10-25, the maintainer's request). */}
        {/* The keys and Export at the row's end, the keys against Export (2026-10-25, the maintainer's request); the outcome
            before them takes what Export's states leave, so the edits and the times never move. */}
        <span className="flex items-center gap-2 ms-1">
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
      {/* Over the timeline (2026-10-26, B′): where the playhead is and how long the export runs, a line of its own so
          the toolbar never wraps; a selection's actions float over it, above the selection, so it never moves. */}
      <EditorActionRow
        editor={editor}
        track={track}
        span={range ?? (selected ? [selected.from, selected.to] : undefined)}
        actions={model.canJoinPrevious(editor) ? "join" : ""}
        position={translate("Playhead {time}", language, { time: precise(time) })}
        length={translate("Video length {length}", language, { length: precise(editor.outputSeconds) })}
        shortPosition={precise(time)}
        shortLength={precise(editor.outputSeconds)}
      >
        <RemoveButton id="editor-remove" />
        {/* A part that starts at a split of the timeline's own joins the one before it (2026-10-26). */}
        {model.canJoinPrevious(editor) && (
          <ControlTooltip label={model.text("Join this part to the one before it, taking its split away")}>
            <Button id="editor-join" variant="ghost" className={TOOL_HOVER} size="sm" aria-label={model.text("Join previous")} aria-disabled={busy} onClick={() => { if (!busy) void model.joinPrevious(); }}>
              <Merge />
              <span className="editor-join-label">{model.text("Join previous")}</span>
            </Button>
          </ControlTooltip>
        )}
        {camera && (
          <ControlTooltip label={model.text(allHidden ? "Turn off Hide camera view in More options to hide or show it over a stretch." : showingCamera ? "Show the camera in the selection again (C)" : "Hide the camera in the selection (C)")}>
            <Button
              id="editor-camera-toggle"
              variant="ghost"
              size="sm"
              className={`editor-camera-toggle ${TOOL_HOVER}`}
              aria-label={model.text(showingCamera ? "Show camera in selection" : "Hide camera in selection")}
              aria-disabled={busy || !cameraTarget || allHidden}
              onClick={() => { if (!busy && cameraTarget && !allHidden) void model.toggleCameraInSelection(); }}
            >
              {showingCamera ? <UserRound /> : <UserRoundX />}
              <span className="editor-camera-toggle-label">{model.text(showingCamera ? "Show camera" : "Hide camera")}</span>
              <Kbd aria-hidden="true">C</Kbd>
            </Button>
          </ControlTooltip>
        )}
        {inputs.length > 0 && <VolumeButton editor={editor} />}
      </EditorActionRow>
      {/* The timeline: the pictures and the lanes under them, the full width of the panel (2026-10-26: no trim handles
          beside it). */}
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
          const lane = laneAt(event.target);
          pointer.current = undefined;
          setHovered(undefined);
          const playheadX = box.left + Math.min(1, now / Math.max(editor.seconds, 0.001)) * box.width;
          const onPlayhead = !lane && Math.abs(event.clientX - playheadX) <= 6;
          gesture.current = { pointer: event.pointerId, startX: event.clientX, start: ticks, mode: onPlayhead ? "scrub" : "click", lane };
          if (onPlayhead) placeAt(ticks);
        }}
        onPointerMove={(event) => {
          if (gesture.current) return follow(event.pointerId, event.clientX);
          if (event.pointerType !== "mouse") return;
          const ticks = ticksAt(event.clientX);
          if (model.skimming && ticks !== undefined) model.skimTo(ticks);
          // Where it is, read now: the element under it may be redrawn away before the next draw.
          pointer.current = { clientX: event.clientX, lane: laneAt(event.target) };
          rehover.current();
        }}
        onPointerLeave={() => {
          pointer.current = undefined;
          setHovered(undefined);
          if (!gesture.current) model.endSkim();
        }}
        // Where it is let go too: a drag whose moves did not come (a jump of the pointer) still ends there.
        onPointerUp={(event) => {
          follow(event.pointerId, event.clientX);
          const held = gesture.current, ticks = ticksAt(event.clientX);
          // A range let go: the preview followed its moving end to choose the cut by its picture; the playhead now goes
          // to its start, so Space plays what was chosen (2026-10-27, the maintainer's choice, as Audacity's).
          const chose = model.rangeSelection;
          if (held?.pointer === event.pointerId && held.mode === "range" && chose) model.seekTo(chose[0] / editor.timescale);
          if (held?.pointer === event.pointerId && held.mode === "click" && ticks !== undefined) {
            // On a lane, a stretch the edit set (hidden, muted, a volume of its own) is chosen, as a range the camera
            // button or the Volume popup then acts on; anywhere else on it, as on the pictures: the playhead there and
            // the part there (2026-10-26, the maintainer's report: a lane not yet set is one stretch, and a click chose
            // the whole recording).
            if (held.lane) model.chooseLaneInput(held.lane === "camera" ? undefined : held.lane);
            // As Enter on it: a stretch the lane's edit set is chosen whole, as a range, even where a part has its ends.
            const stretch = setStretchAt(ticks, held.lane);
            if (stretch) {
              model.selectRange(stretch.from, stretch.to);
              model.seekTo(ticks / editor.timescale);
            } else placeAt(ticks);
          }
          gesture.current = null;
        }}
        onPointerCancel={() => { gesture.current = null; }}
        // Let go outside the window, the press ends with no release here (a hands-on round): the lost hold ends it.
        onLostPointerCapture={(event) => { if (gesture.current?.pointer === event.pointerId) gesture.current = null; }}
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
        {/* Where the pointer skims (2026-10-25): thinner than the playhead and of the accent, so the two are told apart. */}
        {model.skimAt !== undefined && <span className="editor-skimmer absolute top-0 bottom-0 z-[3] w-px bg-primary pointer-events-none" style={{ left: percent(model.skimAt) }} aria-hidden="true" />}
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
                      model.selectRange(stretch.from, stretch.to);
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
                // Silent the same way wherever it comes from: a stretch muted, or the overall volume at 0% (2026-10-26,
                // the maintainer's question); only the hatching says the stretch is the edit's own.
                const silent = muted || (stretch.volume === undefined && own === 0);
                const Icon = input === "system" ? (silent ? VolumeX : Volume2) : (silent ? MicOff : Mic);
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
                        model.selectRange(stretch.from, stretch.to);
                        model.seekTo(stretch.from / editor.timescale);
                      } else placeAt(stretch.from);
                    }}
                  >
                    <Icon aria-hidden="true" />
                    <span aria-hidden="true">
                      {stretch.volume === undefined ? `${name} ${own === 0 ? model.text("Muted") : `${own ?? 100}%`}` : muted ? model.text("Muted") : `${stretch.volume}%`}
                    </span>
                  </button>
                );
              })}
              {editor.removed.map(([from, to]) => (
                <span key={from} className="editor-camera-removed" style={{ left: percent(from), width: percent(to - from) }} aria-hidden="true" />
              ))}
            </div>
          );
        })}
        {chosen && <span className="editor-selection" style={frame(chosen)} aria-hidden="true" />}
        {hovered && !(chosen && hovered[0] === chosen[0] && hovered[1] === chosen[1])
          && <span className="editor-selection-preview" style={frame(hovered)} aria-hidden="true" />}
        {/* One playhead over the pictures and every lane, as editors draw it (the maintainer's question of 2026-10-26: a
            line of its own in each, placed alike, broke where their widths differed), under the selection's actions. */}
        <svg className="editor-playhead" style={{ "--at": Math.min(1, time / Math.max(editor.seconds, 0.001)) } as React.CSSProperties} aria-hidden="true" focusable="false">
          <line x1="5" x2="5" y1="1" y2="100%" shapeRendering="crispEdges" />
          <path className="editor-playhead-cap" d="M0.5 0.5 H9.5 L6 7 H4 Z" />
        </svg>
      </div>
      <div className="editor-ruler" aria-hidden="true">
        {ruler.marks.map((mark) => (
          <span key={mark} style={{ left: `${(mark / Math.max(editor.seconds, 0.001)) * 100}%` }}>{rulerTime(mark, ruler.step)}</span>
        ))}
        <i className="editor-ruler-playhead" style={{ left: `${Math.min(100, (time / Math.max(editor.seconds, 0.001)) * 100)}%` }} />
      </div>
      {(editor.notes.length > 0 || editor.saveFailure || (editor.blocked && editor.export.phase !== "exporting")) && (
        <ul className="editor-notes flex flex-col gap-1 m-0 p-0 list-none text-muted-foreground wrap-anywhere">
          {editor.saveFailure && <li className="text-destructive-ink wrap-anywhere" role="alert">{editor.saveFailure}</li>}
          {editor.blocked && editor.export.phase !== "exporting" && <li>{editor.blocked}</li>}
          {editor.notes.map((note) => (
            <li key={note.at}>
              <span className="tabular-nums text-foreground">{at(note.at)}</span> {note.text}
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
          aria-label={model.text("Saving progress")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={{ width: `${percent}%` }} />
        </span>
        <span className="editor-percent">{percent}%</span>
        <Button id="editor-cancel-export" variant="outline" size="sm" aria-disabled={state.cancelling} onClick={() => void model.cancelExport()}>
          {model.text(state.cancelling ? "Cancelling…" : "Cancel saving")}
        </Button>
      </span>
    );
  }
  // Save a copy… only (2026-10-26, Export until plan 100): its outcome is a toast, so the button reads the same before a
  // copy is saved and after one. It asks in which form and where (plan 100), in a popup over it.
  return <SaveCopy editor={editor} />;
}

function SaveCopy({ editor }: { editor: EditorView }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CopyForm>("video");
  const copy = editor.copy;
  const name = model.text("Save a copy…");
  const chosen = copy?.forms.find((entry) => entry.form === form) ?? copy?.forms[0];
  const save = (): void => {
    if (!editor.exportable || !chosen) return;
    setOpen(false);
    void model.exportEdit(chosen.form);
  };
  return (
    <span className="editor-export">
      <Popover open={open && Boolean(copy)} onOpenChange={(next) => { if (next) setForm("video"); setOpen(next && editor.exportable); }}>
        <ControlTooltip label={editor.blocked ?? model.text("Save the recording as set here to a new file, in the form you choose")}>
          <PopoverTrigger
            render={<Button size="sm" />}
            id="editor-export"
            // Named for its icon alone in the narrowest view (Windows CI, 2026-10-27).
            aria-label={name}
            // A change still saving is waited for by the save itself (controller's exportEdit), so nothing dims meanwhile.
            aria-disabled={!editor.exportable}
          >
            <Upload />
            <span className="editor-export-label">{name}</span>
          </PopoverTrigger>
        </ControlTooltip>
        <PopoverContent side="top" align="end" id="editor-copy-popup" className="editor-options-popup w-80" aria-label={model.text("Save a copy")}
          initialFocus={() => document.querySelector<HTMLElement>("#editor-copy-forms [aria-checked=true]")}>
          <div role="radiogroup" id="editor-copy-forms" className="editor-copy-forms" aria-label={model.text("Save a copy")}
            onKeyDown={(event) => {
              // Arrows move the choice, as in a group of radio buttons.
              const forms = copy?.forms ?? [];
              const at = forms.findIndex((entry) => entry.form === chosen?.form);
              const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
              if (!step || at < 0) return;
              event.preventDefault();
              const next = forms[(at + step + forms.length) % forms.length]!;
              setForm(next.form);
              document.getElementById(`editor-copy-${next.form}`)?.focus();
            }}>
            {copy?.forms.map((entry) => (
              <button key={entry.form} type="button" role="radio" id={`editor-copy-${entry.form}`} className="editor-copy-form"
                aria-checked={entry.form === chosen?.form} tabIndex={entry.form === chosen?.form ? 0 : -1}
                aria-describedby={`editor-copy-${entry.form}-name`} onClick={() => setForm(entry.form)}>
                <span className="choice-radio" aria-hidden="true" />
                <span className="editor-copy-text">
                  <span className="editor-copy-label">{entry.label}<span className="editor-copy-detail"> · {entry.detail}</span></span>
                  <span id={`editor-copy-${entry.form}-name`} className="editor-copy-name">{entry.fileName}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="editor-scene-row">
            <span>{model.text("Save in")}</span>
            <span className="editor-copy-folder" id="editor-copy-folder">{copy?.folder}</span>
            <Button id="editor-copy-change" variant="outline" size="sm" aria-describedby="editor-copy-folder" onClick={() => void model.chooseCopyFolder()}>
              {model.text("Change…")}
            </Button>
          </div>
          <div className="flex justify-end gap-2">
            <Button id="editor-copy-cancel" variant="outline" size="sm" onClick={() => setOpen(false)}>{model.text("Cancel")}</Button>
            <Button id="editor-copy-save" size="sm" aria-disabled={!editor.exportable} onClick={save}>{model.text("Save")}</Button>
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}
