import { afterEach, describe, expect, it, vi } from "vitest";
import { measureFrameSize } from "./apply-quality";

describe("measureFrameSize", () => {
  /** A hidden <video> whose frames change size when the test says. */
  function fakeVideo() {
    const video = { muted: false, srcObject: null as unknown, videoWidth: 0, videoHeight: 0,
      onloadedmetadata: null as (() => void) | null, onresize: null as (() => void) | null, onerror: null as (() => void) | null,
      play: async () => undefined, pause: () => undefined };
    vi.stubGlobal("document", { createElement: () => video });
    vi.stubGlobal("MediaStream", class { constructor(readonly tracks: unknown[]) {} });
    return { video, frames: (width: number, height: number) => { video.videoWidth = width; video.videoHeight = height; video.onresize?.(); } };
  }
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("settles once the constrained frames fit the target, a pixel short included, without waiting out its timeout", async () => {
    vi.useFakeTimers();
    const { video, frames } = fakeVideo();
    const stream = { getVideoTracks: () => [{}] } as unknown as MediaStream;
        let settled: unknown;
    void measureFrameSize(stream, { expect: { width: 1662, height: 1080 }, timeoutMs: 1500 }).then(size => { settled = size; });
    video.onloadedmetadata?.();
    // Still the source size: not yet.
    frames(3024, 1964);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBeUndefined();
    // Scaled by the source's aspect ratio, one pixel short of the even target.
    frames(1662, 1079);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toEqual({ width: 1662, height: 1079 });
  });
});
