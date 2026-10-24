/**
 * The Recording Studio's port (plan 081, studio-port.ts): main posts the page one end while the page watches the
 * recording's preview or its meters, and both come on it, so the preview's frames and the levels never pass through
 * main. The page tells the capture process on it how often to show the preview (studio-pace.ts). The port is let go
 * once nothing listens, as main lets the session go then; the next listener's watching brings a new one.
 */
import { SETTINGS_CHANNELS, type StudioLevels } from "../../../shared/settings-panel";
import { isStudioDiagnosticsRequest, isStudioLevels, isStudioStallRequest, STUDIO_FPS, type StudioDrawnMessage, type StudioRateMessage, type StudioView, type StudioViewMessage } from "../../../shared/studio-port";
import { PreviewDiagnostics } from "../../lib/preview-diagnostics";
import { isPreviewMessage, type PreviewMessage } from "../../lib/preview-stream";

/** A preview's listener: its chunks, and each new port, after which its decoder starts again at a key frame. */
export interface PreviewListener { chunk(message: PreviewMessage): void; joined(): void }

const previews = new Set<PreviewListener>();
const levels = new Set<(levels: StudioLevels) => void>();
let port: MessagePort | undefined;
let fps: StudioRateMessage["fps"] = STUDIO_FPS;
let view: StudioView = "composed";
let listening = false;
/** Plan 084's stall: kept, so the hold's loop is not optimized away. */
export let held = 0;
/** The last preview chunk received on this port, and the last the capture process was told done with (plan 084). */
let received = 0;
let acknowledged = 0;
/** The preview's figures (plan 083), kept and reported on the port only once the capture process asked for them. */
export const previewFigures = new PreviewDiagnostics();
let reporting: ReturnType<typeof setInterval> | undefined;

function stopReporting(): void {
  if (reporting !== undefined) clearInterval(reporting);
  reporting = undefined;
  previewFigures.stop();
}

const said = (): void => port?.postMessage({ type: "rate", fps } satisfies StudioRateMessage);
const shown = (): void => port?.postMessage({ type: "view", view } satisfies StudioViewMessage);

function joined(event: MessageEvent): void {
  // Only the preload's own post, which comes from this window (Electron's MessagePort pattern): never another frame's.
  if (event.source !== window || event.data !== SETTINGS_CHANNELS.cameraPreviewPort || !event.ports[0]) return;
  port?.close();
  // A new port asks again, if its capture process keeps figures.
  stopReporting();
  const joinedPort = event.ports[0];
  port = joinedPort;
  received = 0;
  acknowledged = 0;
  previewFigures.joined();
  port.onmessage = (message) => {
    const data: unknown = message.data;
    if (isStudioLevels(data)) {
      const told: StudioLevels = { system: data.system, ...(data.microphone === undefined ? {} : { microphone: data.microphone }) };
      for (const listener of levels) listener(told);
    } else if (isPreviewMessage(data)) {
      // The clock is read only while figures are kept (plan 083: off, nothing is timed).
      if (previewFigures.keeping) previewFigures.received(data, Date.now());
      received = Math.max(received, data.n);
      for (const listener of previews) listener.chunk(data);
      // No preview to draw it: done with it at once, or the capture process would stop posting.
      if (previews.size === 0) previewDone(data.n);
    } else if (isStudioStallRequest(data)) {
      // Plan 084's development switch, which the capture process alone sends: the page's thread held as a stalled
      // renderer's would be, the chunks queueing in the port meanwhile. The clock is read only every 100,000 turns, so
      // the hold itself allocates next to nothing that the stalled page's own garbage collection would have to free.
      const until = performance.now() + data.ms;
      let spins = 0;
      for (;;) {
        for (let i = 0; i < 100_000; i += 1) spins = (spins + i) | 0;
        if (performance.now() >= until) break;
      }
      held = spins;
    } else if (isStudioDiagnosticsRequest(data) && reporting === undefined) {
      previewFigures.start();
      reporting = setInterval(() => joinedPort.postMessage(previewFigures.take()), data.everyMs);
    }
  };
  port.start();
  // A new port is a new session's, whose preview starts at 10 a second and composed, or the same session's after both
  // were let go: the page says its own either way.
  said();
  shown();
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
  return () => {
    previews.delete(listener);
    // The meters may keep the port: whatever came for the preview is done with.
    if (previews.size === 0) previewDone(received);
    release();
  };
}

/**
 * The preview's decoder is done with every chunk up to `through`, drawn or dropped (plan 084): told on the port, once
 * for each new last, so the capture process posts only a few chunks beyond what the page drew; and whenever the decoder
 * was dropped (`needsKey`), so the capture process asks the engine for a key frame at once.
 */
export function previewDone(through: number, needsKey = false): void {
  if (!port || (through <= acknowledged && !needsKey)) return;
  acknowledged = Math.max(acknowledged, through);
  port.postMessage({ type: "drawn", through, ...(needsKey ? { key: true } : {}) } satisfies StudioDrawnMessage);
}

/** Listens for the levels; returns the call that stops. Main is asked for them apart (watchLevels). */
export function onLevels(listener: (levels: StudioLevels) => void): () => void {
  levels.add(listener);
  listen();
  return () => { levels.delete(listener); release(); };
}

/** How often the preview is shown (plan 092, D1), told to the capture process now and on every new port. */
export function setPreviewRate(next: StudioRateMessage["fps"]): void {
  if (next === fps) return;
  fps = next;
  said();
}

/** What the preview shows (plan 092, D3), told to the capture process now and on every new port. */
export function setPreviewView(next: StudioView): void {
  if (next === view) return;
  view = next;
  shown();
}
