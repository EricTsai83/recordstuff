/**
 * An editable recording's scene in the edit view (plan 087): the camera's bubble over the picture, dragged or moved
 * with the arrow keys to where the export puts it, and the controls beside the timeline: whether the camera is shown,
 * its size, and each input's volume. The bubble is drawn with the export's own formulas (shared/camera-layout.ts, the
 * engine's camera_layout.rs) in the recording's pixels, scaled to the picture as the player shows it, and holds the
 * camera's own track, cropped as the export crops it. Moving something shows a draft at once; letting go saves it.
 *
 * Since 2026-10-25, at the maintainer's request: a click on the bubble selects it, drawing a handle on each corner of
 * its box that resizes it from the opposite corner (a lone badge with resize arrows on one corner was
 * in the way of the picture, and read as an expand button); the volumes' sliders put 100% in the
 * middle (the left end mutes), the controls sit behind one Options button in the toolbar (since 2026-10-26, with
 * Skimming), and Reset puts everything back as recorded. A dragged bubble stays exactly where it is dropped, without snapping, as the Studio's (2026-10-22).
 *
 * Since 2026-10-26 (the maintainer's request) the camera can be hidden over stretches of the recording: while the
 * preview is in one the bubble is not drawn, as the export leaves it out, and paused there its place shows as an
 * outline that says so. The bubble's element stays meanwhile, so its camera keeps following and shows again at once.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { CircleHelp, Ellipsis, Mic, MicOff, RotateCcw, SlidersHorizontal, UserRoundX, Volume2, VolumeX } from "lucide-react";
import { bubbleRadius, bubbleRect, positionFromRect, type CameraLayout } from "../../../../shared/camera-layout";
import { VOLUME_FADER_MAX, volumeFromFader, volumeToFader } from "../../../../shared/audio-volume";
import type { EditorView } from "../../../../shared/editing";
import { cameraShownAt, cameraStretches, volumeStretchesOf, type EditableSound, type EditScene, type SceneCamera, type VolumeInput } from "../../../../shared/editable";
import { translate } from "../../../../shared/i18n";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Kbd } from "../../../components/ui/kbd";
import { ControlTooltip } from "../../../components/control-tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { Slider } from "../../../components/ui/slider";
import { Switch } from "../../../components/ui/switch";
import * as model from "../../settings-controller";
import { CORNERS, resized, resizeTo, type Corner } from "./editor-geometry";

/** The arrow keys' steps over the free space, as the Studio's (camera-preview.tsx). */
const STEP = 0.01;
const BIG_STEP = 0.1;
/** + and −'s steps of the bubble's longer side, the corner handles' keyboard counterpart (2026-10-25: the size slider went). */
const SIZE_STEP = 0.01;
const BIG_SIZE_STEP = 0.05;

/** The element's size in CSS pixels, followed as it resizes. */
function useSize(element: HTMLElement | null): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!element) return;
    const measure = (): void => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

/** The recording's picture size, once its video knows it. */
function useFrameSize(video: HTMLVideoElement | null): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!video) return;
    const read = (): void => setSize({ width: video.videoWidth, height: video.videoHeight });
    read();
    video.addEventListener("loadedmetadata", read);
    return () => video.removeEventListener("loadedmetadata", read);
  }, [video]);
  return size;
}

/**
 * Whether the camera is in the picture where the preview is, and whether the preview is paused. Followed frame by frame
 * only while the camera is hidden over some stretches; a draw happens only when either changes. The time asked about
 * stops short of `duration`: played to its end the preview reports the end itself, which no stretch holds (they end
 * there, open), so the camera came back on the last frame though the export leaves it out (Codex's computer-use round
 * of 2026-10-26); the last picture's own time is inside the stretch.
 */
