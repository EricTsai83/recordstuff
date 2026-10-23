/**
 * The Recording Studio's port (plan 081, studio-port.ts): main posts the page one end while the page watches the
 * recording's preview or its meters, and both come on it, so the preview's frames and the levels never pass through
 * main. The page tells the capture process on it how often to show the preview (studio-pace.ts). The port is let go
 * once nothing listens, as main lets the session go then; the next listener's watching brings a new one.
 */
import { SETTINGS_CHANNELS, type StudioLevels } from "../../../shared/settings-panel";
import { isStudioDiagnosticsRequest, isStudioLevels, STUDIO_FPS, type StudioRateMessage } from "../../../shared/studio-port";
import { PreviewDiagnostics } from "../../lib/preview-diagnostics";
import { isPreviewMessage, type PreviewMessage } from "../../lib/preview-stream";

/** A preview's listener: its chunks, and each new port, after which its decoder starts again at a key frame. */
export interface PreviewListener { chunk(message: PreviewMessage): void; joined(): void }

const previews = new Set<PreviewListener>();
const levels = new Set<(levels: StudioLevels) => void>();
let port: MessagePort | undefined;
let fps: StudioRateMessage["fps"] = STUDIO_FPS;
let listening = false;
/** The preview's figures (plan 083), kept and reported on the port only once the capture process asked for them. */
export const previewFigures = new PreviewDiagnostics();
let reporting: ReturnType<typeof setInterval> | undefined;

function stopReporting(): void {
  if (reporting !== undefined) clearInterval(reporting);
  reporting = undefined;
  previewFigures.stop();
}

const said = (): void => port?.postMessage({ type: "rate", fps } satisfies StudioRateMessage);

function joined(event: MessageEvent): void {
  // Only the preload's own post, which comes from this window (Electron's MessagePort pattern): never another frame's.
  if (event.source !== window || event.data !== SETTINGS_CHANNELS.cameraPreviewPort || !event.ports[0]) return;
  port?.close();
  // A new port asks again, if its capture process keeps figures.
  stopReporting();
  const joinedPort = event.ports[0];
  port = joinedPort;
  previewFigures.joined();
  port.onmessage = (message) => {
    const data: unknown = message.data;
    if (isStudioLevels(data)) {
      const told: StudioLevels = { system: data.system, ...(data.microphone === undefined ? {} : { microphone: data.microphone }) };
      for (const listener of levels) listener(told);
    } else if (isPreviewMessage(data)) {
      // The clock is read only while figures are kept (plan 083: off, nothing is timed).
      if (previewFigures.keeping) previewFigures.received(data, Date.now());
      for (const listener of previews) listener.chunk(data);
    } else if (isStudioDiagnosticsRequest(data) && reporting === undefined) {
      previewFigures.start();
      reporting = setInterval(() => joinedPort.postMessage(previewFigures.take()), data.everyMs);
    }
  };
  port.start();
  // A new port is a new session's, whose preview starts at the full rate, or the same session's after both were let
  // go: the page says its own either way.
  said();
  for (const listener of previews) listener.joined();
}

function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("message", joined);
}

function release(): void {
  if (previews.size > 0 || levels.size > 0) return;
  listening = false;
  window.removeEventListener("message", joined);
  // What was kept since the last report goes with the port: the capture process's own figures end with the session.
  if (reporting !== undefined) port?.postMessage(previewFigures.take());
  stopReporting();
  port?.close();
  port = undefined;
}

/** Listens for the preview's chunks; returns the call that stops. Main is asked for them apart (watchCameraPreview). */
export function onPreview(listener: PreviewListener): () => void {
  previews.add(listener);
  listen();
  return () => { previews.delete(listener); release(); };
}

/** Listens for the levels; returns the call that stops. Main is asked for them apart (watchLevels). */
export function onLevels(listener: (levels: StudioLevels) => void): () => void {
  levels.add(listener);
  listen();
  return () => { levels.delete(listener); release(); };
}

/** How often the preview is shown (plan 081, D1), told to the capture process now and on every new port. */
export function setPreviewRate(next: StudioRateMessage["fps"]): void {
  if (next === fps) return;
  fps = next;
  said();
}
