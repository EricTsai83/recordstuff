/**
 * The Recording tab's Test camera (plan 097, D4): the chosen camera shown here, to check that it works, only while the
 * user has it on. Pressing it again, leaving the tab or hiding the window stops every track, so visiting the tab never
 * turns on the camera's light. The camera is Chromium's, matched to the chosen one by the name main gives (as the
 * Studio's bubble once did, until 2026-10-25); the system default without a name or a match. Nothing is recorded.
 */
import { useEffect, useState } from "react";
import { Camera } from "lucide-react";
import type { SettingsGroup } from "../../../shared/settings-panel";
import { Button } from "../../components/ui/button";
import * as model from "../settings-controller";

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

/** The button, in the row's controls. */
export function CameraTestButton({ group, on, onChange, describedBy }: {
  group: SettingsGroup; on: boolean; onChange: (on: boolean) => void; describedBy: string | undefined;
}) {
  return (
    <Button id={`setting-${group.id}`} variant="outline" size="sm" aria-pressed={on} disabled={!group.enabled}
      aria-describedby={describedBy} onClick={() => onChange(!on)}>
      <Camera aria-hidden="true" />{model.text(on ? "Stop test" : "Test camera")}
    </Button>
  );
}

/** The picture, under the row while the test is on; it ends the test when the row is disabled or the window hidden. */
export function CameraTestPicture({ group, on, onChange }: { group: SettingsGroup; on: boolean; onChange: (on: boolean) => void }) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const visible = useVisible();
  const showing = on && group.enabled && visible;
  useEffect(() => { if (on && (!group.enabled || !visible)) onChange(false); }, [on, group.enabled, visible, onChange]);
  const failed = useTestCamera(video, showing, group.cameraTest?.name);
  if (!on) return null;
  return (
    <div className="camera-test">
      <video ref={setVideo} className="camera-test-picture" muted playsInline aria-label={group.label} hidden={failed} />
      {failed && <p className="camera-test-failed" role="status">{model.text("The camera could not be shown here.")}</p>}
    </div>
  );
}