function useCameraNow(camera: SceneCamera | undefined, timescale: number, duration: number): { shown: boolean; paused: boolean } {
  const video = model.editorVideo;
  const [shown, setShown] = useState(true);
  const [paused, setPaused] = useState(true);
  const stretches = camera?.shown && camera.hidden?.length ? camera : undefined;
  useEffect(() => {
    if (!video) return;
    let callback: number | undefined;
    const check = (seconds: number): void =>
      setShown(!stretches || cameraShownAt(stretches, Math.min(Math.round(seconds * timescale), duration - 1)));
    const show = (): void => {
      check(video.currentTime || 0);
      setPaused(video.paused);
    };
    const frame = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
      check(metadata.mediaTime);
      callback = video.requestVideoFrameCallback(frame);
    };
    const play = (): void => {
      setPaused(false);
      if (stretches && callback === undefined && typeof video.requestVideoFrameCallback === "function") callback = video.requestVideoFrameCallback(frame);
    };
    const pause = (): void => {
      if (callback !== undefined) video.cancelVideoFrameCallback(callback);
      callback = undefined;
      show();
    };
    const events: Array<[string, () => void]> = [["seeked", show], ["loadedmetadata", show], ["play", play], ["pause", pause], ["ended", pause], ["emptied", pause]];
    // Seeks while paused (a click on the timeline, the arrow keys) report the place before the picture is decoded.
    if (stretches) events.push(["timeupdate", show]);
    for (const [name, listener] of events) video.addEventListener(name, listener);
    show();
    if (!video.paused) play();
    return () => {
      for (const [name, listener] of events) video.removeEventListener(name, listener);
      if (callback !== undefined) video.cancelVideoFrameCallback(callback);
    };
  }, [video, stretches, timescale, duration]);
  return { shown: !camera || (camera.shown && (!stretches || shown)), paused };
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
/** A slider's value, which Base UI gives as one number or a list of them. */
const first = (value: number | readonly number[]): number | undefined => (Array.isArray(value) ? value[0] : (value as number));

/** The camera's layout for the shared formulas: the scene's size and the recording's shape. */
function layoutOf(camera: SceneCamera, shape: { rounding: number; mirror: boolean }): CameraLayout {
  return { width: camera.width, height: camera.height, rounding: shape.rounding, mirror: shape.mirror, positions: [] };
}

/** A corner handle's size on the screen, in CSS pixels: what the pointer can hit, around the dot drawn in it. */
const HANDLE = 24;
/** How far the pointer goes before a press on the bubble is a drag, not a click that selects it. */
const SLOP = 3;

