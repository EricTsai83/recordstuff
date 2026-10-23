/**
 * The Camera section's preview (plan 075 step 7): the display the recording will capture, to scale, and the bubble
 * where the recording composes it, by the same formulas (camera-layout.ts, D2). The bubble is dragged, or moved with the
 * arrow keys, to exactly where it is let go of, with no snapping to the edges or the centre (2026-10-22, at the
 * maintainer's request); that place is the choice sent to main, so one drag is one save, also while recording (D7).
 *
 * Before recording the bubble shows the camera itself, opened only while the preview is in sight (D6); while a
 * recording composes the camera, the page asks main for the engine's preview of the whole picture (D17), also only
 * while in sight, and the bubble is dragged over it unseen, with a word under the picture when the camera gives none.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { CameraPreviewView, SettingsGroup } from "../../../shared/settings-panel";
import { bubbleRadius, bubbleRect, positionFromRect, type CameraLayout, type CameraPosition } from "../../../shared/camera-layout";
import { previewDecoder } from "../../lib/preview-decoder";
import { translate } from "../../../shared/i18n";
import { usePendingValue } from "../../lib/use-pending-value";
import * as model from "../settings-controller";
import { frameDrawn } from "./frame-clock";
import { onPreview, previewFigures } from "./studio-feed";

/** A key's step, as a fraction of the free space: 1%, or 10% with Shift. */
const STEP = 0.01, BIG_STEP = 0.1;
/** The smallest target a pointer drags, in CSS pixels, however small the bubble is drawn. */
const HANDLE_MIN = 24;
/** The choice sent: a fraction with at most four decimals, which main reads back exactly. */
const choiceOf = (position: CameraPosition): string => `${+position.x.toFixed(4)},${+position.y.toFixed(4)}`;
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Whether `element` is in sight: in the window's view and the window not hidden. */
function useInSight(element: HTMLElement | null): boolean {
  const [inView, setInView] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const changed = (): void => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => setInView(entries.some((entry) => entry.isIntersecting)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return inView && visible;
}

/** The stage's size in CSS pixels, followed as it resizes. */
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

/**
 * The camera itself, from Chromium's own list, matched to the chosen camera by name; the default when none matches.
 * Nothing is opened once `ended` says the preview no longer wants it, which listing the cameras may take long enough for.
 */
async function openCamera(name: string | undefined, ended: () => boolean): Promise<MediaStream | undefined> {
  const size = { width: { ideal: 640 }, height: { ideal: 360 } };
  if (name) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (ended()) return undefined;
    const match = devices.find((device) => device.kind === "videoinput" && (device.label === name || device.label.startsWith(`${name} (`)));
    if (match) return navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: match.deviceId }, ...size }, audio: false });
  }
  return navigator.mediaDevices.getUserMedia({ video: size, audio: false });
}

/** The camera in the bubble while `on`: opened as it turns on, every track stopped as it turns off (D6). */
function useLiveCamera(video: HTMLVideoElement | null, on: boolean, name: string | undefined): boolean {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!on || !video || !navigator.mediaDevices?.getUserMedia) return;
    let stream: MediaStream | undefined;
    let ended = false;
    void openCamera(name, () => ended).then((opened) => {
      if (!opened) return;
      if (ended) {
        for (const track of opened.getTracks()) track.stop();
        return;
      }
      stream = opened;
      video.srcObject = opened;
      void video.play().catch(() => undefined);
    }, () => { if (!ended) setFailed(true); });
    return () => {
      ended = true;
      for (const track of stream?.getTracks() ?? []) track.stop();
      video.srcObject = null;
    };
  }, [video, on, name]);
  return failed;
}

/** The recording's preview drawn into `canvas` while `on`: main joins the page to it, on the Studio's port (studio-feed.ts). */
function useRecordingPreview(canvas: HTMLCanvasElement | null, on: boolean): boolean {
  const [drawing, setDrawing] = useState(false);
  useEffect(() => {
    setDrawing(false);
    if (!on || !canvas) return;
    // Once: a state set for every frame drawn renders the page 10 times a second for nothing.
    let seen = false;
    const decoder = previewDecoder(canvas, {
      drawn: (_message, received) => { if (previewFigures.keeping) previewFigures.drawn(received, Date.now()); frameDrawn(); if (!seen) { seen = true; setDrawing(true); } },
      skipped: () => previewFigures.notDecoded(),
      restarted: (cause) => previewFigures.restarted(cause),
    });
    if (!decoder) return;
    // On the Studio's port, which the meters' levels share (plan 081).
    const stop = onPreview({ chunk: (message) => decoder.decode(message), joined: () => decoder.reset() });
    void window.settings.watchCameraPreview?.(true).catch(() => undefined);
    return () => {
      void window.settings.watchCameraPreview?.(false).catch(() => undefined);
      stop();
      decoder.close();
    };
  }, [canvas, on]);
  return drawing;
}

