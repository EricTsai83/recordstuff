/**
 * The full-screen viewer's edit (2026-10-27): played as the edit view's preview plays it (`edited-playback.ts`), the
 * removed ranges skipped, and for an editable recording the camera's bubble drawn where the scene puts it (hidden over
 * its stretches) and the sounds mixed at the scene's volumes. Drawn only: nothing here takes the pointer, which goes to
 * the player's own controls.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { bubbleRadius, bubbleRect } from "../../shared/camera-layout";
import { cameraShownAt } from "../../shared/editable";
import type { PlaybackEdit } from "../../shared/video-player";
import { EditMix, FOLLOWED_EVENTS, followMedia, mixScene, watchSkipped } from "./edited-playback";

export function EditedLayer({ video, edit }: { video: HTMLVideoElement | null; edit: PlaybackEdit }) {
  const layer = useRef<HTMLDivElement>(null);
  const camera = useRef<HTMLVideoElement>(null);
  const sound = useRef<HTMLAudioElement>(null);
  const mix = useRef<EditMix | undefined>(undefined);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [shown, setShown] = useState(true);
  const editable = edit.editable;
  const scene = editable?.scene;
  const sceneCamera = editable?.camera ? scene?.camera : undefined;

  useLayoutEffect(() => {
    const element = layer.current;
    if (!element) return;
    const measure = (): void => setStage({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!video) return;
    const read = (): void => setFrame({ width: video.videoWidth, height: video.videoHeight });
    read();
    video.addEventListener("loadedmetadata", read);
    return () => video.removeEventListener("loadedmetadata", read);
  }, [video]);

  useEffect(() => {
    if (!video) return;
    if (editable && !mix.current) mix.current = new EditMix();
    const ticks = (seconds: number): number => Math.min(Math.round(seconds * edit.timescale), edit.duration - 1);
    // Whether the camera is in the picture at `time` (the video's timescale), and each sound at its volume there.
    const at = (time: number): void => {
      if (sceneCamera) setShown(sceneCamera.shown && (!sceneCamera.hidden?.length || cameraShownAt(sceneCamera, Math.min(time, edit.duration - 1))));
      if (editable && scene && mix.current) mixScene(mix.current, video, sound.current, editable.sounds, scene, time);
    };
    const followers = (): HTMLMediaElement[] => [camera.current, sound.current].filter((media): media is HTMLMediaElement => media !== null);
    const listeners = FOLLOWED_EVENTS.map(([name, exact]): [string, () => void] => [name, () => {
      if (name === "play") mix.current?.resume();
      for (const media of followers()) followMedia(video, media, exact);
      if (name !== "timeupdate" && name !== "ratechange") at(ticks(video.currentTime || 0));
    }]);
    for (const [name, listener] of listeners) video.addEventListener(name, listener);
    for (const media of followers()) followMedia(video, media, true);
    at(ticks(video.currentTime || 0));
    // Frame by frame while it plays: removed ranges skipped, and the camera and volumes followed where they change.
    const changes = Boolean(sceneCamera?.hidden?.length || scene?.volumeStretches);
    const stop = watchSkipped(video, () => edit, changes ? (time) => at(Math.round(time)) : undefined);
    return () => {
      stop();
      for (const [name, listener] of listeners) video.removeEventListener(name, listener);
      if (sound.current) mix.current?.release(sound.current);
    };
  }, [video, edit, editable, scene, sceneCamera]);

  const shape = editable?.camera;
  let bubble: { left: number; top: number; width: number; height: number; radius: number } | undefined;
  if (sceneCamera && shape && editable?.preview.camera && frame.width > 0 && frame.height > 0 && stage.width > 0) {
    // The picture as the player draws it: contained in the stage, centred; the bubble by the export's own formulas.
    const scale = Math.min(stage.width / frame.width, stage.height / frame.height);
    const left = (stage.width - frame.width * scale) / 2, top = (stage.height - frame.height * scale) / 2;
    const layout = { width: sceneCamera.width, height: sceneCamera.height, rounding: shape.rounding, mirror: shape.mirror, positions: [] };
    const rect = bubbleRect(layout, sceneCamera, frame.width, frame.height);
    bubble = { left: left + rect.x * scale, top: top + rect.y * scale, width: rect.width * scale, height: rect.height * scale, radius: bubbleRadius(layout, rect) * scale };
  }
  return (
    <div ref={layer} className="edited-layer" aria-hidden="true">
      {editable?.preview.secondSound && <audio ref={sound} src={editable.preview.secondSound} crossOrigin="anonymous" preload="auto" hidden />}
      {editable?.preview.camera && (
        // Its element stays while the camera is hidden, so it keeps following and shows again at once.
        <div
          className="edited-camera"
          data-hidden={bubble && shown ? undefined : true}
          style={bubble ? { left: bubble.left, top: bubble.top, width: bubble.width, height: bubble.height, borderRadius: bubble.radius } : undefined}
        >
          <video
            ref={camera}
            src={editable.preview.camera}
            crossOrigin="anonymous"
            muted
            playsInline
            disablePictureInPicture
            tabIndex={-1}
            style={shape?.mirror ? { transform: "scaleX(-1)" } : undefined}
          />
        </div>
      )}
    </div>
  );
}