/** The bubble over the player's picture; nothing when the recording has no camera or it is hidden. */
export function EditorCamera({ editor }: { editor: EditorView }) {
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  const stage = useSize(overlay);
  const frame = useFrameSize(model.editorVideo);
  // Selected while the bubble has the focus, which a press on it or a handle gives it: its frame and handles show.
  const [selected, setSelected] = useState(false);
  // What the pointer holds: the bubble (and where in it), or a corner's handle. A resize keeps the bubble it began
  // from, so its fixed corner does not move with the draft. A press that has not moved is a click, which saves nothing.
  const drag = useRef<{ pointer: number; kind: "move" | "resize"; corner?: Corner | undefined; dx: number; dy: number; start: SceneCamera; x: number; y: number; moved: boolean } | undefined>(undefined);
  // A press on the player's seek bar inside the bubble's box is a press on the bubble (below): the box and how to begin.
  const grab = useRef<{ box: DOMRect; begin: (pointer: number, x: number, y: number) => void } | undefined>(undefined);
  useEffect(() => {
    const stage = overlay?.parentElement;
    if (!stage) return;
    const press = (event: globalThis.PointerEvent): void => {
      const now = grab.current;
      const target = event.target as Element | null;
      if (!now || event.button !== 0 || !target?.closest(".pc-seek-area") || target.closest("button, input")) return;
      const { box } = now;
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) return;
      event.preventDefault();
      event.stopPropagation();
      now.begin(event.pointerId, event.clientX, event.clientY);
    };
    stage.addEventListener("pointerdown", press, true);
    return () => stage.removeEventListener("pointerdown", press, true);
  }, [overlay]);
  const editable = editor.editable;
  const scene = model.editorScene(editor);
  const camera = scene?.camera;
  const now = useCameraNow(camera, editor.timescale, editor.duration);
  // A hidden bubble leaves with the focus, which no blur reports: shown again, it is not selected.
  useEffect(() => { if (!now.shown) setSelected(false); }, [now.shown]);
  // Only an export holds the scene still: a change saving meanwhile queues (controller's changeScene), so the controls
  // keep the keyboard's focus.
  const busy = editor.export.phase === "exporting";
  // The second sound plays beside the recording whether or not a camera is shown.
  const sound = editable?.preview.secondSound
    ? <audio key={editable.preview.secondSound} ref={model.attachPreviewSound} src={editable.preview.secondSound} crossOrigin="anonymous" preload="auto" hidden />
    : null;
  if (!editable?.camera || !scene || !camera || frame.width === 0 || frame.height === 0) {
    grab.current = undefined;
    return <div ref={setOverlay} className="editor-overlay">{sound}</div>;
  }
  // The picture as the player draws it: contained in the stage, centred.
  const scale = Math.min(stage.width / frame.width, stage.height / frame.height) || 0;
  const left = (stage.width - frame.width * scale) / 2, top = (stage.height - frame.height * scale) / 2;
  const shape = editable.camera;
  const layout = layoutOf(camera, shape);
  const bubble = bubbleRect(layout, camera, frame.width, frame.height);
  const radius = bubbleRadius(layout, bubble) * scale;

  const place = (next: Partial<SceneCamera>, commit: boolean): void => {
    void model.changeScene({ ...scene, camera: { ...camera, ...next } }, commit);
  };
  /** The pointer in the picture's own pixels, as the export places the bubble. */
  const inPicture = (clientX: number, clientY: number): { x: number; y: number } | undefined => {
    const box = overlay?.getBoundingClientRect();
    if (!box || scale <= 0) return undefined;
    return { x: (clientX - box.left - left) / scale, y: (clientY - box.top - top) / scale };
  };
  const moved = (event: PointerEvent<HTMLElement>): Partial<SceneCamera> | undefined => {
    const grip = drag.current;
    const at = inPicture(event.clientX, event.clientY);
    if (!grip || !at) return undefined;
    if (grip.kind === "resize") return resizeTo(grip.start, shape, at.x, at.y, frame.width, frame.height, grip.corner!);
    const position = positionFromRect(at.x - grip.dx, at.y - grip.dy, bubble.width, bubble.height, frame.width, frame.height);
    return { x: +clamp01(position.x).toFixed(4), y: +clamp01(position.y).toFixed(4) };
  };
  /** Takes hold of the bubble or a corner's handle: the pointer's moves and release then come to `element`. */
  const begin = (kind: "move" | "resize", pointer: number, clientX: number, clientY: number, element: Element | null, corner?: Corner): void => {
    const at = inPicture(clientX, clientY);
    if (busy || !at || !element) return;
    drag.current = { pointer, kind, corner, dx: at.x - bubble.x, dy: at.y - bubble.y, start: camera, x: clientX, y: clientY, moved: false };
    element.setPointerCapture(pointer);
    document.getElementById("editor-camera")?.focus({ preventScroll: true });
  };
  const onPointerDown = (kind: "move" | "resize", corner?: Corner) => (event: PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    begin(kind, event.pointerId, event.clientX, event.clientY, event.currentTarget, corner);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>): void => {
    const grip = drag.current;
    if (grip?.pointer !== event.pointerId) return;
    if (!grip.moved && Math.hypot(event.clientX - grip.x, event.clientY - grip.y) < SLOP) return;
    grip.moved = true;
    const next = moved(event);
    if (next) place(next, false);
  };
  const onPointerUp = (event: PointerEvent<HTMLElement>): void => {
    const grip = drag.current;
    if (grip?.pointer !== event.pointerId) return;
    const next = grip.moved ? moved(event) : undefined;
    drag.current = undefined;
    if (next) place(next, true);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // + (or =, its key unshifted) and − resize it, its shape kept, from its place. By the key's place as well as its
    // character (2026-10-26, a native round): with an input method such as Zhuyin on, − reports another character.
    const grow = event.key === "+" || event.key === "=" || event.code === "Equal" || event.code === "NumpadAdd" ? 1
      : event.key === "-" || event.key === "_" || event.code === "Minus" || event.code === "NumpadSubtract" ? -1 : 0;
    if (grow !== 0 && !busy && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      const longer = Math.max(camera.width, camera.height) + grow * (event.shiftKey ? BIG_SIZE_STEP : SIZE_STEP);
      place(resized(camera.width, camera.height, longer), true);
      return;
    }
    const step = event.shiftKey ? BIG_STEP : STEP;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = moves[event.key];
    if (!move || busy) return;
    event.preventDefault();
    event.stopPropagation();
    place({ x: +clamp01(camera.x + move[0]).toFixed(4), y: +clamp01(camera.y + move[1]).toFixed(4) }, true);
  };
  const percent = (value: number): number => Math.round(value * 100);
  const label = translate("Camera: {x}% across, {y}% down, {size}% in size. Drag it or use the arrow keys to move it; drag a corner, or press + or −, to resize it.", model.view?.language, {
    x: percent(camera.x), y: percent(camera.y), size: percent(Math.max(camera.width, camera.height)),
  });
  const box = { left: left + bubble.x * scale, top: top + bubble.y * scale, width: bubble.width * scale, height: bubble.height * scale };
  // The player's shaded bars let the pointer through to the bubble, but its seek bar takes it over the picture's
  // bottom: there a press inside the bubble's box moves the bubble; the bar's buttons still take theirs.
  const origin = overlay?.getBoundingClientRect();
  grab.current = now.shown && origin && !busy
    ? { box: new DOMRect(origin.left + box.left, origin.top + box.top, box.width, box.height),
      begin: (pointer, x, y) => begin("move", pointer, x, y, document.getElementById("editor-camera")) }
    : undefined;
  const pointer = { onPointerMove, onPointerUp, onPointerCancel: () => { drag.current = undefined; } };
  return (
    <>
      <div ref={setOverlay} className="editor-overlay">
        {sound}
        {camera.shown && (
          <>
            {/* Hidden here, paused: its place as an outline that says so (2026-10-26), never while playing, as the
                export holds nothing there. */}
            {!now.shown && now.paused && (
              // It takes the pointer's press, so a press on it does not reach the player behind and play it (Codex's
              // computer-use round): nothing there to take hold of while the camera is hidden.
              <div className="editor-camera-ghost" style={{ ...box, borderRadius: radius }} aria-hidden="true"
                onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
                onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
                <UserRoundX />
                {box.width >= 96 && box.height >= 56 && <span>{model.text("Camera hidden here")}</span>}
              </div>
            )}
            <div
              id="editor-camera"
              className="editor-camera"
              role="button"
              tabIndex={now.shown ? 0 : -1}
              aria-label={label}
              aria-disabled={busy || undefined}
              aria-hidden={now.shown ? undefined : true}
              data-hidden={now.shown ? undefined : true}
              data-dragging={drag.current?.moved ? true : undefined}
              data-selected={(selected && !busy) || undefined}
              style={{ ...box, borderRadius: radius }}
              onPointerDown={onPointerDown("move")}
              onKeyDown={onKeyDown}
              onFocus={() => setSelected(true)}
              onBlur={() => setSelected(false)}
              {...pointer}
            >
              {editable.preview.camera ? (
                <video
                  key={editable.preview.camera}
                  ref={model.attachPreviewCamera}
                  src={editable.preview.camera}
                  crossOrigin="anonymous"
                  muted
                  playsInline
                  disablePictureInPicture
                  tabIndex={-1}
                  aria-hidden="true"
                  style={shape.mirror ? { transform: "scaleX(-1)" } : undefined}
                />
              ) : (
                <span className="editor-camera-waiting">{model.text("Preparing the camera…")}</span>
              )}
            </div>
          </>
        )}
      </div>
      {/* Selected, a handle on each corner of the bubble's box, with no line between them (the maintainer's choice); the
          size slider is the handles' keyboard counterpart. A layer of its own beside the bubble's, over the player's
          shaded bars, which dimmed the handles under them (a hands-on round); the bubble's stays under them. */}
      {selected && now.shown && !busy && (
        <div className="editor-overlay editor-selection">
          {CORNERS.map((corner) => (
            <span
              key={`${corner.bottom ? "bottom" : "top"}-${corner.right ? "right" : "left"}`}
              className="editor-camera-handle"
              aria-hidden="true"
              data-corner={`${corner.bottom ? "bottom" : "top"}-${corner.right ? "right" : "left"}`}
              style={{ left: box.left + (corner.right ? box.width : 0) - HANDLE / 2, top: box.top + (corner.bottom ? box.height : 0) - HANDLE / 2, width: HANDLE, height: HANDLE }}
              // The bubble keeps the focus, so it stays selected while a handle is held.
              onPointerDown={(event) => { event.preventDefault(); onPointerDown("resize", corner)(event); }}
              {...pointer}
            />
          ))}
        </div>
      )}
    </>
  );
}

