/**
 * The hidden capture host (docs/system-design/recording.md): `getDisplayMedia` (main decides
 * the source and adds `audio: 'loopback'`) → `MediaRecorder` producing
 * fragmented MP4 (H.264 + AAC) → one chunk per second over the MessagePort.
 * It never touches the file system; main writes every byte.
 */
import { CHUNK_INTERVAL_MS, OUTPUT_MIME_TYPE, isMainMessage, type HostMessage } from "../shared/protocol";
import {
  AUDIO_BITS_PER_SECOND,
  fitWithinCap,
  videoBitsPerSecond,
  type CaptureReport,
  type Dimensions,
  type QualitySettings,
} from "../shared/quality";
import type { ErrorCode } from "../shared/state";

/** Used for the encoder target when the platform does not report the captured size. */
const ASSUMED_SIZE = { width: 1920, height: 1080 };

interface Session {
  id: string;
  stream: MediaStream;
  recorder: MediaRecorder;
  seq: number;
  /** Chunk hand-off is async (`blob.arrayBuffer()`); serialize to keep order. */
  chain: Promise<void>;
  cause?: { code: ErrorCode; detail: string; displayFailure?: "track_ended" } | "normal";
  timer?: ReturnType<typeof setTimeout>;
  draining: boolean;
  handoffFailed: boolean;
  finished: boolean;
}

/** The subset of `MessagePort` the host uses; lets tests pass a fake. */
export interface HostPort {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  start(): void;
  postMessage(message: unknown): void;
}

export interface CaptureHostOptions {
  terminalTimeoutMs?: number;
  /** Size of the frames a stream actually delivers; defaults to `measureFrameSize`. */
  measureFrameSize?: FrameSizeMeasurer;
}

export interface MeasureOptions {
  timeoutMs?: number;
  /**
   * After a constraint was applied the first frames may still be the old
   * size: keep watching `resize` until the frames match this, or time out
   * and return the last size seen.
   */
  expect?: Dimensions;
}

export type FrameSizeMeasurer = (stream: MediaStream, options?: MeasureOptions) => Promise<Dimensions | undefined>;

/**
 * The size of the frames a stream really carries, read from a hidden
 * `<video>` element's intrinsic size. The first measurements showed
 * `track.getSettings()` reporting 1920x1920 for a 1920x1080 display (the
 * height of another monitor), which made the 1080p cap scale the picture to
 * 1080x606; the frames themselves never lie. Undefined when there is no DOM,
 * no video track, or no frame arrives within the timeout.
 */
