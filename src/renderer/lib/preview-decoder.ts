/**
 * Draws the engine's preview stream into a canvas (plan 075, D17's second option): WebCodecs' `VideoDecoder`,
 * configured from the `avcC` record that comes with every key frame, so drawing starts at the first key frame after
 * joining and again after a decoding error. Shared by Settings' camera preview and the prototype's page.
 *
 * Bounded (plan 084): it says, by the chunk's number, the last chunk it is done with, drawn or dropped, so the capture
 * host posts only a few beyond it (preview-delivery.ts); and it never keeps more than as many waiting itself. On a gap in
 * the numbers, a decoding error or more waiting than that, it drops the decoder and what waits in it at once, says so,
 * and takes nothing until a key frame with its configuration, which the host asks the engine for at once. A decoder
 * that holds chunks and draws none for `HELD_MS` is dropped the same way, since the host may have stopped posting at
 * either of its limits and would wait for it: the only timer, armed only while chunks wait to be drawn.
 */
import { PREVIEW_OUTSTANDING_CHUNKS } from "../../shared/studio-port";
import { codecFrom, type PreviewMessage } from "./preview-stream";

/** How long a decoder may hold chunks without drawing one. */
export const HELD_MS = 1000;

export interface PreviewDecoder {
  decode(message: PreviewMessage): void;
  /** A new port: drops the decoder, and the next key frame starts a new one; nothing of the old port is acknowledged. */
  reset(): void;
  /** Drops the decoder for good, done with every chunk received. */
  close(): void;
}

export interface PreviewDecoderEvents {
  /** A frame was drawn; `received` is when its chunk arrived. */
  drawn?: (message: PreviewMessage, received: number) => void;
  /** What the decoder is waiting for, or why it stopped. */
  status?: (text: string) => void;
  /** A chunk that could not be decoded: no decoder yet, or one waiting for a key frame (plan 083's figures). */
  skipped?: (message: PreviewMessage) => void;
  /** A new decoder for a stream's codec (the first one included), or the old one failed (plan 083's figures). */
  restarted?: (cause: "codec" | "error") => void;
  /** A chunk was given to the decoder: the chunks now waiting to be drawn, and those in its own queue (plan 084). */
  queued?: (pending: number, decoding: number) => void;
  /**
   * Done with every chunk up to the one numbered `through` (plan 084): what the page tells the capture host; `needsKey`
   * when the decoder was dropped and takes nothing until a key frame.
   */
  done?: (through: number, needsKey: boolean) => void;
}

/** A decoder drawing into `canvas`; none where WebCodecs is missing. */
export function previewDecoder(canvas: HTMLCanvasElement, events: PreviewDecoderEvents = {}): PreviewDecoder | undefined {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context || typeof VideoDecoder === "undefined") return undefined;
  let decoder: VideoDecoder | undefined;
  let codec = "";
  /** The chunk each pending frame came from and when it arrived, by timestamp. */
  const pending = new Map<number, { message: PreviewMessage; received: number }>();
  /** The last chunk's number on this port, and the last said done. */
  let last = 0;
  let told = 0;
  const done = (through: number, needsKey = false): void => {
    if (through <= told && !needsKey) return;
    told = Math.max(told, through);
    events.done?.(through, needsKey);
  };
  /** Armed while chunks wait to be drawn: the decoder is dropped once none has been drawn for `HELD_MS`. */
  let held: ReturnType<typeof setTimeout> | undefined;
  /** When a frame was last drawn, or the wait began. */
  let progressed = 0;
  const unhold = (): void => {
    if (held !== undefined) clearTimeout(held);
    held = undefined;
  };
  const hold = (after: number): void => {
    held = setTimeout(() => {
      held = undefined;
      if (pending.size === 0) return;
      const waited = Date.now() - progressed;
      if (waited >= HELD_MS) drop("The decoder held the preview back; waiting for a key frame", true);
      else hold(HELD_MS - waited);
    }, after);
  };

  const draw = (frame: VideoFrame): void => {
    const entry = pending.get(frame.timestamp);
    pending.delete(frame.timestamp);
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
    }
    context.drawImage(frame, 0, 0, canvas.width, canvas.height);
    frame.close();
    progressed = Date.now();
    if (pending.size === 0) unhold();
    if (entry) {
      events.drawn?.(entry.message, entry.received);
      done(entry.message.n);
    }
  };
  /**
   * Drops the decoder, its queue and the frames it owes; when `acknowledge`, done with every chunk received and, if a
   * decoder was dropped, waiting for a key frame.
   */
  const drop = (why: string | undefined, acknowledge: boolean): void => {
    unhold();
    const had = decoder !== undefined;
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = undefined;
    pending.clear();
    if (acknowledge && last > 0) done(last, had);
    if (why) events.status?.(why);
  };
  return {
    decode(message) {
      // A chunk lost on the way: deltas after it would show corruption until the next key frame.
      const gap = last > 0 && message.n > last + 1;
      last = Math.max(last, message.n);
      if (decoder && !message.key && gap) drop("A preview chunk was lost; waiting for a key frame", true);
      // Behind by more than the capture host would post: start again at a key frame rather than grow.
      else if (decoder && (pending.size >= PREVIEW_OUTSTANDING_CHUNKS || decoder.decodeQueueSize >= PREVIEW_OUTSTANDING_CHUNKS)) {
        drop("The preview fell behind; waiting for a key frame", true);
      }
      if (message.key && message.description) {
        const wanted = codecFrom(message.description);
        if (!wanted) {
          events.skipped?.(message);
          done(message.n);
          return;
        }
        if ((!decoder || decoder.state === "closed" || wanted !== codec)) {
          drop("Starting the decoder…", false);
          codec = wanted;
          events.restarted?.("codec");
          const started: VideoDecoder = new VideoDecoder({
            output: draw,
            error: (error) => {
              // An older decoder's error is not the current one's.
              if (decoder !== started) return;
              events.restarted?.("error");
              drop(`Decoding failed: ${error.message}; waiting for a key frame`, true);
            },
          });
          decoder = started;
          // Software: Chromium's hardware decoder held about six frames back (397 ms at 15 fps, optimizeForLatency and
          // a Constrained Baseline stream notwithstanding); software decodes a 640-pixel frame in about 2 ms for the
          // same processor time across the renderer and the GPU process (2026-10-17).
          decoder.configure({ codec, description: message.description, optimizeForLatency: true, hardwareAcceleration: "prefer-software" });
        }
      }
      // Until a key frame configures it, nothing can be decoded.
      if (!decoder || decoder.state !== "configured") {
        events.skipped?.(message);
        done(message.n);
        return;
      }
      pending.set(message.timestamp, { message, received: Date.now() });
      decoder.decode(new EncodedVideoChunk({ type: message.key ? "key" : "delta", timestamp: message.timestamp, data: message.data }));
      events.queued?.(pending.size, decoder.decodeQueueSize);
      if (held === undefined) {
        progressed = Date.now();
        hold(HELD_MS);
      }
    },
    reset() {
      drop(undefined, false);
      last = 0;
      told = 0;
    },
    close() {
      drop(undefined, false);
      if (last > 0) done(last);
    },
  };
}