export function CameraPreview({ group, preview, disabled, describedBy, overlay }: {
  group: SettingsGroup; preview: CameraPreviewView; disabled: boolean; describedBy: string | undefined;
  /** A control laid over the picture, as the Studio's Live preview is. */
  overlay?: ReactNode;
}) {
  const id = `setting-${group.id}`;
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const inSight = useInSight(stage);
  const size = useSize(stage);
  const failed = useLiveCamera(video, preview.mode === "live" && inSight, preview.camera);
  const drawing = useRecordingPreview(canvas, preview.mode === "recording" && inSight);
  /** Where the bubble shows while it is moved or its new place saves; the view's place otherwise. */
  const { shown: position, move: setMoving, commit: save } = usePendingValue<CameraPosition>({ x: preview.x, y: preview.y }, (a, b) => a.x === b.x && a.y === b.y);
  const drag = useRef<{ pointer: number; dx: number; dy: number } | undefined>(undefined);
  const shape: CameraLayout = { ...preview.bubble, positions: [] };
  const bubble = bubbleRect(shape, position, Math.max(1, size.width), Math.max(1, size.height));
  const radius = bubbleRadius(shape, bubble);
  // Centred on the bubble and kept inside the stage, whose edge would clip it from the pointer.
  const grow = (size: number, room: number): number => Math.min(Math.max(size, HANDLE_MIN), Math.max(size, room));
  const inside = (at: number, size: number, room: number): number => Math.min(Math.max(at, 0), Math.max(0, room - size));
  const handleWidth = grow(bubble.width, size.width), handleHeight = grow(bubble.height, size.height);
  const handle = { width: handleWidth, height: handleHeight,
    x: inside(bubble.x - (handleWidth - bubble.width) / 2, handleWidth, size.width),
    y: inside(bubble.y - (handleHeight - bubble.height) / 2, handleHeight, size.height) };

  const commit = (next: CameraPosition): void => save(next, (place) => model.choose(group.id, choiceOf(place), id));
  const placed = (clientX: number, clientY: number): CameraPosition | undefined => {
    const box = stage?.getBoundingClientRect();
    const grip = drag.current;
    if (!stage || !box || !grip) return undefined;
    // The bubble is placed in the stage's content box, inside its bezel.
    const left = box.left + stage.clientLeft, top = box.top + stage.clientTop;
    return positionFromRect(clientX - left - grip.dx, clientY - top - grip.dy, bubble.width, bubble.height, stage.clientWidth, stage.clientHeight);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (disabled || event.button !== 0) return;
    const box = stage?.getBoundingClientRect();
    if (!stage || !box) return;
    // The grip is kept from the bubble's own corner, which a larger target around a small one is not.
    drag.current = { pointer: event.pointerId, dx: event.clientX - (box.left + stage.clientLeft + bubble.x), dy: event.clientY - (box.top + stage.clientTop + bubble.y) };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointer !== event.pointerId) return;
    const next = placed(event.clientX, event.clientY);
    if (next) setMoving(next);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointer !== event.pointerId) return;
    const next = placed(event.clientX, event.clientY);
    drag.current = undefined;
    if (next) commit(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = moves[event.key];
    if (!move || disabled) return;
    event.preventDefault();
    commit({ x: +clamp01(position.x + move[0]).toFixed(4), y: +clamp01(position.y + move[1]).toFixed(4) });
  };

  const live = preview.mode === "live" && !failed;
  const status = failed ? model.text("The camera could not be shown here.")
    : preview.mode === "recording" && !drawing ? undefined : preview.status;
  return (
    <div className="camera-preview" data-mode={preview.mode}>
      <div
        ref={setStage}
        className="camera-preview-stage"
        style={{ aspectRatio: `${preview.display.width} / ${preview.display.height}`, ["--preview-ratio" as string]: preview.display.width / preview.display.height }}
      >
        <canvas ref={setCanvas} className="camera-preview-picture" hidden={preview.mode !== "recording"} aria-hidden="true" />
        {preview.composed && <div
          className="camera-preview-bubble"
          data-live={live || undefined}
          aria-hidden="true"
          style={{ left: bubble.x, top: bubble.y, width: bubble.width, height: bubble.height, borderRadius: radius }}
        >
          <video
            ref={setVideo}
            className="camera-preview-camera"
            hidden={!live}
            muted
            playsInline
            aria-hidden="true"
            style={preview.bubble.mirror ? { transform: "scaleX(-1)" } : undefined}
          />
        </div>}
        {/* What is dragged: the bubble, or a target of at least HANDLE_MIN pixels centred on it when it is drawn smaller. */}
        {preview.composed && <div
          id={id}
          className="camera-preview-handle"
          role="application"
          aria-roledescription={model.text("Camera position")}
          aria-label={group.label}
          aria-describedby={[`${id}-position`, describedBy].filter(Boolean).join(" ")}
          aria-disabled={disabled || undefined}
          tabIndex={disabled ? -1 : 0}
          style={{ left: handle.x, top: handle.y, width: handle.width, height: handle.height, borderRadius: Math.min(radius, handle.width / 2, handle.height / 2) }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => { drag.current = undefined; setMoving(undefined); }}
          onKeyDown={onKeyDown}
        />}
        {status && <p className="camera-preview-status">{status}</p>}
        {overlay}
      </div>
      <span id={`${id}-position`} className="sr-only">
        {translate("{x}% from the left, {y}% from the top", model.view?.language, { x: Math.round(position.x * 100), y: Math.round(position.y * 100) })}
      </span>
    </div>
  );
}