/** A volume's row: its name, its slider (100% in the middle, as the Studio's faders; the left end mutes), its value. */
function VolumeRow({ id, label, value, disabled, focusRing, set }: { id: string; label: string; value: number; disabled: boolean; focusRing?: boolean; set: (value: number, commit: boolean) => void }) {
  const text = `${value}%`;
  return (
    <div className="editor-scene-row">
      <span aria-hidden="true">{label}</span>
      <span className="editor-scene-track">
        <Slider
          id={id}
          value={[volumeToFader(value)]}
          min={0}
          max={VOLUME_FADER_MAX}
          step={1}
          disabled={disabled}
          focusRing={focusRing ?? false}
          thumbProps={{ "aria-label": label, "aria-valuetext": text }}
          onValueChange={(next) => { const n = first(next); if (n !== undefined) set(volumeFromFader(n), false); }}
          onValueCommitted={(next) => { const n = first(next); if (n !== undefined) set(volumeFromFader(n), true); }}
        />
      </span>
      <span className="editor-scene-value" aria-hidden="true">{text}</span>
    </div>
  );
}

/**
 * The edit view's options behind one named button in the toolbar (2026-10-26, the maintainer's choice: what is set now
 * and then gathered in one place, so the toolbar keeps to the edits): Skimming, for every recording, and an editable
 * recording's scene in words, the camera shown or hidden (its size is the bubble's corner handles, or + and − on it),
 * each input's volume, and Reset.
 */
