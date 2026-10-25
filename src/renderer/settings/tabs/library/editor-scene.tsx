/**
 * An editable recording's scene in the edit view (plan 087): the camera's bubble over the picture, dragged or moved
 * with the arrow keys to where the export puts it, and the controls beside the timeline: whether the camera is shown,
 * its size, and each input's volume. The bubble is drawn with the export's own formulas (shared/camera-layout.ts, the
 * engine's camera_layout.rs) in the recording's pixels, scaled to the picture as the player shows it, and holds the
 * camera's own track, cropped as the export crops it. Moving something shows a draft at once; letting go saves it.
 *
 * Since 2026-10-25, at the maintainer's request: a handle on the corner facing the picture's middle resizes the bubble, the volumes' sliders put 100% in the
 * middle and each sound has a mute button, the controls are grouped as camera and sound, and Reset puts everything back
 * as recorded. A dragged bubble stays exactly where it is dropped, without snapping, as the Studio's (2026-10-22).
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { MoveDiagonal, MoveDiagonal2, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { bubbleRadius, bubbleRect, CAMERA_MAX_SIZE, positionFromRect, type CameraLayout } from "../../../../shared/camera-layout";
import { VOLUME_FADER_MAX, volumeFromFader, volumeToFader } from "../../../../shared/audio-volume";
import type { EditorView } from "../../../../shared/editing";
import type { EditableSound, EditScene, SceneCamera } from "../../../../shared/editable";
import { translate } from "../../../../shared/i18n";
import { Button } from "../../../components/ui/button";
import { ControlTooltip } from "../../../components/control-tooltip";
import { Slider } from "../../../components/ui/slider";
import { Switch } from "../../../components/ui/switch";
import * as model from "../../settings-controller";
import { handleCorner, resized, resizeTo, smallestLonger } from "./editor-geometry";

/** The arrow keys' steps over the free space, as the Studio's (camera-preview.tsx). */
const STEP = 0.01;
const BIG_STEP = 0.1;

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

/** The handle's size on the screen, in CSS pixels. */
const HANDLE = 20;

/** The bubble over the player's picture; nothing when the recording has no camera or it is hidden. */
export function EditorCamera({ editor }: { editor: EditorView }) {
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  const stage = useSize(overlay);
  const frame = useFrameSize(model.editorVideo);
  // What the pointer holds: the bubble (and where in it), or the resize handle.
  // A resize keeps the bubble it began from, so its fixed corner and handle do not move with the draft.
  const drag = useRef<{ pointer: number; kind: "move" | "resize"; dx: number; dy: number; start: SceneCamera } | undefined>(undefined);
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
  const corner = handleCorner(drag.current?.kind === "resize" ? drag.current.start : camera);

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
    if (grip.kind === "resize") return resizeTo(grip.start, shape, at.x, at.y, frame.width, frame.height);
    const position = positionFromRect(at.x - grip.dx, at.y - grip.dy, bubble.width, bubble.height, frame.width, frame.height);
    return { x: +clamp01(position.x).toFixed(4), y: +clamp01(position.y).toFixed(4) };
  };
  /** Takes hold of the bubble or its handle: the pointer's moves and release then come to `element`. */
  const begin = (kind: "move" | "resize", pointer: number, clientX: number, clientY: number, element: Element | null): void => {
    const at = inPicture(clientX, clientY);
    if (busy || !at || !element) return;
    drag.current = { pointer, kind, dx: at.x - bubble.x, dy: at.y - bubble.y, start: camera };
    element.setPointerCapture(pointer);
    document.getElementById("editor-camera")?.focus({ preventScroll: true });
  };
  const onPointerDown = (kind: "move" | "resize") => (event: PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    begin(kind, event.pointerId, event.clientX, event.clientY, event.currentTarget);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>): void => {
    if (drag.current?.pointer !== event.pointerId) return;
    const next = moved(event);
    if (next) place(next, false);
  };
  const onPointerUp = (event: PointerEvent<HTMLElement>): void => {
    if (drag.current?.pointer !== event.pointerId) return;
    const next = moved(event);
    drag.current = undefined;
    if (next) place(next, true);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = moves[event.key];
    if (!move || busy) return;
    event.preventDefault();
    event.stopPropagation();
    place({ x: +clamp01(camera.x + move[0]).toFixed(4), y: +clamp01(camera.y + move[1]).toFixed(4) }, true);
  };
  const percent = (value: number): number => Math.round(value * 100);
  const label = translate("Camera: {x}% across, {y}% down. Drag it, or use the arrow keys, to move it.", model.view?.language, { x: percent(camera.x), y: percent(camera.y) });
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
            data-dragging={drag.current ? true : undefined}
            style={{ ...box, borderRadius: radius }}
            onPointerDown={onPointerDown("move")}
            onKeyDown={onKeyDown}
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
          {/* The corner facing the picture's middle; the size slider is its keyboard counterpart. */}
          {!busy && (
            <span
              className="editor-camera-handle"
              aria-hidden="true"
              data-corner={`${corner.bottom ? "bottom" : "top"}-${corner.right ? "right" : "left"}`}
              title={model.text("Drag to resize")}
              style={{ left: box.left + (corner.right ? box.width : 0) - HANDLE / 2, top: box.top + (corner.bottom ? box.height : 0) - HANDLE / 2, width: HANDLE, height: HANDLE }}
              onPointerDown={onPointerDown("resize")}
              {...pointer}
            >
              {/* The resize symbol on it, its arrows along the diagonal it drags (2026-10-25: a plain circle read as nothing). */}
              {corner.bottom === corner.right ? <MoveDiagonal2 /> : <MoveDiagonal />}
            </span>
          )}
        </>
      )}
    </div>
  );
}

