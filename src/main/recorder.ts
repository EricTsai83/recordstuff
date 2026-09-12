/**
 * The state machine (plans/001-first-version.md §12) and the single owner of `RecordingState`
 * (§19-2). Everything with side effects — capture host, file writer, clock —
 * is injected, so this file has no Electron import and is unit-testable.
 *
 * Failure never fakes success: any error goes back to `idle` with a `failed`
 * event and, when bytes were written, a kept `.recording.mp4` (§19-3).
 */
import path from "node:path";
import type { HostMessage } from "../shared/protocol";
import { describeCapture, type CaptureReport, type QualitySettings } from "../shared/quality";
import { isErrorCode, type ErrorCode, type RecordingState } from "../shared/state";

export interface RecorderWriter {
  append(bytes: Uint8Array): Promise<void>;
  /** Flush, close and rename; resolves with the final path. */
  finish(): Promise<string>;
  /** Close and keep the partial file; resolves with its path if it was kept. */
  abandon(): Promise<string | undefined>;
}

export interface RecorderHost {
  /** Ensures the capture host is up and posts `start` with the quality snapshot; rejects if it cannot. */
  start(sessionId: string, quality: QualitySettings): Promise<void>;
  stop(sessionId: string): void;
  onMessage(listener: (message: HostMessage) => void): void;
  onFailure(
    listener: (code: "capture_host_crashed" | "capture_host_unresponsive", detail: string) => void,
  ): void;
}

export interface RecorderDeps {
  host: RecorderHost;
  outputDir: () => string;
  /** Read once per session when it starts; later changes affect the next recording only (plan 007). */
  quality: () => QualitySettings;
  ensureWritableDir: (dir: string) => Promise<void>;
  openWriter: (recordingPath: string, finalPath: string) => Promise<RecorderWriter>;
  now?: () => Date;
  newSessionId?: () => string;
  /** Returns an error code when recording is impossible on this machine. */
  preflight?: () => ErrorCode | undefined;
  /**
   * Lets the owner replace a host-reported error code with the real cause it
   * knows about (e.g. main denied the display-media request for `no_display`).
   */
  mapHostError?: (code: ErrorCode) => ErrorCode;
  /** Called when a new session begins; lets the owner reset per-session state. */
  onSessionStart?: (sessionId: string) => void;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  log?: (message: string) => void;
}

export type RecorderEvent =
  | { type: "state"; state: RecordingState }
  | { type: "saved"; path: string }
  /** The host confirmed capture; `requested` is the session snapshot, `capture` what it got. */
  | { type: "captureStarted"; requested: QualitySettings; capture: CaptureReport }
  | { type: "failed"; code: ErrorCode; detail: string; partialPath?: string }
  | { type: "permissionRequested"; needsRelaunch: boolean };

export interface PermissionStatus {
  granted: boolean;
  needsRelaunch: boolean;
}

interface Session {
  id: string;
  phase: "opening" | "starting" | "recording" | "stopping";
  /** Quality snapshot taken when the session was created (plan 007 §B2). */
  quality: QualitySettings;
  /** `stopped` arrived and the writer is being finished; a hard cap must not call this a failure. */
  finalizing: boolean;
  writer?: RecorderWriter;
  nextSeq: number;
  timer?: ReturnType<typeof setTimeout> | undefined;
  /** Last append; awaited before finishing so the final chunk is on disk. */
  writes: Promise<void>;
}

const DEFAULT_START_TIMEOUT_MS = 8000;
const MAX_NAME_ATTEMPTS = 10;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
/** After the quit cap fires, how long to still wait for the partial file to close. */
const SHUTDOWN_GRACE_MS = 3000;

/** `2026-09-11 14-30-00`, local time, safe on every file system. */
export function formatTimestamp(date: Date): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
    `${two(date.getHours())}-${two(date.getMinutes())}-${two(date.getSeconds())}`
  );
}