export function EditorOptions({ editor }: { editor: EditorView }) {
  const editable = editor.editable;
  const scene = editable && model.editorScene(editor);
  const name = model.text("More options");
  const busy = editor.export.phase === "exporting", original = model.isOriginal(editor);
  const camera = editable?.camera && scene ? scene.camera : undefined;
  const stretches = camera ? cameraStretches(camera, editor.duration).length : 0;
  const cameraNote = !camera ? "" : !camera.shown
    ? model.text("The export holds no camera. Switched off, the camera follows the timeline again.")
    : stretches === 1
    ? model.text("Hidden over one stretch of the timeline. Select a stretch and press C to hide or show the camera there.")
    : stretches > 1
    ? translate("Hidden over {count} stretches of the timeline. Select a stretch and press C to hide or show the camera there.", model.view?.language, { count: String(stretches) })
    : "";
  // Revert asks first (the maintainer's request of 2026-10-26): it clears the whole edit.
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent id="editor-revert-confirm" role="alertdialog" className="max-w-sm" showCloseButton={false}
          initialFocus={() => document.getElementById("editor-revert-cancel")}>
          <DialogHeader>
            <DialogTitle>{model.text("Revert to the original recording?")}</DialogTitle>
            <DialogDescription>
              {model.text("Every removed part, split, camera change and volume change is cleared. Undo (⌘Z) brings them back while this view is open; once it is closed, they are gone.")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button id="editor-revert-cancel" variant="outline" onClick={() => setConfirming(false)}>{model.text("Cancel")}</Button>
            <Button id="editor-revert-confirm-button" variant="destructive" onClick={() => { setConfirming(false); void model.revertToOriginal(); }}>
              {model.text("Revert")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Popover>
        <ControlTooltip label={name}>
          <PopoverTrigger render={<Button variant="ghost" size="icon" />} id="editor-options" className="editor-options-button" aria-label={name}>
            <Ellipsis aria-hidden="true" />
          </PopoverTrigger>
        </ControlTooltip>
        <PopoverContent side="top" align="end" id="editor-options-popup" className="editor-options-popup w-auto max-h-(--available-height) max-w-[calc(100vw-24px)] overflow-x-hidden overflow-y-auto gap-0 p-3" aria-label={name}
          initialFocus={() => document.getElementById("editor-skim")}>
          {/* What is set once and seldom again (the maintainer's review of 2026-10-26: the overall volumes, adjusted while
              listening, have a panel of their own that stays open as the preview plays). */}
          <div className="editor-options" role="group" aria-label={name}>
            <div className="editor-options-group">
              <div className="editor-scene-row">
                <label htmlFor="editor-skim">{model.text("Skimming")}</label>
                <OptionInfo id="editor-skim-note" text={model.text("Move over the timeline to preview; moving away returns to the playhead, and a click sets it.")} />
                <Switch id="editor-skim" checked={model.skimming} aria-describedby="editor-skim-note" onCheckedChange={() => model.toggleSkimming()} />
              </div>
              {camera && (
                <>
                  <div className="editor-scene-row">
                    <label htmlFor="editor-camera-hidden">{model.text("Hide camera view")}</label>
                    <OptionInfo id="editor-camera-tip" text={model.text("To hide it for a while only, select that stretch on the timeline and press C.")} />
                    <Switch id="editor-camera-hidden" checked={!camera.shown} disabled={busy}
                      aria-describedby={cameraNote ? "editor-camera-note" : "editor-camera-tip"}
                      onCheckedChange={(hidden) => { void model.hideCameraThroughout(hidden); }} />
                  </div>
                  {/* Said in words only when it tells what the export holds now: hidden throughout, or over stretches. */}
                  {cameraNote && <p id="editor-camera-note" className="editor-options-note">{cameraNote}</p>}
                </>
              )}
            </div>
            {editable && scene && <LaneControls editor={editor} scene={scene} />}
            <div className="editor-options-revert">
              <Button id="editor-revert" variant="outline" size="sm" aria-disabled={busy || original} aria-describedby="editor-revert-note"
                onClick={() => { if (!busy && !original) setConfirming(true); }}>
                {model.text("Revert to original recording…")}
              </Button>
              {original && <p id="editor-revert-note" className="editor-options-note">{model.text("Nothing is edited yet.")}</p>}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}

/** A note behind an ⓘ (2026-10-26, version A): its words on hover or focus, and read with the control it describes. */
function OptionInfo({ id, text }: { id: string; text: string }) {
  // The app's help icon, as the settings', the Studio's and onboarding's, and at once on hover: it is there only to be
  // read (2026-10-27, the maintainer's review: the controls' usual delay read as nothing happening).
  return (
    <ControlTooltip label={text} delay={0}>
      <span className="editor-options-info" tabIndex={0} aria-label={text}>
        <CircleHelp aria-hidden="true" />
        <span id={id} className="sr-only">{text}</span>
      </span>
    </ControlTooltip>
  );
}

/**
 * The lanes under the timeline, each shown or hidden (2026-10-26, the maintainer's request: an input whose volume is not
 * being changed need not take room), remembered for the next edit views. A hidden lane still holding stretches says so:
 * the export applies them all the same.
 */
function LaneControls({ editor, scene }: { editor: EditorView; scene: EditScene }) {
  // Each named as a track of the timeline, so the switches read as showing a track, not as the camera or a sound
  // themselves (2026-10-27, the maintainer's review).
  const lanes: Array<{ lane: model.Lane; name: string; track: string; held: number }> = [
    ...(editor.editable?.camera && scene.camera ? [{ lane: "camera" as const, name: model.text("Camera"), track: model.text("Camera track"), held: cameraStretches(scene.camera, editor.duration).length }] : []),
    ...model.volumeInputs(editor).map((input) => ({
      lane: input, name: model.text(input === "system" ? "System audio" : "Microphone"),
      track: model.text(input === "system" ? "System audio track" : "Microphone track"), held: volumeStretchesOf(scene, input).length,
    })),
  ];
  if (lanes.length === 0) return null;
  return (
    <div className="editor-options-group editor-lanes" role="group" aria-label={model.text("Show on the timeline")}>
      <div className="editor-scene-row editor-options-title-row">
        <p className="editor-options-title">{model.text("Show on the timeline")}</p>
        <OptionInfo id="editor-lanes-note" text={model.text("Only what the timeline shows: a hidden track is still exported.")} />
      </div>
      {lanes.map(({ lane, name, track, held }) => {
        const shown = model.laneShown(lane);
        return (
          <div key={lane} className="editor-options-skim">
            <div className="editor-scene-row">
              <label htmlFor={`editor-lane-${lane}`}>{track}</label>
              {/* Named in full for assistive technology, which would otherwise hear two controls named as an input; in the
                  app's own colours, as every switch is (2026-10-27, the maintainer's review: a grey one read as another kind). */}
              <Switch id={`editor-lane-${lane}`} checked={shown} aria-label={translate("Show the {name} lane", model.view?.language, { name })}
                aria-describedby={!shown && held > 0 ? `editor-lane-${lane}-note` : undefined}
                onCheckedChange={(next) => model.showLane(lane, next)} />
            </div>
            {!shown && held > 0 && (
              <p id={`editor-lane-${lane}-note`} className="editor-options-note">
                {held === 1 ? model.text("Hidden; its one stretch of its own still applies to the export.")
                  : translate("Hidden; its {count} stretches of their own still apply to the export.", model.view?.language, { count: String(held) })}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The overall volumes (2026-10-26, the maintainer's review of the options): what every part of the timeline without a
 * volume of its own plays at, in a panel of their own that stays open while the preview plays, so a volume is set by
 * ear: a press on Play, the timeline or anywhere in the edit view leaves it open, Space plays or pauses from it, and its
 * button, Escape or a press outside the view closes it. Reset puts both back to 100% and touches nothing set on the
 * timeline.
 */
export function OverallVolume({ editor }: { editor: EditorView }) {
  const editable = editor.editable;
  const scene = editable && model.editorScene(editor);
  const [open, setOpen] = useState(false);
  // Escape closes it first, wherever the focus is in the view (a native round of 2026-10-26: with the focus moved on to
  // Play, Escape left it open), before the view's own Escape lets go of a selection.
  useEffect(() => {
    if (!open) return;
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [open]);
  if (!editable || !scene) return null;
  const sounds = new Set<EditableSound>(editable.sounds);
  if (!sounds.has("system") && !sounds.has("microphone")) return null;
  const busy = editor.export.phase === "exporting";
  const change = (next: EditScene, commit: boolean): void => { void model.changeScene(next, commit); };
  const atFull = scene.volumes.system === 100 && scene.volumes.microphone === 100;
  const name = model.text("Overall volume");
  return (
    <Popover open={open} onOpenChange={(next, details) => {
      // Left open by a press, or the focus, moving elsewhere in the edit view (Play, the timeline): the volume is set
      // while listening (a native round of 2026-10-26 found Play closing it).
      if (!next && (details.reason === "outside-press" || details.reason === "focus-out")) {
        const event = details.event as (Event & { relatedTarget?: EventTarget | null }) | undefined;
        const target = details.reason === "focus-out" ? event?.relatedTarget : event?.target;
        if (!(target instanceof Node) || document.getElementById("editor")?.contains(target)) return;
      }
      setOpen(next);
    }}>
      <ControlTooltip label={name}>
        <PopoverTrigger render={<Button variant="ghost" size="sm" />} id="editor-mix" className="editor-mix-button" aria-label={name}>
          <SlidersHorizontal aria-hidden="true" />
          <span className="editor-tool-label">{name}</span>
        </PopoverTrigger>
      </ControlTooltip>
      <PopoverContent side="top" align="end" id="editor-mix-popup" className="editor-mix-popup w-auto max-w-[calc(100vw-24px)] gap-0 p-3" aria-label={name}
        // Focus on the first volume, not on the ⓘ before it, whose note would open and take the first Escape.
        initialFocus={() => document.querySelector<HTMLElement>('#editor-mix-popup input[type="range"]')}
        onKeyDown={(event) => {
          // Space plays or pauses from here as on the timeline, so a volume is tried without leaving it.
          if (event.key === " " && !(event.target instanceof HTMLButtonElement)) {
            event.preventDefault();
            model.togglePlayback();
          }
        }}>
        <div className="editor-mix" role="group" aria-label={name}>
          <div className="editor-scene-row editor-options-title-row">
            <p className="editor-options-title">{name}</p>
            <OptionInfo id="editor-volume-note" text={model.text("Every part of the timeline without a volume of its own plays at these; set one with Volume (V).")} />
            <Button id="editor-mix-reset" variant="ghost" size="sm" aria-disabled={busy || atFull} aria-label={model.text("Reset both volumes to 100%")}
              onClick={() => { if (!busy && !atFull) void model.resetOverallVolumes(); }}>
              <RotateCcw aria-hidden="true" />
              {model.text("Reset")}
            </Button>
          </div>
          {sounds.has("system") && (
            <VolumeRow id="editor-volume-system" focusRing label={model.text("System audio")} value={scene.volumes.system} disabled={busy}
              set={(system, commit) => change({ ...scene, volumes: { ...scene.volumes, system } }, commit)} />
          )}
          {sounds.has("microphone") && (
            <VolumeRow id="editor-volume-microphone" focusRing label={model.text("Microphone")} value={scene.volumes.microphone} disabled={busy}
              set={(microphone, commit) => change({ ...scene, volumes: { ...scene.volumes, microphone } }, commit)} />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The Volume button and its popup (2026-10-26, the maintainer's request): each input the recording holds at a volume
 * of its own over the selected range or part, by a slider (100% in the middle, as the Studio's faders) or Mute, and Back
 * to the overall volume there; the input whose lane was clicked comes first. Named in words beside its icon while the
 * toolbar has room, as the camera's button. Each change is one Undo takes back; a slider is heard as it moves.
 */
export function VolumeButton({ editor }: { editor: EditorView }) {
  const target = model.cameraTarget(editor);
  const busy = editor.export.phase === "exporting";
  const inputs = model.volumeInputs(editor);
  const order = model.laneInput && inputs.includes(model.laneInput) ? [model.laneInput, ...inputs.filter((input) => input !== model.laneInput)] : inputs;
  const open = model.volumeOpen && Boolean(target) && !busy;
  const tip = model.text(target ? "Set the volume of the selection (V)" : "Select a part or drag across the timeline, then set its volume (V)");
  return (
    <Popover open={open} onOpenChange={(next) => { if (!next || (target && !busy)) model.setVolumeOpen(next); }}>
      <ControlTooltip label={tip}>
        <PopoverTrigger
          render={<Button variant="ghost" size="sm" className="editor-camera-toggle editor-volume-toggle" />}
          id="editor-volume"
          aria-label={model.text("Volume of the selection")}
          aria-disabled={busy || !target}
        >
          <Volume2 aria-hidden="true" />
          <span className="editor-camera-toggle-label">{model.text("Volume")}</span>
          <Kbd aria-hidden="true">V</Kbd>
        </PopoverTrigger>
      </ControlTooltip>
      <PopoverContent side="top" align="start" id="editor-volume-popup" className="editor-options-popup w-auto max-h-(--available-height) max-w-[calc(100vw-24px)] overflow-x-hidden overflow-y-auto gap-0 p-3" aria-label={model.text("Volume of the selection")}>
        {target && (
          <div className="editor-options editor-volume-options" role="group" aria-label={model.text("Volume of the selection")}>
            <p className="editor-keys-title">
              {translate("Volume from {from} to {to}", model.view?.language, { from: model.clock(target[0] / editor.timescale), to: model.clock(target[1] / editor.timescale) })}
            </p>
            {order.map((input) => <SelectionVolumeRow key={input} editor={editor} input={input} />)}
            <Button id="editor-volume-back" variant="ghost" size="sm" className="editor-scene-reset" aria-disabled={busy}
              onClick={() => { if (!busy) void model.resetVolumesInSelection(); }}>
              <RotateCcw />
              {model.text("Back to the overall volume")}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** One input's row in the Volume popup: its name, Mute, its slider over the selection and its value. */
function SelectionVolumeRow({ editor, input }: { editor: EditorView; input: VolumeInput }) {
  const value = model.volumeOverSelection(editor, input) ?? 100;
  const own = model.editorScene(editor)?.volumes[input] ?? 100;
  const name = model.text(input === "system" ? "System audio" : "Microphone");
  const muted = value === 0;
  const Icon = input === "system" ? (muted ? VolumeX : Volume2) : (muted ? MicOff : Mic);
  const text = `${value}%`;
  return (
    <div className="editor-scene-row editor-volume-row">
      <span aria-hidden="true">{name}</span>
      <ControlTooltip label={model.text(muted ? "Unmute in the selection" : "Mute in the selection")}>
        <Button id={`editor-volume-mute-${input}`} variant="ghost" size="icon-sm" aria-pressed={muted}
          aria-label={translate(muted ? "Unmute {name} in the selection" : "Mute {name} in the selection", model.view?.language, { name })}
          // Unmuted, back to the input's own volume, or to 100% where that is silent itself, so Unmute is always heard
          // (Codex's review); Back to the overall volume stays the way to its own volume whatever it is.
          onClick={() => { void model.setVolumeInSelection(input, muted ? (own > 0 ? undefined : 100) : 0, true); }}>
          <Icon />
        </Button>
      </ControlTooltip>
      <span className="editor-scene-track">
        <Slider
          id={`editor-volume-selection-${input}`}
          value={[volumeToFader(value)]}
          min={0}
          max={VOLUME_FADER_MAX}
          step={1}
          thumbProps={{ "aria-label": name, "aria-valuetext": text }}
          onValueChange={(next) => { const n = first(next); if (n !== undefined) void model.setVolumeInSelection(input, volumeFromFader(n), false); }}
          onValueCommitted={(next) => { const n = first(next); if (n !== undefined) void model.setVolumeInSelection(input, volumeFromFader(n), true); }}
        />
      </span>
      <span className="editor-scene-value" aria-hidden="true">{text}</span>
    </div>
  );
}
