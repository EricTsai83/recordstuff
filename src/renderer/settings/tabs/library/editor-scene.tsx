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
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { RotateCcw, SlidersHorizontal } from "lucide-react";
import { bubbleRadius, bubbleRect, positionFromRect, type CameraLayout } from "../../../../shared/camera-layout";
import { VOLUME_FADER_MAX, volumeFromFader, volumeToFader } from "../../../../shared/audio-volume";
import type { EditorView } from "../../../../shared/editing";
import type { EditableSound, EditScene, SceneCamera } from "../../../../shared/editable";
import { translate } from "../../../../shared/i18n";
import { Button } from "../../../components/ui/button";
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
  // A hidden bubble leaves with the focus, which no blur reports: shown again, it is not selected.
  useEffect(() => { if (!camera?.shown) setSelected(false); }, [camera?.shown]);
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
    // + (or =, its key unshifted) and − resize it, its shape kept, from its place.
    const grow = event.key === "+" || event.key === "=" ? 1 : event.key === "-" || event.key === "_" ? -1 : 0;
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
  grab.current = camera.shown && origin && !busy
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
            <div
              id="editor-camera"
              className="editor-camera"
              role="button"
              tabIndex={0}
              aria-label={label}
              aria-disabled={busy || undefined}
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
      {selected && camera.shown && !busy && (
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
function VolumeRow({ id, label, value, disabled, set }: { id: string; label: string; value: number; disabled: boolean; set: (value: number, commit: boolean) => void }) {
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
  const name = model.text("Options");
  return (
    <>
      <span className="editor-divider" aria-hidden="true" />
      <Popover>
        <PopoverTrigger render={<Button variant="ghost" size="sm" />} id="editor-options" className="editor-options-button">
          <SlidersHorizontal aria-hidden="true" />
          {name}
        </PopoverTrigger>
        <PopoverContent side="top" align="start" id="editor-options-popup" className="editor-options-popup w-auto gap-0 p-3" aria-label={name}>
          <div className="editor-options" role="group" aria-label={name}>
            {/* Skimming, on by default (2026-10-25), and what it does under its switch. */}
            <div className="editor-options-skim">
              <div className="editor-scene-row">
                <label htmlFor="editor-skim">{model.text("Skimming")}</label>
                <Switch id="editor-skim" checked={model.skimming} aria-describedby="editor-skim-note" onCheckedChange={() => model.toggleSkimming()} />
              </div>
              <p id="editor-skim-note" className="editor-options-note">{model.text("Move over the timeline to preview; moving away returns to the playhead, and a click sets it.")}</p>
            </div>
            {editable && scene && <SceneControls editor={editor} editable={editable} scene={scene} />}
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}

/** An editable recording's camera and volumes, and Reset, in the options' popup. */
function SceneControls({ editor, editable, scene }: { editor: EditorView; editable: NonNullable<EditorView["editable"]>; scene: EditScene }) {
  // Only an export holds the scene still: a change saving meanwhile queues (controller's changeScene), so the controls
  // keep the keyboard's focus.
  const busy = editor.export.phase === "exporting";
  const change = (next: EditScene, commit: boolean): void => { void model.changeScene(next, commit); };
  const camera = scene.camera;
  const sounds = new Set<EditableSound>(editable.sounds);
  const unchanged = model.sameScene(scene, editable.recorded);
  return (
    <div className="editor-scene" role="group" aria-label={model.text(camera ? "Camera and sound" : "Sound")}>
      {camera && (
        <div className="editor-scene-row">
          <label htmlFor="editor-camera-shown">{model.text("Show camera")}</label>
          <Switch
            id="editor-camera-shown"
            checked={camera.shown}
            disabled={busy}
            onCheckedChange={(shown) => change({ ...scene, camera: { ...camera, shown } }, true)}
          />
        </div>
      )}
      {sounds.has("system") && (
        <VolumeRow id="editor-volume-system" label={model.text("System audio")} value={scene.volumes.system} disabled={busy}
          set={(system, commit) => change({ ...scene, volumes: { ...scene.volumes, system } }, commit)} />
      )}
      {sounds.has("microphone") && (
        <VolumeRow id="editor-volume-microphone" label={model.text("Microphone")} value={scene.volumes.microphone} disabled={busy}
          set={(microphone, commit) => change({ ...scene, volumes: { ...scene.volumes, microphone } }, commit)} />
      )}
      <ControlTooltip label={model.text("Put the camera and the volumes back as recorded")}>
        <Button id="editor-scene-reset" variant="ghost" size="sm" className="editor-scene-reset" aria-disabled={busy || unchanged}
          onClick={() => { if (!busy && !unchanged) void model.resetScene(); }}>
          <RotateCcw />
          {model.text(camera ? "Reset camera and volumes" : "Reset volumes")}
        </Button>
      </ControlTooltip>
    </div>
  );
}