export async function measureFrameSize(stream: MediaStream, options: MeasureOptions = {}): Promise<Dimensions | undefined> {
  if (typeof document === "undefined") return undefined;
  const track = stream.getVideoTracks()[0];
  if (!track) return undefined;
  const timeoutMs = options.timeoutMs ?? 3000;
  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = new MediaStream([track]);
  const current = (): Dimensions | undefined =>
    video.videoWidth > 0 && video.videoHeight > 0 ? { width: video.videoWidth, height: video.videoHeight } : undefined;
  const matches = (size: Dimensions | undefined): boolean =>
    size !== undefined && (!options.expect || (size.width === options.expect.width && size.height === options.expect.height));
  try {
    return await new Promise<Dimensions | undefined>((resolve) => {
      let last: Dimensions | undefined;
      const timer = setTimeout(() => resolve(last), timeoutMs);
      const check = (): void => {
        last = current() ?? last;
        if (matches(last)) {
          clearTimeout(timer);
          resolve(last);
        }
      };
      video.onloadedmetadata = check;
      video.onresize = check;
      video.onerror = () => {
        clearTimeout(timer);
        resolve(last);
      };
      void video.play().catch(() => undefined);
    });
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

export class CaptureHost {
  private session: Session | undefined;
  /** Session ids whose `start` is still inside `getDisplayMedia` and still wanted. */
  private readonly pending = new Set<string>();
  /**
   * `stop` arrived while the session was pending: it no longer blocks new
   * starts, and its stream is discarded when `getDisplayMedia` settles.
   */
  private readonly cancelled = new Set<string>();

  private readonly terminalTimeoutMs: number;
  private readonly measureFrameSize: FrameSizeMeasurer;

  constructor(
    private readonly port: HostPort,
    options: CaptureHostOptions = {},
  ) {
    this.terminalTimeoutMs = options.terminalTimeoutMs ?? 5000;
    this.measureFrameSize = options.measureFrameSize ?? measureFrameSize;
    port.addEventListener("message", (event) => this.handle(event.data));
    port.start();
    this.send({ type: "ready" });
  }

  private handle(data: unknown): void {
    if (!isMainMessage(data)) return;
    switch (data.type) {
      case "ping":
        this.send({ type: "pong" });
        return;
      case "start":
        void this.start(data.sessionId, data.quality);
        return;
      case "stop":
        this.stop(data.sessionId);
        return;
    }
  }

  private async start(sessionId: string, quality: QualitySettings): Promise<void> {
    if (this.session || this.pending.size > 0) {
      this.fail(sessionId, "capture_start_failed", "a recording is already in progress");
      return;
    }
    if (!MediaRecorder.isTypeSupported(OUTPUT_MIME_TYPE)) {
      this.fail(sessionId, "mp4_unsupported", OUTPUT_MIME_TYPE);
      return;
    }

    this.pending.add(sessionId);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        // The size cap is applied after the fact (`applyQuality`): it depends
        // on the source's orientation, which is only known once we have it.
        video: { frameRate: { ideal: quality.frameRate, max: quality.frameRate } },
        // Preserve system sound rather than applying voice-call processing.
        // Local v2 probes measured high-frequency loss and dual-mono with the
        // defaults; explicitly disabling EC/NS/AGC restored both. See
        // docs/system-design/audio-quality.md for the controlled comparison.
        // Keep own-audio exclusion and request stereo independently.
        audio: {
          restrictOwnAudio: true,
          channelCount: { ideal: 2 },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        } as MediaTrackConstraints,
      });
    } catch (cause) {
      if (this.cancelled.delete(sessionId)) return;
      this.pending.delete(sessionId);
      this.fail(sessionId, classifyGetDisplayMediaError(cause), describe(cause));
      return;
    }
    // The session stays in `pending` until the recorder exists: a `stop`
    // that lands during the checks or while the size constraint is applied
    // must still cancel it (`stop` only knows pending and active sessions).
    const cancelled = (): boolean => {
      if (!this.cancelled.delete(sessionId)) return false;
      // Main gave up (start timeout) while we were waiting for the OS; never
      // keep capturing with nobody listening.
      this.pending.delete(sessionId);
      stopTracks(stream);
      this.send({ type: "stopped", sessionId, tracksStoppedAt: Date.now() });
      return true;
    };
    const refuse = (code: ErrorCode, detail: string): void => {
      this.pending.delete(sessionId);
      stopTracks(stream);
      this.fail(sessionId, code, detail);
    };
    if (cancelled()) return;
    if (this.session) {
      refuse("capture_start_failed", "a recording is already in progress");
      return;
    }
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      refuse("no_audio_track", "getDisplayMedia returned no audio track");
      return;
    }
    // Electron 39+ on macOS 14.2+ uses CoreAudio Tap. Without the
    // NSAudioCaptureUsageDescription key or the "System Audio Recording"
    // grant, Chromium still hands back an audio track — already ended, never
    // delivering samples, with no error. Recording it would be a silent file.
    if (audioTracks.some((track) => track.readyState === "ended")) {
      refuse("no_audio_track", "system audio track already ended (system audio permission or NSAudioCaptureUsageDescription may be missing)");
      return;
    }

    const capture = await applyQuality(stream, quality, this.measureFrameSize);
    if (cancelled()) return;
    // Nobody listened for `ended` while the constraint was applied (review
    // pass 1, F3): a track that died meanwhile would otherwise be recorded as
    // a silent or frozen file that reports success.
    if (stream.getTracks().some((track) => track.readyState === "ended")) {
      refuse("capture_start_failed", "capture track ended while applying quality settings");
      return;
    }
    this.pending.delete(sessionId);
    if (this.session) {
      stopTracks(stream);
      this.fail(sessionId, "capture_start_failed", "a recording is already in progress");
      return;
    }

    let recorder: MediaRecorder;
    try {
      // Chromium's MP4 muxer flushes at keyframes. A timeslice alone does
      // not request them, so low-motion screen captures can buffer past the
      // main process's first-chunk deadline. Align both nominal intervals.
      const options: MediaRecorderOptions & { videoKeyFrameIntervalDuration: number } = {
        mimeType: OUTPUT_MIME_TYPE,
        videoBitsPerSecond: capture.videoBitsPerSecond,
        audioBitsPerSecond: capture.audioBitsPerSecond,
        videoKeyFrameIntervalDuration: CHUNK_INTERVAL_MS,
      };
      recorder = new MediaRecorder(stream, options);
    } catch (cause) {
      stopTracks(stream);
      this.fail(sessionId, "capture_start_failed", describe(cause));
      return;
    }

    const session: Session = {
      id: sessionId,
      stream,
      recorder,
      seq: 0,
      chain: Promise.resolve(),
      draining: false,
      handoffFailed: false,
      finished: false,
    };
    this.session = session;

    recorder.ondataavailable = (event) => this.enqueueChunk(session, event.data);
    recorder.onerror = (event) => {
      this.setFailure(session, {
        code: session.seq === 0 ? "capture_start_failed" : "capture_failed",
        detail: describe((event as ErrorEvent).error ?? "MediaRecorder error"),
      });
      // The browser emits final dataavailable and stop after error, including
      // when state is already inactive. Do not finish on the error event.
      this.armDeadline(session);
    };
    recorder.onstop = () => {
      this.sourceEnded(session);
      this.finish(session);
    };
    for (const track of stream.getTracks()) {
      track.addEventListener("ended", () => {
        if (this.session !== session || session.finished) return;
        this.sourceEnded(session);
        this.requestStop(session);
      });
    }

    try {
      recorder.start(CHUNK_INTERVAL_MS);
    } catch (cause) {
      this.session = undefined;
      stopTracks(stream);
      this.fail(sessionId, "capture_start_failed", describe(cause));
      return;
    }
    this.send({ type: "started", sessionId, mimeType: recorder.mimeType || OUTPUT_MIME_TYPE, capture });
  }

  private stop(sessionId: string): void {
    if (this.pending.delete(sessionId)) {
      this.cancelled.add(sessionId);
      return;
    }
    const session = this.session;
    if (!session || session.id !== sessionId) return;
    if (!session.cause) session.cause = "normal";
    this.requestStop(session);
  }

  private sourceEnded(session: Session): void {
    if (session.cause) return;
    const videoEnded = session.stream.getVideoTracks().some((track) => track.readyState === "ended");
    session.cause = { code: "capture_failed", detail: "capture source ended (display or audio track stopped)",
      ...(videoEnded ? { displayFailure: "track_ended" as const } : {}) };
  }

  private setFailure(session: Session, cause: Exclude<Session["cause"], "normal" | undefined>): void {
    if (session.finished) return;
    // Real encoder/handoff errors still fail a requested stop; cleanup track
    // events never overwrite the first cause.
    if (!session.cause || session.cause === "normal") session.cause = cause;
  }

  private armDeadline(session: Session): void {
    if (session.timer || session.finished) return;
    session.timer = setTimeout(() => {
      this.setFailure(session, { code: "capture_failed", detail: "capture termination timed out; final data handoff incomplete" });
      this.complete(session);
    }, this.terminalTimeoutMs);
  }

  private requestStop(session: Session): void {
    this.armDeadline(session);
    if (session.recorder.state !== "inactive") {
      try { session.recorder.stop(); }
      catch (cause) { this.setFailure(session, { code: "capture_failed", detail: describe(cause) }); }
    }
    // Inactive does not mean the queued final data/stop events have arrived.
  }

  private enqueueChunk(session: Session, blob: Blob): void {
    if (session.finished || session.draining || blob.size === 0) return;
    const seq = session.seq++;
    session.chain = session.chain.then(async () => {
      if (session.finished || session.handoffFailed) return;
      const bytes = await blob.arrayBuffer();
      if (session.finished) return;
      this.port.postMessage({ type: "chunk", sessionId: session.id, seq, bytes } satisfies HostMessage);
    }).catch((cause: unknown) => {
      session.handoffFailed = true;
      this.setFailure(session, { code: "capture_failed", detail: `chunk read failed: ${describe(cause)}` });
      this.requestStop(session);
    });
  }

  private finish(session: Session): void {
    if (session.finished || session.draining) return;
    session.draining = true;
    this.armDeadline(session);
    void session.chain.then(() => this.complete(session));
  }

  private complete(session: Session): void {
    if (session.finished) return;
    session.finished = true;
    if (session.timer) clearTimeout(session.timer);
    stopTracks(session.stream);
    const tracksStoppedAt = Date.now();
    if (this.session === session) this.session = undefined;
    const cause = session.cause;
    if (cause === "normal") this.send({ type: "stopped", sessionId: session.id, tracksStoppedAt });
    else this.fail(session.id, cause?.code ?? "capture_failed", cause?.detail ?? "capture ended", cause?.displayFailure);
  }

  private fail(sessionId: string, code: ErrorCode, detail: string, displayFailure?: "track_ended"): void {
    this.send({ type: "error", sessionId, code, detail, ...(displayFailure ? { displayFailure } : {}) });
  }

  private send(message: HostMessage): void {
    this.port.postMessage(message);
  }
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * fit the captured size into the resolution cap (same aspect
 * ratio, never upscaled), then derive the encoder targets from the size the
 * recording will have. The source size comes from the frames themselves
 * (`measureFrameSize`), falling back to `track.getSettings()` only when no
 * frame could be read; a disagreement between the two is reported as a
 * warning so the log shows it. A rejected constraint is reported as a
 * warning and the recording proceeds at the source size rather than failing.
 */
