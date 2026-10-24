/**
 * An editable recording's scene in the edit view (plan 087): the camera's bubble over the picture, dragged or moved
 * with the arrow keys to where the export puts it, and the controls beside the timeline: whether the camera is shown,
 * its size, and each input's volume. The bubble is drawn with the export's own formulas (shared/camera-layout.ts, the
 * engine's camera_layout.rs) in the recording's pixels, scaled to the picture as the player shows it, and holds the
 * camera's own track, cropped as the export crops it. Moving something shows a draft at once; letting go saves it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { bubbleRadius, bubbleRect, CAMERA_MAX_SIZE, CAMERA_MIN_SIZE, positionFromRect, type CameraLayout } from "../../../../shared/camera-layout";
import { AUDIO_VOLUME_MAX, AUDIO_VOLUME_STEP } from "../../../../shared/audio-volume";
import type { EditorView } from "../../../../shared/editing";
import type { EditableSound, EditScene, SceneCamera } from "../../../../shared/editable";
import { translate } from "../../../../shared/i18n";
import { Slider } from "../../../components/ui/slider";
import { Switch } from "../../../components/ui/switch";
import * as model from "../../settings-controller";

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

/** The bubble over the player's picture; nothing when the recording has no camera or it is hidden. */
export function EditorCamera({ editor }: { editor: EditorView }) {
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  const stage = useSize(overlay);
  const frame = useFrameSize(model.editorVideo);
  const drag = useRef<{ pointer: number; dx: number; dy: number } | undefined>(undefined);
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
    return <div ref={setOverlay} className="editor-overlay">{sound}</div>;
  }
  // The picture as the player draws it: contained in the stage, centred.
  const scale = Math.min(stage.width / frame.width, stage.height / frame.height) || 0;
  const left = (stage.width - frame.width * scale) / 2, top = (stage.height - frame.height * scale) / 2;
  const layout = layoutOf(camera, editable.camera);
  const bubble = bubbleRect(layout, camera, frame.width, frame.height);
  const radius = bubbleRadius(layout, bubble) * scale;

  const place = (next: { x: number; y: number }, commit: boolean): void => {
    void model.changeScene({ ...scene, camera: { ...camera, x: +clamp01(next.x).toFixed(4), y: +clamp01(next.y).toFixed(4) } }, commit);
  };
  const placed = (clientX: number, clientY: number): { x: number; y: number } | undefined => {
    const box = overlay?.getBoundingClientRect();
    const grip = drag.current;
    if (!box || !grip || scale <= 0) return undefined;
    // From the picture's own pixels, as the export places the bubble.
    const x = (clientX - box.left - left - grip.dx) / scale, y = (clientY - box.top - top - grip.dy) / scale;
    return positionFromRect(x, y, bubble.width, bubble.height, frame.width, frame.height);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    const box = overlay?.getBoundingClientRect();
    if (busy || event.button !== 0 || !box) return;
    drag.current = { pointer: event.pointerId, dx: event.clientX - box.left - left - bubble.x * scale, dy: event.clientY - box.top - top - bubble.y * scale };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointer !== event.pointerId) return;
    const next = placed(event.clientX, event.clientY);
    if (next) place(next, false);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointer !== event.pointerId) return;
    const next = placed(event.clientX, event.clientY);
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
    place({ x: camera.x + move[0], y: camera.y + move[1] }, true);
  };
  const percent = (value: number): number => Math.round(value * 100);
  const label = translate("Camera: {x}% across, {y}% down. Drag it, or use the arrow keys, to move it.", model.view?.language, { x: percent(camera.x), y: percent(camera.y) });
  return (
    <div ref={setOverlay} className="editor-overlay">
      {sound}
      {camera.shown && (
        <div
          id="editor-camera"
          className="editor-camera"
          role="button"
          tabIndex={0}
          aria-label={label}
          aria-disabled={busy || undefined}
          data-dragging={drag.current ? true : undefined}
          style={{ left: left + bubble.x * scale, top: top + bubble.y * scale, width: bubble.width * scale, height: bubble.height * scale, borderRadius: radius }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => { drag.current = undefined; }}
          onKeyDown={onKeyDown}
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
              style={editable.camera.mirror ? { transform: "scaleX(-1)" } : undefined}
            />
          ) : (
            <span className="editor-camera-waiting">{model.text("Preparing the camera…")}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** A volume slider: a draft while it moves, saved when let go. */
function VolumeSlider({ id, label, value, disabled, set }: { id: string; label: string; value: number; disabled: boolean; set: (value: number, commit: boolean) => void }) {
  const text = `${value}%`;
  return (
    <div className="editor-scene-control">
      <span aria-hidden="true">{label}</span>
      <span className="editor-scene-track">
        <Slider
          id={id}
          value={[value]}
          min={0}
          max={AUDIO_VOLUME_MAX}
          step={AUDIO_VOLUME_STEP}
          disabled={disabled}
          thumbProps={{ "aria-label": label, "aria-valuetext": text }}
          onValueChange={(next) => { const n = first(next); if (n !== undefined) set(n, false); }}
          onValueCommitted={(next) => { const n = first(next); if (n !== undefined) set(n, true); }}
        />
      </span>
      <span className="editor-scene-value" aria-hidden="true">{text}</span>
    </div>
  );
}

/** The scene's controls beside the timeline: the camera shown or not and its size, then each input's volume. */
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
  const ratio = camera ? camera.height / camera.width : 1;
  const smallest = Math.ceil(CAMERA_MIN_SIZE * Math.max(ratio, 1 / ratio) * 100);
  const size = camera ? Math.round(Math.max(camera.width, camera.height) * 100) : 0;
  const resize = (next: number, commit: boolean): void => {
    if (!camera) return;
    const longer = Math.min(CAMERA_MAX_SIZE, Math.max(smallest / 100, next / 100));
    const width = ratio >= 1 ? longer / ratio : longer, height = ratio >= 1 ? longer : longer * ratio;
    change({ ...scene, camera: { ...camera, width: +width.toFixed(4), height: +height.toFixed(4) } }, commit);
  };
  return (
    <div className="editor-scene" role="group" aria-label={model.text("Camera and sound")}>
      {camera && (
        <>
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
          </div>
        </>
      )}
      {sounds.has("system") && (
        <VolumeSlider id="editor-volume-system" label={model.text("System audio")} value={scene.volumes.system} disabled={busy}
          set={(system, commit) => change({ ...scene, volumes: { ...scene.volumes, system } }, commit)} />
      )}
      {sounds.has("microphone") && (
        <VolumeSlider id="editor-volume-microphone" label={model.text("Microphone")} value={scene.volumes.microphone} disabled={busy}
          set={(microphone, commit) => change({ ...scene, volumes: { ...scene.volumes, microphone } }, commit)} />
      )}
    </div>
  );
}
