/**
 * Plan 075 step 2's preview page: decodes the engine's small H.264 preview stream (D17's second option) with WebCodecs'
 * `VideoDecoder` and draws each frame into a canvas, showing how many arrived and how late, for the gate's
 * measurement. A decoder is configured from the `avcC` record that comes with every key frame, so the page starts at
 * the first key frame after it joins and again after a decoding error.
 */
import { CAMERA_PREVIEW_PORT_CHANNEL as CHANNEL } from "../../shared/camera-preview";
import { codecFrom, isPreviewMessage, previewStats, type PreviewMessage } from "./preview-stream";

function start(canvas: HTMLCanvasElement, status: HTMLElement): void {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context || typeof VideoDecoder === "undefined") {
    status.textContent = "WebCodecs is not available";
    return;
  }
  const stats = previewStats();
  let decoder: VideoDecoder | undefined;
  let codec = "";
  /** The chunk each pending frame came from and when the page took it, by timestamp, for the counts. */
  const pending = new Map<number, { message: PreviewMessage; received: number }>();

  const draw = (frame: VideoFrame): void => {
    const entry = pending.get(frame.timestamp);
    pending.delete(frame.timestamp);
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
    }
    context.drawImage(frame, 0, 0, canvas.width, canvas.height);
    frame.close();
    if (entry) status.textContent = stats.add(entry.message, Date.now(), entry.received);
  };
  const reset = (why: string): void => {
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = undefined;
    pending.clear();
    status.textContent = why;
  };
  const decode = (message: PreviewMessage): void => {
    if (message.key && message.description) {
      const wanted = codecFrom(message.description);
      if (!wanted) return;
      if (!decoder || decoder.state === "closed" || wanted !== codec) {
        reset("Starting the decoder…");
        codec = wanted;
        decoder = new VideoDecoder({ output: draw, error: (error) => reset(`Decoding failed: ${error.message}; waiting for a key frame`) });
        // Software: Chromium's hardware decoder held about six frames back (397 ms at 15 fps, optimizeForLatency and a
        // Constrained Baseline stream notwithstanding); software decodes a 640-pixel frame in about 2 ms for the same
        // processor time across the renderer and the GPU process (2026-10-17).
        decoder.configure({ codec, description: message.description, optimizeForLatency: true, hardwareAcceleration: "prefer-software" });
      }
    }
    // Until a key frame configures it, nothing can be decoded.
    if (!decoder || decoder.state !== "configured") return;
    pending.set(message.timestamp, { message, received: Date.now() });
    decoder.decode(new EncodedVideoChunk({ type: message.key ? "key" : "delta", timestamp: message.timestamp, data: message.data }));
  };

  window.addEventListener("message", (event) => {
    if (event.data !== CHANNEL || !event.ports[0]) return;
    const port = event.ports[0];
    stats.reset();
    reset("Joined to the capture process; waiting for a key frame…");
    port.onmessage = (chunk) => { if (isPreviewMessage(chunk.data)) decode(chunk.data); };
    port.start();
  });
}

const canvas = document.getElementById("preview");
const status = document.getElementById("status");
if (canvas instanceof HTMLCanvasElement && status) start(canvas, status);