export function errorCodeOf(cause: unknown, fallback: ErrorCode): ErrorCode {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code: unknown }).code;
    if (isErrorCode(code)) return code;
  }
  return fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class Recorder {
  private _state: RecordingState = { type: "idle" };
  private session: Session | undefined;
  /** The `abandon()` of the last failure; `shutdown()` waits for it. */
  private pendingFailure: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(event: RecorderEvent) => void>();
  private readonly deps: Required<
    Pick<RecorderDeps, "now" | "newSessionId" | "startTimeoutMs" | "stopTimeoutMs" | "log">
  > &
    RecorderDeps;

  constructor(deps: RecorderDeps) {
    this.deps = {
      now: () => new Date(),
      newSessionId: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      startTimeoutMs: DEFAULT_START_TIMEOUT_MS,
      stopTimeoutMs: DEFAULT_STOP_TIMEOUT_MS,
      log: () => undefined,
      ...deps,
    };
    deps.host.onMessage((message) => this.handleHostMessage(message));
    deps.host.onFailure((code, detail) => this.handleHostFailure(code, detail));
  }

  get state(): RecordingState {
    return this._state;
  }

  subscribe(listener: (event: RecorderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Left click (ADR-7): start when idle, stop when recording, else ignore. */
  toggle(): void {
    switch (this._state.type) {
      case "idle":
        void this.start();
        return;
      case "recording":
        this.stop();
        return;
      case "needsPermission":
        this.emit({ type: "permissionRequested", needsRelaunch: this._state.needsRelaunch });
        return;
      case "starting":
      case "stopping":
        return;
    }
  }

  stop(): void {
    const session = this.session;
    if (this._state.type !== "recording" || !session || session.phase !== "recording") return;
    session.phase = "stopping";
    this.setState({ type: "stopping" });
    this.clearTimer(session);
    session.timer = setTimeout(() => {
      void this.fail(session.id, "stop_timeout", "capture host 未在時限內停止");
    }, this.deps.stopTimeoutMs);
    this.deps.host.stop(session.id);
  }

  /**
   * Quit path (§12): let a start finish, then stop and wait for the state to
   * settle. Bounded by the start and stop timeouts.
   */
  async shutdown(): Promise<void> {
    const session = this.session;
    if (!session) {
      await this.pendingFailure;
      return;
    }
    // Hard cap (plans/001-first-version.md §12): past the stop timeout, stop waiting for the host.
    // If the host never answered, close the file as is and keep
    // `.recording.mp4`, giving the close a short grace period. If the host did
    // stop and only the final fsync/rename is slow, let it finish in the
    // background rather than report a failure for a file that may be saved.
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    const capReached = new Promise<"capped">((resolve) => {
      capTimer = setTimeout(() => resolve("capped"), this.deps.stopTimeoutMs);
    });
    const settled = (async (): Promise<"settled"> => {
      while (this._state.type === "starting") await this.nextStateChange();
      if (this._state.type === "recording") this.stop();
      while (this._state.type === "stopping") await this.nextStateChange();
      await this.pendingFailure;
      return "settled";
    })();
    const outcome = await Promise.race([settled, capReached]);
    if (capTimer) clearTimeout(capTimer);
    if (outcome === "settled") return;
    if (this.session === session && !session.finalizing) {
      const failing = this.fail(session.id, "stop_timeout", "結束時停止錄製逾時，保留部分錄影");
      await Promise.race([failing, delay(SHUTDOWN_GRACE_MS)]);
    }
  }

  /** macOS only. A permission change never interrupts a running session. */
  setPermission(status: PermissionStatus): void {
    if (!status.granted) {
      const unchanged =
        this._state.type === "needsPermission" && this._state.needsRelaunch === status.needsRelaunch;
      if (this._state.type === "idle" || (this._state.type === "needsPermission" && !unchanged)) {
        this.setState({ type: "needsPermission", needsRelaunch: status.needsRelaunch });
      }
      return;
    }
    if (this._state.type === "needsPermission") this.setState({ type: "idle" });
  }

  /** The user picked a new folder; forget that the old one was unusable. */
  outputDirChanged(): void {
    if (this._state.type === "idle" && this._state.outputDirUnavailable) {
      const { outputDirUnavailable: _drop, ...rest } = this._state;
      this.setState(rest);
    }
  }

  private async start(): Promise<void> {
    if (this._state.type !== "idle" || this.session) return;
    const blocker = this.deps.preflight?.();
    if (blocker) {
      this.emit({ type: "failed", code: blocker, detail: "" });
      return;
    }

    const session: Session = {
      id: this.deps.newSessionId(),
      phase: "opening",
      quality: this.deps.quality(),
      finalizing: false,
      nextSeq: 0,
      writes: Promise.resolve(),
    };
    this.session = session;
    this.deps.onSessionStart?.(session.id);
    this.setState({ type: "starting" });
    // One deadline covers directory check, file open, host start and first
    // chunk, so a hung external volume cannot leave us in `starting` forever.
    session.timer = setTimeout(() => {
      if (session.phase === "opening") {
        void this.fail(session.id, "output_open_failed", this.deps.outputDir(), { outputDirUnavailable: true });
      } else {
        void this.fail(session.id, "capture_start_failed", "capture host 未在時限內送出畫面");
      }
    }, this.deps.startTimeoutMs);

    const dir = this.deps.outputDir();
    try {
      await this.deps.ensureWritableDir(dir);
    } catch {
      await this.fail(session.id, "output_open_failed", dir, { outputDirUnavailable: true });
      return;
    }
    if (this.session !== session) return;

    const stamp = formatTimestamp(this.deps.now());
    try {
      session.writer = await this.openUniqueWriter(dir, stamp);
    } catch (cause) {
      await this.fail(session.id, errorCodeOf(cause, "output_open_failed"), messageOf(cause), {
        outputDirUnavailable: true,
      });
      return;
    }
    if (this.session !== session) {
      await session.writer.abandon();
      return;
    }

    session.phase = "starting";
    try {
      await this.deps.host.start(session.id, session.quality);
    } catch (cause) {
      await this.fail(session.id, "capture_start_failed", messageOf(cause));
    }
  }

  /**
   * One-second timestamps can collide with a partial file kept by a failure
   * moments earlier; that is not an unusable folder, so try `-2`, `-3`, ….
   */
  private async openUniqueWriter(dir: string, stamp: string): Promise<RecorderWriter> {
    for (let attempt = 1; ; attempt += 1) {
      const name = attempt === 1 ? stamp : `${stamp}-${attempt}`;
      try {
        return await this.deps.openWriter(
          path.join(dir, `${name}.recording.mp4`),
          path.join(dir, `${name}.mp4`),
        );
      } catch (cause) {
        const errno =
          typeof cause === "object" && cause !== null && "cause" in cause
            ? (cause as { cause?: { code?: unknown } }).cause?.code
            : undefined;
        if (errno !== "EEXIST" || attempt >= MAX_NAME_ATTEMPTS) throw cause;
      }
    }
  }

  private handleHostMessage(message: HostMessage): void {
    if (message.type === "ready" || message.type === "pong") return;
    const session = this.session;
    if (message.type === "error") {
      if (session && (message.sessionId === undefined || message.sessionId === session.id)) {
        const code = this.deps.mapHostError ? this.deps.mapHostError(message.code) : message.code;
        void this.fail(session.id, code, message.detail);
      }
      return;
    }
    if (!session || message.sessionId !== session.id) {
      // A session we already gave up on (e.g. start timed out while the host
      // was still inside getDisplayMedia) must not keep capturing unseen.
      if (message.type === "started" || message.type === "chunk") {
        this.deps.log(`recorder: stopping stale session ${message.sessionId} (${message.type})`);
        this.deps.host.stop(message.sessionId);
      }
      return;
    }
    switch (message.type) {
      case "started":
        if (session.phase === "starting") {
          session.phase = "recording";
          this.deps.log(`recorder: session ${session.id} capture: ${describeCapture(session.quality, message.capture)}`);
          this.setState({ type: "recording", startedAt: this.deps.now().toISOString() });
          this.emit({ type: "captureStarted", requested: session.quality, capture: message.capture });
        }
        return;
      case "chunk":
        this.handleChunk(session, message.seq, message.bytes);
        return;
      case "stopped":
        if (session.phase === "stopping") {
          this.clearTimer(session);
          session.finalizing = true;
          void this.finalize(session);
        } else {
          void this.fail(session.id, "capture_failed", "capture host 在未要求停止時結束了擷取");
        }
        return;
    }
  }

  private handleChunk(session: Session, seq: number, bytes: ArrayBuffer): void {
    if (session.phase !== "starting" && session.phase !== "recording" && session.phase !== "stopping") {
      return;
    }
    if (seq !== session.nextSeq) {
      void this.fail(session.id, "capture_failed", `chunk 順序錯誤：預期 ${session.nextSeq}，收到 ${seq}`);
      return;
    }
    session.nextSeq += 1;
    if (seq === 0 && session.phase !== "stopping") this.clearTimer(session);
    const writer = session.writer;
    if (!writer) return;
    const write = writer.append(new Uint8Array(bytes));
    session.writes = write.then(
      () => undefined,
      (cause: unknown) => {
        void this.fail(session.id, errorCodeOf(cause, "output_write_failed"), messageOf(cause));
      },
    );
  }

  private async finalize(session: Session): Promise<void> {
    await session.writes;
    if (this.session !== session || !session.writer) return;
    let finalPath: string;
    try {
      finalPath = await session.writer.finish();
    } catch (cause) {
      await this.fail(session.id, errorCodeOf(cause, "output_write_failed"), messageOf(cause));
      return;
    }
    if (this.session !== session) return;
    this.session = undefined;
    this.setState({ type: "idle", lastSavedPath: finalPath });
    this.emit({ type: "saved", path: finalPath });
  }

  private handleHostFailure(
    code: "capture_host_crashed" | "capture_host_unresponsive",
    detail: string,
  ): void {
    if (this.session) void this.fail(this.session.id, code, detail);
  }

  private async fail(
    sessionId: string,
    code: ErrorCode,
    detail: string,
    idleFlags: { outputDirUnavailable?: boolean } = {},
  ): Promise<void> {
    const session = this.session;
    if (!session || session.id !== sessionId) return;
    this.session = undefined;
    this.clearTimer(session);
    if (session.phase !== "opening") this.deps.host.stop(session.id);
    this.deps.log(`recorder: session ${session.id} failed: ${code} ${detail}`);
    // The icon must never claim "recording" once the session is dead, even if
    // closing the file takes long on a stalled disk (plans/001-first-version.md §19-3).
    this.setState({ type: "idle", ...idleFlags });
    const finish = (async (): Promise<void> => {
      const partialPath = session.writer ? await session.writer.abandon() : undefined;
      this.emit(
        partialPath === undefined
          ? { type: "failed", code, detail }
          : { type: "failed", code, detail, partialPath },
      );
    })();
    this.pendingFailure = finish;
    await finish;
  }

  private clearTimer(session: Session): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = undefined;
  }

  private setState(state: RecordingState): void {
    this._state = state;
    this.emit({ type: "state", state });
  }

  private emit(event: RecorderEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private nextStateChange(): Promise<void> {
    return new Promise((resolve) => {
      const unsubscribe = this.subscribe((event) => {
        if (event.type !== "state") return;
        unsubscribe();
        resolve();
      });
    });
  }
}
