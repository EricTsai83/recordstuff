/**
 * Frame-cadence diagnostic renderer (plan 041); never shipped. Runs the real
 * capture host (its module registers the port listener) and only observes it:
 * every frame the video track delivers is timestamped before MediaRecorder,
 * `track.stats` and `getSettings().frameRate` are sampled once a second, and
 * the recorder's start and stop are marked. With a request override from
 * `config.js` the frame-rate constraint of `getDisplayMedia` and
 * `applyConstraints` is replaced, so candidates run through the same host.
 * The fixture's main process reads `window.__cadence` after the stop.
 */
import "../../src/renderer/capture-host";

interface FrameRateRequest { ideal?: number; max?: number }
interface CadenceConfig { request: FrameRateRequest | null }
interface TrackStats { deliveredFrames?: number; discardedFrames?: number; totalFrames?: number }
interface ProcessedFrame { timestamp: number | null; close(): void }
type Processor = new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => { readable: ReadableStream<ProcessedFrame> };

interface CadenceProbe {
  requests: { call: string; asked: unknown; used: unknown }[];
  /** `timestamp` in µs as the track stamps it; `at` is `performance.now()` on arrival. */
  frames: { timestamp: number | null; at: number }[];
  samples: { at: number; delivered?: number; discarded?: number; total?: number; frameRate?: number }[];
  recorderStart?: number;
  recorderStop?: number;
  processor: "MediaStreamTrackProcessor" | "unavailable";
  errors: string[];
}

const scope = window as unknown as { __cadenceConfig?: CadenceConfig; __cadence?: CadenceProbe; MediaStreamTrackProcessor?: Processor };
const config: CadenceConfig = scope.__cadenceConfig ?? { request: null };
const probe: CadenceProbe = { requests: [], frames: [], samples: [], processor: "unavailable", errors: [] };
scope.__cadence = probe;

function replaceFrameRate<T extends { frameRate?: unknown }>(constraints: T, call: string): T {
  const used = config.request ? { ...constraints, frameRate: { ...config.request } } : constraints;
  probe.requests.push({ call, asked: constraints.frameRate, used: used.frameRate });
  return used;
}

function tap(track: MediaStreamTrack): void {
  const sample = (): void => {
    const stats = (track as unknown as { stats?: TrackStats }).stats;
    const entry: CadenceProbe["samples"][number] = { at: performance.now() };
    if (stats?.deliveredFrames !== undefined) entry.delivered = stats.deliveredFrames;
    if (stats?.discardedFrames !== undefined) entry.discarded = stats.discardedFrames;
    if (stats?.totalFrames !== undefined) entry.total = stats.totalFrames;
    const frameRate = track.getSettings().frameRate;
    if (frameRate !== undefined) entry.frameRate = frameRate;
    probe.samples.push(entry);
  };
  sample();
  const timer = setInterval(() => (track.readyState === "ended" ? clearInterval(timer) : sample()), 1000);
  track.addEventListener("ended", sample);
  const Constructor = scope.MediaStreamTrackProcessor;
  if (!Constructor) return;
  probe.processor = "MediaStreamTrackProcessor";
  const reader = new Constructor({ track }).readable.getReader();
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      probe.frames.push({ timestamp: value.timestamp, at: performance.now() });
      value.close();
    }
  })().catch((cause: unknown) => probe.errors.push(`processor: ${String(cause)}`));
}

const devices = navigator.mediaDevices;
const getDisplayMedia = devices.getDisplayMedia.bind(devices);
devices.getDisplayMedia = async (options?: DisplayMediaStreamOptions): Promise<MediaStream> => {
  const video = options?.video;
  const next = video && typeof video === "object" ? { ...options, video: replaceFrameRate(video, "getDisplayMedia") } : options;
  const stream = await getDisplayMedia(next);
  const track = stream.getVideoTracks()[0];
  if (track) tap(track);
  return stream;
};

const applyConstraints = MediaStreamTrack.prototype.applyConstraints;
MediaStreamTrack.prototype.applyConstraints = function (this: MediaStreamTrack, constraints?: MediaTrackConstraints): Promise<void> {
  const next = this.kind === "video" && constraints ? replaceFrameRate(constraints, "applyConstraints") : constraints;
  return applyConstraints.call(this, next);
};

const start = MediaRecorder.prototype.start;
MediaRecorder.prototype.start = function (this: MediaRecorder, timeslice?: number): void {
  probe.recorderStart = performance.now();
  start.call(this, timeslice);
};
const stop = MediaRecorder.prototype.stop;
MediaRecorder.prototype.stop = function (this: MediaRecorder): void {
  probe.recorderStop ??= performance.now();
  stop.call(this);
};
