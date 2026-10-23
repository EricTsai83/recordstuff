/**
 * Draws the engine's preview stream into a canvas (plan 075, D17's second option): WebCodecs' `VideoDecoder`,
 * configured from the `avcC` record that comes with every key frame, so drawing starts at the first key frame after
 * joining and again after a decoding error. Shared by Settings' camera preview and the prototype's page.
 */
import { codecFrom, type PreviewMessage } from "./preview-stream";

export interface PreviewDecoder {
  decode(message: PreviewMessage): void;
  /** Drops the decoder: the next key frame starts a new one. */
  reset(): void;
  close(): void;
}

export interface PreviewDecoderEvents {
  /** A frame was drawn; `received` is when its chunk arrived. */
  drawn?: (message: PreviewMessage, received: number) => void;
  /** What the decoder is waiting for, or why it stopped. */
  status?: (text: string) => void;
  /** A chunk that could not be decoded: no decoder yet, or one waiting for a key frame (plan 083's figures). */
  skipped?: () => void;
  /** A new decoder for a stream's codec (the first one included), or the old one failed (plan 083's figures). */
  restarted?: (cause: "codec" | "error") => void;
}

/** A decoder drawing into `canvas`; none where WebCodecs is missing. */
export function previewDecoder(canvas: HTMLCanvasElement, events: PreviewDecoderEvents = {}): PreviewDecoder | undefined {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context || typeof VideoDecoder === "undefined") return undefined;
  let decoder: VideoDecoder | undefined;
  let codec = "";
  /** The chunk each pending frame came from and when it arrived, by timestamp. */
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
    if (entry) events.drawn?.(entry.message, entry.received);
  };
  const reset = (why?: string): void => {
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = undefined;
    pending.clear();
    if (why) events.status?.(why);
  };
  return {
    decode(message) {
      if (message.key && message.description) {
        const wanted = codecFrom(message.description);
        if (!wanted) return;
        if (!decoder || decoder.state === "closed" || wanted !== codec) {
          reset("Starting the decoder…");
          codec = wanted;
          events.restarted?.("codec");
          decoder = new VideoDecoder({ output: draw, error: (error) => { events.restarted?.("error"); reset(`Decoding failed: ${error.message}; waiting for a key frame`); } });
          // Software: Chromium's hardware decoder held about six frames back (397 ms at 15 fps, optimizeForLatency and
          // a Constrained Baseline stream notwithstanding); software decodes a 640-pixel frame in about 2 ms for the
          // same processor time across the renderer and the GPU process (2026-10-17).
          decoder.configure({ codec, description: message.description, optimizeForLatency: true, hardwareAcceleration: "prefer-software" });
        }
      }
      // Until a key frame configures it, nothing can be decoded.
      if (!decoder || decoder.state !== "configured") { events.skipped?.(); return; }
      pending.set(message.timestamp, { message, received: Date.now() });
      decoder.decode(new EncodedVideoChunk({ type: message.key ? "key" : "delta", timestamp: message.timestamp, data: message.data }));
    },
    reset: () => reset(),
    close: () => reset(),
  };
}
