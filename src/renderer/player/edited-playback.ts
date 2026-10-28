/**
 * An edit played as it will export, without an export (plan 085's preview, 2026-10-27 shared with the full-screen
 * viewer): the recording plays, a frame in a removed range jumps to where the export goes on, an editable recording's
 * camera and second sound (with a mix, plan 098, both inputs' own sounds) follow it, and the sounds go through Web
 * Audio at the scene's volumes and the export's soft
 * limit. The edit view's preview and the full-screen viewer play an edit with these, so both play it alike.
 */
import { softLimit } from "../../shared/audio-volume";
import type { EditRange } from "../../shared/editing";
import { volumeAt, type EditableSound, type EditScene } from "../../shared/editable";

/** What a frame's time is checked against: the ranges the export leaves out, in the video's timescale. */
export interface SkipPlan {
  timescale: number;
  /** The recording's length in its timescale. */
  duration: number;
  frameRate: number;
  skipped: readonly EditRange[];
}

/**
 * Half a frame either way: a frame's media time is rounded to microseconds and need not fall on the timescale's grid,
 * so the frame a range ends at could read as just inside it and be sought to again and again, the preview standing
 * still while it shows Pause.
 */
function slackOf(edit: SkipPlan): number {
  return edit.timescale / Math.max(1, edit.frameRate) / 2;
}

/**
 * While `video` plays, each frame shown is checked: one in a skipped range jumps to where that range ends, or, at a
 * removed tail, pauses at its start, so what plays is what the export will hold. Play from there starts the edit
 * again from its first kept frame, as an ended video plays from its start, rather than stopping at once on the same
 * removed frame. `frame` is told each frame's time first (an editable recording's volumes follow it). Returns a stop.
 * Nothing where the DOM has no frame callbacks.
 */
export function watchSkipped(video: HTMLVideoElement, plan: () => SkipPlan | undefined, frame?: (time: number) => void): () => void {
  if (typeof video.requestVideoFrameCallback !== "function") return () => undefined;
  let callback: number | undefined;
  const restart = (): void => {
    const edit = plan();
    if (!edit) return;
    const time = video.currentTime * edit.timescale, slack = slackOf(edit);
    if (!edit.skipped.some(([from, to]) => to >= edit.duration && time >= from - slack)) return;
    const opening = edit.skipped.find(([from]) => from <= slack);
    video.currentTime = opening ? opening[1] / edit.timescale : 0;
  };
  const check = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
    callback = video.requestVideoFrameCallback(check);
    const edit = plan();
    if (!edit || video.paused) return;
    const time = metadata.mediaTime * edit.timescale, slack = slackOf(edit);
    frame?.(time);
    const range = edit.skipped.find(([from, to]) => time >= from - slack && time < to - slack);
    if (!range) return;
    if (range[1] >= edit.duration) {
      video.pause();
      video.currentTime = range[0] / edit.timescale;
    } else {
      video.currentTime = range[1] / edit.timescale;
    }
  };
  callback = video.requestVideoFrameCallback(check);
  video.addEventListener("play", restart);
  return () => {
    video.removeEventListener("play", restart);
    if (callback !== undefined) video.cancelVideoFrameCallback(callback);
    callback = undefined;
  };
}

/** How far a follower may drift from the playing recording before it is put back to its time. */
const DRIFT_SECONDS = 0.12;

/**
 * Puts `media` where `main` is, playing or not as it is, at its rate and with its mute and volume (the player's own
 * controls). `exact` after a seek or when it joins; while playing it is moved back only once it drifts.
 */
export function followMedia(main: HTMLMediaElement, media: HTMLMediaElement, exact: boolean): void {
  if (!Number.isFinite(main.currentTime)) return;
  const drift = Math.abs(media.currentTime - main.currentTime);
  if (exact ? drift > 0.001 : drift > DRIFT_SECONDS) media.currentTime = main.currentTime;
  media.playbackRate = main.playbackRate;
  media.muted = main.muted;
  media.volume = main.volume;
  if (main.paused && !media.paused) media.pause();
  else if (!main.paused && media.paused) void media.play().catch(() => undefined);
}

/** The recording's events its followers take, `exact` for those after which they are put exactly where it is. */
export const FOLLOWED_EVENTS: ReadonlyArray<[string, boolean]> = [
  ["play", true], ["pause", true], ["seeked", true], ["ratechange", false], ["volumechange", false], ["timeupdate", false],
];

/** The span of sums the limiter's curve covers: past it a sum is as limited as full scale is. */
const LIMIT_SPAN = 8;

/**
 * The edit's sound (plan 087): each element through a gain at its track's volume, summed, then through the export's
 * soft limit (as a wave shaper), so a loud or raised mix sounds as the export will, and only then the player's own
 * volume and mute, as a master gain: Chromium applies an element's volume and mute to its source node (measured
 * 2026-10-25), so each element's gain divides its own volume back out, and the mix is limited as the export limits it
 * whatever the player's volume. Created on first use; each element's source can be made only once, so an element's
 * nodes live as long as it is shown, and are released after.
 */
