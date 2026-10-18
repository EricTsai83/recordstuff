/**
 * Plan 075 step 2's preview page: decodes the engine's small H.264 preview stream (D17's second option) and draws it,
 * showing how many frames arrived and how late, for the gate's measurement.
 */
import { CAMERA_PREVIEW_PORT_CHANNEL as CHANNEL } from "../../shared/camera-preview";
import { isPreviewMessage, previewStats } from "../lib/preview-stream";
import { previewDecoder } from "../lib/preview-decoder";

function start(canvas: HTMLCanvasElement, status: HTMLElement): void {
  const stats = previewStats();
  const decoder = previewDecoder(canvas, {
    drawn: (message, received) => { status.textContent = stats.add(message, Date.now(), received); },
    status: (text) => { status.textContent = text; },
  });
  if (!decoder) {
    status.textContent = "WebCodecs is not available";
    return;
  }
  window.addEventListener("message", (event) => {
    if (event.data !== CHANNEL || !event.ports[0]) return;
    const port = event.ports[0];
    stats.reset();
    decoder.reset();
    status.textContent = "Joined to the capture process; waiting for a key frame…";
    port.onmessage = (chunk) => { if (isPreviewMessage(chunk.data)) decoder.decode(chunk.data); };
    port.start();
  });
}

const canvas = document.getElementById("preview");
const status = document.getElementById("status");
if (canvas instanceof HTMLCanvasElement && status) start(canvas, status);