async function applyQuality(stream: MediaStream, quality: QualitySettings, measure: FrameSizeMeasurer): Promise<CaptureReport> {
  const warnings: string[] = [];
  const video = stream.getVideoTracks()[0];
  const audio = stream.getAudioTracks()[0];
  const settings: MediaTrackSettings = video?.getSettings() ?? {};
  const reported =
    finiteOrUndefined(settings.width) !== undefined && finiteOrUndefined(settings.height) !== undefined
      ? { width: settings.width as number, height: settings.height as number }
      : undefined;
  const measured = video ? await measure(stream) : undefined;
  if (measured && reported && (measured.width !== reported.width || measured.height !== reported.height)) {
    warnings.push(`track.getSettings() reported ${reported.width}x${reported.height}; actual frames ${measured.width}x${measured.height}; using actual frames`);
  }
  if (!measured && reported) warnings.push("actual frame size unavailable; using track.getSettings()");
  const source = measured ?? reported;
  // What the recording will be: after an accepted constraint the frames are
  // measured again (an accepted max is not proof of the delivered size — the
  // display could have changed meanwhile, review R2-F1); without a frame to
  // read, the target is reported with a warning.
  let actual: Dimensions | undefined = source;
  if (video && source) {
    const target = fitWithinCap(source, quality.resolutionCap);
    if (target.width !== source.width || target.height !== source.height) {
      try {
        // `applyConstraints` replaces the whole constraint set, so the frame
        // rate asked for in `getDisplayMedia` must be repeated here (F1).
        await video.applyConstraints({
          width: { ideal: target.width, max: target.width },
          height: { ideal: target.height, max: target.height },
          frameRate: { ideal: quality.frameRate, max: quality.frameRate },
        });
        const settled = await measure(stream, { expect: target, timeoutMs: 1500 });
        if (!settled) {
          warnings.push(`could not remeasure constrained frames; reporting target ${target.width}x${target.height}`);
          actual = target;
        } else {
          if (settled.width !== target.width || settled.height !== target.height) {
            warnings.push(`constrained frames ${settled.width}x${settled.height} differ from target ${target.width}x${target.height}`);
          }
          actual = settled;
        }
      } catch (cause) {
        warnings.push(`could not apply resolution cap ${quality.resolutionCap}; using source size: ${describe(cause)}`);
      }
    }
  } else if (!source) {
    warnings.push("video track has no dimensions; cannot apply resolution cap");
  }
  const encodeSize = actual ?? ASSUMED_SIZE;
  const audioSettings = audio?.getSettings() ?? {};
  for (const effect of ["echoCancellation", "noiseSuppression", "autoGainControl"] as const) {
    if (audioSettings[effect] === true) warnings.push(`system audio reports ${effect}=true despite requesting false`);
  }
  const report: CaptureReport = {
    videoBitsPerSecond: videoBitsPerSecond(encodeSize, quality.frameRate, quality.videoQuality),
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    warnings,
  };
  // Only fields we know; `undefined` must not travel as a key with exactOptionalPropertyTypes.
  if (actual) {
    report.width = actual.width;
    report.height = actual.height;
  }
  const afterSettings: MediaTrackSettings = video?.getSettings() ?? settings;
  const frameRate = finiteOrUndefined(afterSettings.frameRate);
  if (frameRate !== undefined) report.frameRate = frameRate;
  const sampleRate = finiteOrUndefined(audioSettings.sampleRate);
  if (sampleRate !== undefined) report.sampleRate = sampleRate;
  const channelCount = finiteOrUndefined(audioSettings.channelCount);
  if (channelCount !== undefined) report.channelCount = channelCount;
  return report;
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.name ? `${cause.name}: ${cause.message}` : cause.message;
  return String(cause);
}

function classifyGetDisplayMediaError(cause: unknown): ErrorCode {
  const name = cause instanceof Error ? cause.name : "";
  if (name === "NotAllowedError") return "permission_denied";
  if (name === "NotFoundError") return "no_display";
  return "capture_start_failed";
}

if (typeof window !== "undefined") {
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data !== "capture-host-port") return;
    const [port] = event.ports;
    if (!port) return;
    new CaptureHost(port);
  });
}
