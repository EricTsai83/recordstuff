/**
 * The preview's one leg without a bound before plan 084: the capture host to the Studio's page. napi's gate (lib.rs
 * `PreviewGate`) bounds the chunks waiting for this process's JavaScript thread, but `postMessage` has none, so a page
 * that stops drawing (a stalled renderer, a long garbage collection, a throttled window) let chunks queue in the port
 * and then in its decoder. The page now says, on the same port, the last chunk it is done with (drawn or dropped,
 * `StudioDrawnMessage`); the host keeps the chunks and bytes it posted since, and posts none that would take either
 * beyond its limit. Like the gate, a chunk dropped leaves the stream waiting for a key frame, and so does a page that
 * dropped its decoder (a gap, a decoding error, a decoder that fell behind); once the page is under the limit the host
 * asks the engine for one at the preview's next frame time instead of waiting for the encoder's, up to a second, and
 * asks again every two frame times until one is posted, in case napi's gate dropped it.
 *
 * Each port is its own: a new one starts with nothing outstanding, and an acknowledgement from an older page cannot
 * reach a newer one, since every join makes a fresh channel (studio-link.ts).
 */
import { PREVIEW_OUTSTANDING_BYTES, PREVIEW_OUTSTANDING_CHUNKS } from "../../shared/studio-port";

/** The delivery's figures since the session's start (plan 084), logged with the host's others. */
export interface PreviewDeliveryFigures {
  /** Chunks not posted: beyond a limit, or deltas after a drop until a key frame. */
  previewHeld: number;
  /** Key frames asked of the engine once the page could take one. */
  previewKeyRequests: number;
  /** The most chunks, and bytes, outstanding at once. */
  previewOutstandingHigh: number;
  previewOutstandingBytesHigh: number;
}

/** Runs `run` after `ms`; the call returned cancels it. */
export type Schedule = (run: () => void, ms: number) => () => void;

const realSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

export class PreviewDelivery {
  /** The chunks posted on this port and not yet acknowledged, oldest first, by number. */
  private outstanding: { n: number; bytes: number }[] = [];
  private bytes = 0;
  /** A chunk was dropped, the page dropped its decoder, or the port is new: deltas wait for a key frame. */
  private awaitingKey = true;
  /** The request made for that key frame, asked again until one is posted. */
  private retry: (() => void) | undefined;
  /** The preview's frames a second, as the page last asked: the request is repeated every two of its frame times. */
  private fps = 10;
  private figures: PreviewDeliveryFigures = PreviewDelivery.empty();

  constructor(
    /**
     * Asks the engine for a key frame at the preview's next frame time; false without a preview or while it is not
     * watched, when no more is asked: watching again starts at a key frame.
     */
    private readonly requestKey: () => boolean,
    private readonly schedule: Schedule = realSchedule,
    private readonly limits = { chunks: PREVIEW_OUTSTANDING_CHUNKS, bytes: PREVIEW_OUTSTANDING_BYTES },
  ) {}

  private static empty(): PreviewDeliveryFigures {
    return { previewHeld: 0, previewKeyRequests: 0, previewOutstandingHigh: 0, previewOutstandingBytesHigh: 0 };
  }

  /**
   * A new port, or none: nothing is outstanding on it, and its page's new decoder starts at a key frame, which the
   * engine makes as the page starts watching.
   */
  joined(): void {
    this.outstanding = [];
    this.bytes = 0;
    this.awaitingKey = true;
    this.stopAsking();
  }

  /** The preview's rate, as the page asked it. */
  rate(fps: number): void {
    this.fps = fps;
  }

  /** Whether chunk `n` of `bytes` is posted now; when it is, it is outstanding until acknowledged. */
  admit(n: number, bytes: number, key: boolean): boolean {
    if (!this.fits(bytes)) {
      // The stream has a gap from here: a key frame is asked for once the page is back under the limit.
      this.awaitingKey = true;
      this.stopAsking();
      this.figures.previewHeld += 1;
      return false;
    }
    if (this.awaitingKey && !key) {
      this.figures.previewHeld += 1;
      return false;
    }
    this.awaitingKey = false;
    this.stopAsking();
    this.outstanding.push({ n, bytes });
    this.bytes += bytes;
    this.figures.previewOutstandingHigh = Math.max(this.figures.previewOutstandingHigh, this.outstanding.length);
    this.figures.previewOutstandingBytesHigh = Math.max(this.figures.previewOutstandingBytesHigh, this.bytes);
    return true;
  }

  /**
   * The page is done with every chunk up to `through`, drawn or dropped by it; `needsKey` when it dropped its decoder
   * and takes nothing until a key frame.
   */
  acknowledged(through: number, needsKey = false): void {
    while (this.outstanding.length > 0 && this.outstanding[0]!.n <= through) this.bytes -= this.outstanding.shift()!.bytes;
    if (needsKey && !this.awaitingKey) {
      this.awaitingKey = true;
      this.stopAsking();
    }
    // Under the limit while a key frame is owed: the picture returns at the next frame time.
    if (this.awaitingKey && this.retry === undefined && this.outstanding.length < this.limits.chunks && this.bytes < this.limits.bytes) this.ask();
  }

  /** The chunks and bytes outstanding now. */
  get pending(): { chunks: number; bytes: number } {
    return { chunks: this.outstanding.length, bytes: this.bytes };
  }

  /** The figures since the session started (`restart`). */
  get counts(): PreviewDeliveryFigures {
    return { ...this.figures };
  }

  /** A new session: its figures start from nothing; the port and what is outstanding on it stay. */
  restart(): void {
    this.figures = PreviewDelivery.empty();
  }

  /** Asks for a key frame, and again every two frame times until one is posted or the stream is cut again. */
  private ask(): void {
    if (!this.requestKey()) {
      this.stopAsking();
      return;
    }
    this.figures.previewKeyRequests += 1;
    this.retry = this.schedule(() => {
      this.retry = undefined;
      if (this.awaitingKey) this.ask();
    }, 2000 / this.fps);
  }

  private stopAsking(): void {
    this.retry?.();
    this.retry = undefined;
  }

  /** Whether a chunk of `bytes` keeps what is outstanding within both limits; one alone always goes. */
  private fits(bytes: number): boolean {
    if (this.outstanding.length === 0) return true;
    return this.outstanding.length < this.limits.chunks && this.bytes + bytes <= this.limits.bytes;
  }
}