export class EditMix {
  private graph: { context: AudioContext; mix: AudioNode; master: GainNode } | undefined;
  private readonly nodes = new Map<HTMLMediaElement, { source: AudioNode; gain: GainNode }>();
  /** The last gain each node was told, so a frame that changes nothing schedules nothing. */
  private readonly told = new WeakMap<GainNode, number>();

  /** Whether `media` goes through the mix already. */
  has(media: HTMLMediaElement): boolean {
    return this.nodes.has(media);
  }

  /** `media`'s gain, its nodes made on first use; none where there is no Web Audio. */
  gainFor(media: HTMLMediaElement): GainNode | undefined {
    if (typeof AudioContext !== "function") return undefined;
    if (!this.graph) {
      const context = new AudioContext();
      // Scaled into the shaper's -1…1 and out again by its curve, which is the limit of the sums -LIMIT_SPAN…LIMIT_SPAN.
      const into = context.createGain();
      into.gain.value = 1 / LIMIT_SPAN;
      const shaper = context.createWaveShaper();
      shaper.curve = Float32Array.from({ length: 4096 }, (_, n) => softLimit((n / 4095 * 2 - 1) * LIMIT_SPAN));
      const master = context.createGain();
      into.connect(shaper).connect(master).connect(context.destination);
      this.graph = { context, mix: into, master };
    }
    let nodes = this.nodes.get(media);
    if (!nodes) {
      const source = this.graph.context.createMediaElementSource(media);
      const gain = this.graph.context.createGain();
      source.connect(gain).connect(this.graph.mix);
      nodes = { source, gain };
      this.nodes.set(media, nodes);
    }
    return nodes.gain;
  }

  /** Stops a follower that left and lets its nodes go. */
  release(media: HTMLMediaElement): void {
    media.pause();
    const nodes = this.nodes.get(media);
    if (!nodes) return;
    nodes.source.disconnect();
    nodes.gain.disconnect();
    this.nodes.delete(media);
  }

  resume(): void {
    if (this.graph?.context.state === "suspended") void this.graph.context.resume().catch(() => undefined);
  }

  /** The player's own volume and mute, after the limit. */
  master(main: HTMLMediaElement): void {
    if (this.graph) this.graph.master.gain.value = main.muted ? 0 : main.volume;
  }

  /**
   * `media` at `factor` of its track: what the element's volume did to its source undone, so the gain alone is the
   * scene's. While it plays a change eases over a few milliseconds, as the export's does, so it does not click.
   */
  set(media: HTMLMediaElement, factor: number): void {
    const gain = this.gainFor(media);
    if (!gain) return;
    const level = media.muted ? 0 : media.volume;
    const value = level > 0 ? factor / level : 0;
    if (this.told.get(gain) === value) return;
    this.told.set(gain, value);
    if (this.graph && !media.paused) gain.gain.setTargetAtTime(value, this.graph.context.currentTime, 0.004);
    else {
      gain.gain.cancelScheduledValues(0);
      gain.gain.value = value;
    }
  }

  /** The nodes made for `media` only, set back to its track as recorded (a recording that is not editable). */
  unity(media: HTMLMediaElement): void {
    if (this.nodes.has(media)) this.set(media, 1);
  }
}

/** A sound's volume in `scene` at `time` (the video's timescale; a stretch's there), as a gain. */
export function soundGain(scene: EditScene, sound: EditableSound | undefined, time = 0): number {
  const percent = sound === "microphone" || sound === "system" ? volumeAt(scene, sound, time) : 100;
  return percent / 100;
}

/** An editable recording's sounds as the page plays them: what the recording holds and its preview's sound elements. */
export interface SceneSounds {
  sounds: readonly EditableSound[];
  /** The recording plays its inputs mixed (plan 098). */
  mix?: true;
  /** With a mix, the first input's own track; without, none: the recording plays it. */
  first: HTMLMediaElement | null;
  second: HTMLMediaElement | null;
}

/**
 * Each sound of an editable recording at `scene`'s volume for `time`, then the player's own volume after the limit.
 * Without a mix `main` plays the first sound and `second` (if any) the second. With one (plan 098) `main` plays both
 * mixed: once both inputs' own tracks are shown, they play at their volumes and the mix is silent, so nothing is heard
 * twice; until then the mix plays as recorded and they are silent.
 */
export function mixScene(mix: EditMix, main: HTMLMediaElement, sounds: SceneSounds, scene: EditScene, time: number): void {
  mix.master(main);
  const own = !sounds.mix || (sounds.first !== null && sounds.second !== null);
  const pairs: Array<[HTMLMediaElement | null, number]> = sounds.mix
    ? [[main, own ? 0 : 1], [sounds.first, own ? soundGain(scene, sounds.sounds[0], time) : 0], [sounds.second, own ? soundGain(scene, sounds.sounds[1], time) : 0]]
    : [[main, soundGain(scene, sounds.sounds[0], time)], [sounds.second, soundGain(scene, sounds.sounds[1], time)]];
  for (const [media, gain] of pairs) if (media) mix.set(media, gain);
  mix.master(main);
}
