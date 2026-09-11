/**
 * The hidden capture host (plans/001-first-version.md §5, §9): `getDisplayMedia` (main decides
 * the source and adds `audio: 'loopback'`) → `MediaRecorder` producing
 * fragmented MP4 (H.264 + AAC) → one chunk per second over the MessagePort.
 * It never touches the file system; main writes every byte.
 */
import { CHUNK_INTERVAL_MS, OUTPUT_MIME_TYPE, isMainMessage, type HostMessage } from "../shared/protocol";
import type { ErrorCode } from "../shared/state";

/** Chromium's best-effort target for 1080p30 H.264. */
const VIDEO_BITS_PER_SECOND = 8_000_000;

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
        void this.start(data.sessionId);
        return;
      case "stop":
        this.stop(data.sessionId);
        return;
    }
  }

  private async start(sessionId: string): Promise<void> {
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
        video: { frameRate: { ideal: 30, max: 30 } },
        // `restrictOwnAudio` (Electron 43+) keeps this app's own sounds out.
        audio: { restrictOwnAudio: true } as MediaTrackConstraints,
      });
    } catch (cause) {
      if (this.cancelled.delete(sessionId)) return;
      this.pending.delete(sessionId);
      this.fail(sessionId, classifyGetDisplayMediaError(cause), describe(cause));
      return;
    }
    if (this.cancelled.delete(sessionId)) {
      // Main gave up (start timeout) while we were waiting for the OS; never
      // keep capturing with nobody listening.
      stopTracks(stream);
      this.send({ type: "stopped", sessionId });
      return;
    }
    this.pending.delete(sessionId);
    if (this.session) {
      stopTracks(stream);
      this.fail(sessionId, "capture_start_failed", "已有進行中的錄製");
      return;
    }
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stopTracks(stream);
      this.fail(sessionId, "no_audio_track", "getDisplayMedia 沒有回傳音訊軌");
      return;
    }
    // Electron 39+ on macOS 14.2+ uses CoreAudio Tap. Without the
    // NSAudioCaptureUsageDescription key or the "System Audio Recording"
    // grant, Chromium still hands back an audio track — already ended, never
    // delivering samples, with no error. Recording it would be a silent file.
    if (audioTracks.some((track) => track.readyState === "ended")) {
      stopTracks(stream);
      this.fail(sessionId, "no_audio_track", "系統音訊軌已結束（macOS 未授權「系統音訊錄製」或缺少 NSAudioCaptureUsageDescription）");
      return;
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: OUTPUT_MIME_TYPE,
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
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
    this.send({ type: "started", sessionId, mimeType: recorder.mimeType || OUTPUT_MIME_TYPE });
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
