/**
 * The hidden capture host (plans/001-first-version.md §5, §9): `getDisplayMedia` (main decides
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
  stopRequested: boolean;
  finished: boolean;
}

/** The subset of `MessagePort` the host uses; lets tests pass a fake. */
export interface HostPort {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  start(): void;
  postMessage(message: unknown): void;
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

  constructor(private readonly port: HostPort) {
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
      this.fail(sessionId, "capture_start_failed", "已有進行中的錄製");
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
        // `restrictOwnAudio` (Electron 43+) keeps this app's own sounds out.
        audio: { restrictOwnAudio: true } as MediaTrackConstraints,
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
      this.send({ type: "stopped", sessionId });
      return true;
    };
    const refuse = (code: ErrorCode, detail: string): void => {
      this.pending.delete(sessionId);
      stopTracks(stream);
      this.fail(sessionId, code, detail);
    };
    if (cancelled()) return;
    if (this.session) {
      refuse("capture_start_failed", "已有進行中的錄製");
      return;
    }
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      refuse("no_audio_track", "getDisplayMedia 沒有回傳音訊軌");
      return;
    }
    // Electron 39+ on macOS 14.2+ uses CoreAudio Tap. Without the
    // NSAudioCaptureUsageDescription key or the "System Audio Recording"
    // grant, Chromium still hands back an audio track — already ended, never
    // delivering samples, with no error. Recording it would be a silent file.
    if (audioTracks.some((track) => track.readyState === "ended")) {
      refuse("no_audio_track", "系統音訊軌已結束（macOS 未授權「系統音訊錄製」或缺少 NSAudioCaptureUsageDescription）");
      return;
    }

    const capture = await applyQuality(stream, quality);
    if (cancelled()) return;
    // Nobody listened for `ended` while the constraint was applied (review
    // pass 1, F3): a track that died meanwhile would otherwise be recorded as
    // a silent or frozen file that reports success.
    if (stream.getTracks().some((track) => track.readyState === "ended")) {
      refuse("capture_start_failed", "套用品質設定期間擷取軌已結束");
      return;
    }
    this.pending.delete(sessionId);
    if (this.session) {
      stopTracks(stream);
      this.fail(sessionId, "capture_start_failed", "已有進行中的錄製");
      return;
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: OUTPUT_MIME_TYPE,
        videoBitsPerSecond: capture.videoBitsPerSecond,
        audioBitsPerSecond: capture.audioBitsPerSecond,
      });
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
      stopRequested: false,
      finished: false,
    };
    this.session = session;

    recorder.ondataavailable = (event) => this.enqueueChunk(session, event.data);
    recorder.onerror = (event) => {
      const detail = describe((event as ErrorEvent).error ?? "MediaRecorder error");
      this.finish(session, () => this.fail(session.id, session.seq === 0 ? "capture_start_failed" : "capture_failed", detail));
    };
    recorder.onstop = () => {
      this.finish(session, () => {
        if (session.stopRequested) this.send({ type: "stopped", sessionId: session.id });
        else this.fail(session.id, "capture_failed", "擷取來源結束（螢幕或音訊軌已停止）");
      });
    };
    for (const track of stream.getTracks()) {
      track.addEventListener("ended", () => {
        if (this.session === session && recorder.state !== "inactive") recorder.stop();
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
    if (session.stopRequested) return;
    session.stopRequested = true;
    if (session.recorder.state === "inactive") {
      this.finish(session, () => this.send({ type: "stopped", sessionId: session.id }));
      return;
    }
    // `stop()` flushes a final dataavailable before firing `onstop`.
    session.recorder.stop();
  }

  private enqueueChunk(session: Session, blob: Blob): void {
    if (blob.size === 0) return;
    const seq = session.seq;
    session.seq += 1;
    session.chain = session.chain
      .then(async () => {
        const bytes = await blob.arrayBuffer();
        // Copied, not transferred: on Electron 44 a transferred ArrayBuffer
        // over a MessagePort hangs the main process (verified with a probe).
        // One second of media (~1 MB) per copy is negligible.
        this.port.postMessage({ type: "chunk", sessionId: session.id, seq, bytes } satisfies HostMessage);
      })
      .catch((cause: unknown) => {
        this.fail(session.id, "capture_failed", `chunk 讀取失敗：${describe(cause)}`);
      });
  }

  /** Runs `then` after every pending chunk has been posted, exactly once. */
  private finish(session: Session, then: () => void): void {
    if (session.finished) return;
    session.finished = true;
    stopTracks(session.stream);
    void session.chain.then(() => {
      if (this.session === session) this.session = undefined;
      then();
    });
  }

  private fail(sessionId: string, code: ErrorCode, detail: string): void {
    this.send({ type: "error", sessionId, code, detail });
  }

  private send(message: HostMessage): void {
    this.port.postMessage(message);
  }
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Plan 007 §B2: fit the captured size into the resolution cap (same aspect
 * ratio, never upscaled), then derive the encoder targets from the size the
 * track actually settled on. A rejected constraint is reported as a warning
 * and the recording proceeds at the source size rather than failing.
 */
async function applyQuality(stream: MediaStream, quality: QualitySettings): Promise<CaptureReport> {
  const warnings: string[] = [];
  const video = stream.getVideoTracks()[0];
  const audio = stream.getAudioTracks()[0];
  let settings: MediaTrackSettings = video?.getSettings() ?? {};
  const width = finiteOrUndefined(settings.width);
  const height = finiteOrUndefined(settings.height);
  if (video && width !== undefined && height !== undefined) {
    const target = fitWithinCap({ width, height }, quality.resolutionCap);
    if (target.width !== width || target.height !== height) {
      try {
        // `applyConstraints` replaces the whole constraint set, so the frame
        // rate asked for in `getDisplayMedia` must be repeated here (F1).
        await video.applyConstraints({
          width: { ideal: target.width, max: target.width },
          height: { ideal: target.height, max: target.height },
          frameRate: { ideal: quality.frameRate, max: quality.frameRate },
        });
        settings = video.getSettings();
      } catch (cause) {
        warnings.push(`解析度上限 ${quality.resolutionCap} 無法套用，以來源尺寸錄製：${describe(cause)}`);
      }
    }
  } else {
    warnings.push("video track 未回報尺寸，無法套用解析度上限");
  }
  const actual = {
    width: finiteOrUndefined(settings.width),
    height: finiteOrUndefined(settings.height),
  };
  const encodeSize =
    actual.width !== undefined && actual.height !== undefined ? { width: actual.width, height: actual.height } : ASSUMED_SIZE;
  const audioSettings = audio?.getSettings() ?? {};
  const report: CaptureReport = {
    videoBitsPerSecond: videoBitsPerSecond(encodeSize, quality.frameRate, quality.videoQuality),
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    warnings,
  };
  // Only fields the platform reported; `undefined` must not travel as a key
  // with exactOptionalPropertyTypes.
  if (actual.width !== undefined) report.width = actual.width;
  if (actual.height !== undefined) report.height = actual.height;
  const frameRate = finiteOrUndefined(settings.frameRate);
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
