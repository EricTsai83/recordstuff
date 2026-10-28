/**
 * The Recording tab's Test camera (plan 097, D4) and Test microphone (plan 079, D1; a press since 2026-10-28): the
 * chosen device shown here, the camera's picture or the input's level, to check that it works, only while the user has
 * it on. Pressing Stop, leaving the tab, hiding the window or a recording starting ends it, so visiting the tab turns
 * on no camera light and opens no microphone. The camera is Chromium's, matched to the chosen one by the name main
 * gives (as the Studio's bubble once did, until 2026-10-25); the system default without a name or a match. The input's
 * level is the engine's, read by main as a recording would. Nothing is recorded.
 *
 * Not a row (2026-10-28, the maintainer's request): a row's title and its button said the same words. The test is a
 * stage of its own under the device it tests, its button the only words (the maintainer's choice of the trial's
 * looks): the camera's a dashed tile that opens into its picture, which an empty frame in sight would take a picture's
 * room for; the microphone's a strip in sight, its meter at rest showing where the level will be.
 */
import { useEffect, useRef, useState } from "react";
import { Camera, Mic, Square } from "lucide-react";
import type { SettingsGroup } from "../../../shared/settings-panel";
import { Button } from "../../components/ui/button";
import * as model from "../settings-controller";
import { InputMeter } from "./audio-meter";

/** The camera itself, from Chromium's own list, matched by name; the default when none matches. */
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

/** The camera in `video` while `on`: opened as it turns on, every track stopped as it turns off. */
function useTestCamera(video: HTMLVideoElement | null, on: boolean, name: string | undefined): boolean {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!on || !video) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setFailed(true);
      return;
    }
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

/** Whether the window is in sight: a hidden window stops the test, as leaving the tab does. */
function useVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const changed = (): void => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  return visible;
}

/** The camera's picture while the test runs; Stop over it says that it is running (2026-10-28: no second mark). */
function CameraPicture({ group }: { group: SettingsGroup }) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const failed = useTestCamera(video, true, group.cameraTest?.name);
  if (failed) return <p className="device-stage-caption" role="status">{model.text("The camera could not be shown here.")}</p>;
  return <video ref={setVideo} muted playsInline aria-label={group.label} />;
}

/** The test's button: what it starts, or Stop while it runs. */
function TestButton({ group, kind, running, toggle, describedBy, className }: {
  group: SettingsGroup; kind: "camera" | "microphone"; running: boolean; toggle: (on: boolean) => void; describedBy: string;
  className?: string | undefined;
}) {
  const Icon = running ? Square : kind === "camera" ? Camera : Mic;
  return (
    <Button id={`setting-${group.id}`} variant="outline" size="sm" className={className} aria-pressed={running} disabled={!group.enabled}
      aria-describedby={describedBy} onClick={() => toggle(!running)}>
      <Icon aria-hidden="true" />{model.text(running ? "Stop test" : kind === "camera" ? "Test camera" : "Test microphone")}
    </Button>
  );
}

/**
 * The stage: under the device row, without a title of its own. It ends the test when the row is disabled (a recording
 * starts) or the window is hidden.
 */
export function DeviceTestStage({ group, kind }: { group: SettingsGroup; kind: "camera" | "microphone" }) {
  const id = `setting-${group.id}`;
  const [on, setOn] = useState(false);
  const visible = useVisible();
  useEffect(() => { if (on && (!group.enabled || !visible)) setOn(false); }, [on, group.enabled, visible]);
  const running = on && group.enabled && visible;
  // The tile and the stage's Stop are different buttons with the same id: a press on one keeps the focus on the other.
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    document.getElementById(id)?.focus({ preventScroll: true });
  }, [running, id]);
  const toggle = (next: boolean): void => {
    refocus.current = document.activeElement?.id === id;
    setOn(next);
  };
  // While recording, main's note says where the device is shown instead.
  const caption = group.note ?? (kind === "microphone" && running
    ? model.text("Speak as you would in a recording.")
    : model.text("Shown only here. Nothing is recorded."));
  const captionLine = <p id={`${id}-caption`} className="device-stage-caption">{caption}</p>;
  const Icon = kind === "camera" ? Camera : Mic;

  if (kind === "camera" && !running) {
    return (
      <div className="device-stage" role="group" aria-label={group.label}>
        <Button id={id} variant="outline" size="clip" className="device-stage-tile flex-row! items-center! gap-3! border-dashed px-3! py-2.5!" disabled={!group.enabled}
          aria-pressed={false} aria-describedby={`${id}-caption`} onClick={() => toggle(true)}>
          <span className="device-stage-tile-icon" aria-hidden="true"><Icon /></span>
          <span className="device-stage-tile-text">
            <span className="device-stage-tile-title">{model.text(kind === "camera" ? "Test camera" : "Test microphone")}</span>
            <span id={`${id}-caption`} className="device-stage-caption">{caption}</span>
          </span>
        </Button>
      </div>
    );
  }

  if (kind === "camera") {
    return (
      <div className="device-stage" role="group" aria-label={group.label}>
        <div className="device-stage-frame">
          <CameraPicture group={group} />
          <TestButton group={group} kind={kind} running toggle={toggle} describedBy={`${id}-caption`} className="device-stage-stop" />
        </div>
        {captionLine}
      </div>
    );
  }
  return (
    <div className="device-stage" role="group" aria-label={group.label}>
      <div className="device-stage-strip" data-running={running || undefined}>
        <Icon className="device-stage-glyph" aria-hidden="true" />
        <InputMeter segmented readout off={!running} />
        <TestButton group={group} kind={kind} running={running} toggle={toggle} describedBy={`${id}-caption`} />
      </div>
      {captionLine}
    </div>
  );
}