/** A volume's slider, 100% in the middle as the Studio's faders, with a mute button: a draft while it moves, saved when let go. */
function VolumeSlider({ id, label, value, disabled, set }: { id: string; label: string; value: number; disabled: boolean; set: (value: number, commit: boolean) => void }) {
  // The volume before a mute, which unmuting brings back.
  const before = useRef(100);
  if (value > 0) before.current = value;
  const text = `${value}%`;
  const muted = value === 0;
  const name = translate(muted ? "Unmute {label}" : "Mute {label}", model.view?.language, { label });
  return (
    <div className="editor-scene-control">
      <ControlTooltip label={name}>
        <Button id={`${id}-mute`} variant="ghost" size="icon-sm" aria-label={name} aria-pressed={muted} disabled={disabled}
          onClick={() => set(muted ? before.current : 0, true)}>
          {muted ? <VolumeX /> : <Volume2 />}
        </Button>
      </ControlTooltip>
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

/** The scene's controls under the timeline: the camera (shown, its size), each input's volume, and Reset. */
export function EditorSceneControls({ editor }: { editor: EditorView }) {
  const editable = editor.editable;
  const scene = editable && model.editorScene(editor);
  if (!editable || !scene) return null;
  // Only an export holds the scene still: a change saving meanwhile queues (controller's changeScene), so the controls
  // keep the keyboard's focus.
  const busy = editor.export.phase === "exporting";
  const change = (next: EditScene, commit: boolean): void => { void model.changeScene(next, commit); };
  const camera = scene.camera;
  const sounds = new Set<EditableSound>(editable.sounds);
  // The size is the bubble's longer side (a fraction of the picture's shorter side, as the layout's sizes are); its
  // shape is kept, so the smallest size is the one whose shorter side is still the layout's minimum.
  const smallest = camera ? Math.ceil(smallestLonger(camera.width, camera.height) * 100) : 0;
  const size = camera ? Math.round(Math.max(camera.width, camera.height) * 100) : 0;
  const resize = (next: number, commit: boolean): void => {
    if (!camera) return;
    change({ ...scene, camera: { ...camera, ...resized(camera.width, camera.height, next / 100) } }, commit);
  };
  const unchanged = model.sameScene(scene, editable.recorded);
  return (
    <div className="editor-scene" role="group" aria-label={model.text("Camera and sound")}>
      {camera && (
        <div className="editor-scene-group" role="group" aria-labelledby="editor-scene-camera">
          <span id="editor-scene-camera" className="editor-scene-heading">{model.text("Camera")}</span>
          <div className="editor-scene-control">
            <Switch
              id="editor-camera-shown"
              checked={camera.shown}
              disabled={busy}
              onCheckedChange={(shown) => change({ ...scene, camera: { ...camera, shown } }, true)}
            />
            <label htmlFor="editor-camera-shown">{model.text("Show camera")}</label>
          </div>
          <div className="editor-scene-control">
            <span aria-hidden="true">{model.text("Camera size")}</span>
            <span className="editor-scene-track">
              <Slider
                id="editor-camera-size"
                value={[size]}
                min={smallest}
                max={Math.round(CAMERA_MAX_SIZE * 100)}
                step={1}
                disabled={busy || !camera.shown}
                thumbProps={{ "aria-label": model.text("Camera size"), "aria-valuetext": `${size}%` }}
                onValueChange={(next) => { const n = first(next); if (n !== undefined) resize(n, false); }}
                onValueCommitted={(next) => { const n = first(next); if (n !== undefined) resize(n, true); }}
              />
            </span>
            <span className="editor-scene-value" aria-hidden="true">{size}%</span>
          </div>
        </div>
      )}
      <div className="editor-scene-group" role="group" aria-labelledby="editor-scene-sound">
        <span id="editor-scene-sound" className="editor-scene-heading">{model.text("Sound")}</span>
        {sounds.has("system") && (
          <VolumeSlider id="editor-volume-system" label={model.text("System audio")} value={scene.volumes.system} disabled={busy}
            set={(system, commit) => change({ ...scene, volumes: { ...scene.volumes, system } }, commit)} />
        )}
        {sounds.has("microphone") && (
          <VolumeSlider id="editor-volume-microphone" label={model.text("Microphone")} value={scene.volumes.microphone} disabled={busy}
            set={(microphone, commit) => change({ ...scene, volumes: { ...scene.volumes, microphone } }, commit)} />
        )}
      </div>
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
