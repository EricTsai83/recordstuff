import { describe, expect, it } from "vitest";
import { mixScene, watchSkipped, type EditMix, type SkipPlan } from "./edited-playback";

/** A video's frame callbacks and play, driven by hand: what `watchSkipped` reads of a <video>. */
function fakeVideo() {
  const events = new EventTarget();
  let pending: ((now: number, metadata: VideoFrameCallbackMetadata) => void) | undefined;
  const video = {
    paused: true,
    currentTime: 0,
    pause() { this.paused = true; },
    play() { this.paused = false; events.dispatchEvent(new Event("play")); },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    requestVideoFrameCallback(run: typeof pending) { pending = run; return 1; },
    cancelVideoFrameCallback() { pending = undefined; },
  };
  /** A frame at `seconds` is shown. */
  const show = (seconds: number): void => pending?.(0, { mediaTime: seconds } as VideoFrameCallbackMetadata);
  return { video, show, element: video as unknown as HTMLVideoElement };
}

const plan = (skipped: SkipPlan["skipped"]): SkipPlan => ({ timescale: 90_000, duration: 900_000, frameRate: 30, skipped });

describe("watchSkipped", () => {
  it("jumps over a removed middle and pauses at a removed ending", () => {
    const { video, show, element } = fakeVideo();
    watchSkipped(element, () => plan([[180_000, 270_000], [720_000, 900_000]]));
    video.play();
    show(2.5);
    expect(video.currentTime).toBe(3);
    show(8.1);
    expect(video.paused).toBe(true);
    expect(video.currentTime).toBe(8);
  });

  it("plays the edit again from its first kept frame once it stopped at a removed ending", () => {
    const { video, show, element } = fakeVideo();
    watchSkipped(element, () => plan([[0, 90_000], [720_000, 900_000]]));
    video.play();
    show(8);
    expect(video.paused).toBe(true);
    video.play();
    // Past the removed opening, not at the removed ending's first frame, where it would stop again at once.
    expect(video.currentTime).toBe(1);
    show(1);
    expect(video.paused).toBe(false);
  });

  it("plays from where it is when the edit keeps that time, and stops listening once stopped", () => {
    const { video, element } = fakeVideo();
    const stop = watchSkipped(element, () => plan([[720_000, 900_000]]));
    video.currentTime = 4;
    video.play();
    expect(video.currentTime).toBe(4);
    video.pause();
    video.currentTime = 8;
    stop();
    video.play();
    expect(video.currentTime).toBe(8);
  });
});

describe("mixScene", () => {
  /** The gains `mixScene` sets, by element. */
  function recorder() {
    const gains = new Map<string, number>();
    const mix = { master() {}, set(media: HTMLMediaElement, factor: number) { gains.set(media.id, factor); } } as unknown as EditMix;
    return { mix, gains };
  }
  const media = (id: string): HTMLMediaElement => ({ id }) as HTMLMediaElement;
  const scene = { volumes: { system: 50, microphone: 200 } };
  const sounds = ["system", "microphone"] as const;

  it("without a mix, plays the first sound in the recording and the second beside it, each at its volume", () => {
    const { mix, gains } = recorder();
    mixScene(mix, media("main"), { sounds, first: null, second: media("second") }, scene, 0);
    expect(Object.fromEntries(gains)).toEqual({ main: 0.5, second: 2 });
  });

  it("with a mix (plan 098), silences the recording's mix once both inputs' own tracks play, and plays the mix as recorded until then", () => {
    const both = recorder();
    mixScene(both.mix, media("main"), { sounds, mix: true, first: media("first"), second: media("second") }, scene, 0);
    expect(Object.fromEntries(both.gains)).toEqual({ main: 0, first: 0.5, second: 2 });
    const waiting = recorder();
    mixScene(waiting.mix, media("main"), { sounds, mix: true, first: null, second: media("second") }, scene, 0);
    expect(Object.fromEntries(waiting.gains)).toEqual({ main: 1, second: 0 });
  });
});
