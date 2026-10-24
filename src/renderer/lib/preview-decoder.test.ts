// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HELD_MS, previewDecoder, type PreviewDecoderEvents } from "./preview-decoder";
import type { PreviewMessage } from "./preview-stream";

/** WebCodecs' decoder, held: a test says when it outputs or fails. */
class FakeDecoder {
  static made: FakeDecoder[] = [];
  state: "unconfigured" | "configured" | "closed" = "unconfigured";
  queue: { timestamp: number; type: string }[] = [];
  constructor(readonly init: { output: (frame: unknown) => void; error: (error: Error) => void }) { FakeDecoder.made.push(this); }
  get decodeQueueSize(): number { return this.queue.length; }
  configure(): void { this.state = "configured"; }
  decode(chunk: { timestamp: number; type: string }): void { this.queue.push(chunk); }
  close(): void { this.state = "closed"; this.queue = []; }
  /** Outputs the oldest chunk's frame. */
  out(): void {
    const chunk = this.queue.shift()!;
    this.init.output({ timestamp: chunk.timestamp, displayWidth: 960, displayHeight: 540, close: vi.fn() });
  }
}

const description = new Uint8Array([1, 0x42, 0xc0, 0x1f]);
const chunk = (n: number, key = false): PreviewMessage =>
  ({ width: 960, height: 540, data: new Uint8Array([n]), key, timestamp: n * 100_000, sent: 0, n, ...(key ? { description } : {}) });

let canvas: HTMLCanvasElement;
beforeEach(() => {
  FakeDecoder.made = [];
  vi.stubGlobal("VideoDecoder", FakeDecoder);
  vi.stubGlobal("EncodedVideoChunk", class { constructor(init: object) { Object.assign(this, init); } });
  canvas = document.createElement("canvas");
  vi.spyOn(canvas, "getContext").mockReturnValue({ drawImage: vi.fn() } as never);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function decoderWith(): { decode: (m: PreviewMessage) => void; reset: () => void; close: () => void; done: number[]; keys: number[]; events: Required<Pick<PreviewDecoderEvents, "skipped" | "drawn">> } {
  const done: number[] = [];
  const keys: number[] = [];
  const events = { skipped: vi.fn(), drawn: vi.fn() };
  const decoder = previewDecoder(canvas, { ...events, done: (through, needsKey) => (needsKey ? keys : done).push(through) })!;
  return { decode: (m) => decoder.decode(m), reset: () => decoder.reset(), close: () => decoder.close(), done, keys, events };
}
const current = (): FakeDecoder => FakeDecoder.made.at(-1)!;

describe("the preview's decoder (plan 084)", () => {
  it("says each chunk done once it is drawn, and a chunk it cannot decode at once", () => {
    const d = decoderWith();
    d.decode(chunk(1));
    expect(d.done).toEqual([1]);
    expect(d.events.skipped).toHaveBeenCalledTimes(1);
    d.decode(chunk(2, true));
    d.decode(chunk(3));
    expect(d.done).toEqual([1]);
    current().out();
    current().out();
    expect(d.done).toEqual([1, 2, 3]);
    expect(d.events.drawn).toHaveBeenCalledTimes(2);
  });

  it("after a gap, drops the decoder and every delta until a key frame, done with all it held", () => {
    const d = decoderWith();
    d.decode(chunk(1, true));
    d.decode(chunk(2));
    const first = current();
    // Chunk 3 never came.
    d.decode(chunk(4));
    expect(first.state).toBe("closed");
    expect([d.keys, d.done]).toEqual([[4], []]);
    d.decode(chunk(5));
    expect([d.keys, d.done]).toEqual([[4], [5]]);
    d.decode(chunk(6, true));
    expect(current()).not.toBe(first);
    expect(current().queue.map((c) => c.type)).toEqual(["key"]);
    // A key frame after a gap decodes as it is.
    d.decode(chunk(8, true));
    expect(current().queue).toHaveLength(2);
  });

  it("never keeps more waiting than the capture host may post: beyond it, starts again at a key frame", () => {
    const d = decoderWith();
    d.decode(chunk(1, true));
    d.decode(chunk(2));
    d.decode(chunk(3));
    const first = current();
    expect(first.queue).toHaveLength(3);
    d.decode(chunk(4));
    expect(first.state).toBe("closed");
    expect([d.keys, d.done]).toEqual([[4], []]);
    d.decode(chunk(5, true));
    expect(current().queue).toHaveLength(1);
  });

  it("on a decoding error, drops what waits and is done with it; an older decoder's error changes nothing", () => {
    const d = decoderWith();
    d.decode(chunk(1, true));
    const first = current();
    d.decode(chunk(2));
    first.init.error(new Error("bad"));
    expect(first.state).toBe("closed");
    expect([d.keys, d.done]).toEqual([[2], []]);
    d.decode(chunk(3, true));
    const second = current();
    first.init.error(new Error("late"));
    expect(second.state).toBe("configured");
  });

  it("a new port acknowledges nothing of the old one; closing is done with everything received", () => {
    const d = decoderWith();
    d.decode(chunk(10, true));
    d.decode(chunk(11));
    d.reset();
    expect(d.done).toEqual([]);
    // The new port's numbers: no gap is taken from the old one's.
    d.decode(chunk(12, true));
    d.decode(chunk(13));
    expect(current().queue).toHaveLength(2);
    d.close();
    // Closing is no reason for a key frame.
    expect([d.keys, d.done]).toEqual([[], [13]]);
  });

  it("drops a decoder that holds chunks and draws none for HELD_MS, whichever limit stopped the host, and only then", () => {
    vi.useFakeTimers();
    try {
      const d = decoderWith();
      // One large key frame held alone: the host's byte limit may have stopped it.
      d.decode(chunk(1, true));
      const first = current();
      vi.advanceTimersByTime(HELD_MS - 1);
      expect(first.state).toBe("configured");
      first.out();
      // Drawn: nothing waits, nothing is timed, however long the page then idles.
      vi.advanceTimersByTime(10 * HELD_MS);
      expect(first.state).toBe("configured");
      d.decode(chunk(2));
      d.decode(chunk(3));
      vi.advanceTimersByTime(HELD_MS / 2);
      // A frame drawn while another waits starts the wait again from it.
      first.out();
      vi.advanceTimersByTime(HELD_MS - 1);
      expect(first.state).toBe("configured");
      vi.advanceTimersByTime(1);
      expect(first.state).toBe("closed");
      expect(d.keys).toEqual([3]);
      expect(d.done).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a key frame whose description names no codec", () => {
    const d = decoderWith();
    d.decode({ ...chunk(1, true), description: new Uint8Array([0, 1, 2, 3]) });
    expect(FakeDecoder.made).toHaveLength(0);
    expect(d.done).toEqual([1]);
  });
});
