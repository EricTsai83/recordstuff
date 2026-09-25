import type { RecordingFailure } from "../shared/recording-result";
import type { DisplayFailure } from "../shared/display";
/**
 * The state machine (docs/system-design/recording.md) and the single owner of `RecordingState`
 *. Everything with side effects — capture host, file writer, clock —
 * is injected, so this file has no Electron import and is unit-testable.
 *
 * Failure never fakes success: any error goes back to `idle` with a `failed`
 * event and, when bytes were written, a kept `.recording.mp4`.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { HostMessage } from "../shared/protocol";
import { describeCapture, type CaptureReport, type QualitySettings } from "../shared/quality";
import { isErrorCode, type ErrorCode, type RecordingState } from "../shared/state";

export interface RecorderWriter {
  readonly recordingPath?: string;
  readonly preservationUncertain?: boolean;
  append(bytes: Uint8Array): Promise<void>;
  /**
   * Flush, close and rename; resolves with the final path. Rejects instead of
   * publishing zero confirmed bytes, after any retained write/sync error.
   */
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
  /** Read once per session when it starts; later changes affect the next recording only. */
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
  /** Time for the OS capture request, including interactive permission prompts. */
  captureRequestTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Quit may allow stop-response failure cleanup a small additional margin. */
  shutdownTimeoutMs?: number;
  log?: (message: string) => void;
  /** Result verification/publication is part of the attempt’s owned work. */
  publishFailure?: (result: RecordingFailure) => Promise<void>;
}

export type RecorderEvent =
  | { type: "failureStatus"; result: RecordingFailure }
  | { type: "state"; state: RecordingState }
  | { type: "saved"; path: string }
  /** The host confirmed capture; `requested` is the session snapshot, `capture` what it got. */
  | { type: "captureStarted"; requested: QualitySettings; capture: CaptureReport }
  | { type: "displayFailed"; detail: DisplayFailure }
  | { type: "failed"; code: ErrorCode; detail: string; partialPath?: string }
  | { type: "permissionRequested"; needsRelaunch: boolean };

export interface PermissionStatus {
  granted: boolean;
  needsRelaunch: boolean;
}

interface Session {
  id: string;
  phase: "opening" | "starting" | "recording" | "stopping";
  /** Quality snapshot taken when the session was created. */
  quality: QualitySettings;
  /** `stopped` arrived and the writer is being finished; a hard cap must not call this a failure. */
  finalizing: boolean;
  stopOnStart: boolean;
  /** A nonempty chunk arrived; empty chunks neither satisfy the first-media deadline nor count as media. */
  hasMedia: boolean;
  writer?: RecorderWriter;
  opening?: Promise<void>;
  nextSeq: number;
  timer?: ReturnType<typeof setTimeout> | undefined;
  /** Last append; awaited before finishing so the final chunk is on disk. */
  writes: Promise<void>;
}

const DEFAULT_START_TIMEOUT_MS = 8000;
const DEFAULT_CAPTURE_REQUEST_TIMEOUT_MS = 120_000;
const MAX_NAME_ATTEMPTS = 10;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;

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

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class Recorder {
  private _state: RecordingState = { type: "idle" };
  private session: Session | undefined;
  /** Registered before any synchronous subscriber can request exit. */
  private readonly work = new Set<Promise<void>>();
  private shuttingDown: Promise<boolean> | undefined;
  private quitAdmission = false;
  private readonly workChanged = new Set<() => void>();
  private readonly listeners = new Set<(event: RecorderEvent) => void>();
  private readonly deps: Required<
    Pick<RecorderDeps, "now" | "newSessionId" | "startTimeoutMs" | "captureRequestTimeoutMs" | "stopTimeoutMs" | "shutdownTimeoutMs" | "log">
  > &
    RecorderDeps;

  constructor(deps: RecorderDeps) {
    this.deps = {
      now: () => new Date(),
      newSessionId: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      startTimeoutMs: DEFAULT_START_TIMEOUT_MS,
      captureRequestTimeoutMs: DEFAULT_CAPTURE_REQUEST_TIMEOUT_MS,
      stopTimeoutMs: DEFAULT_STOP_TIMEOUT_MS,
      shutdownTimeoutMs: (deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS) + 3000,
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
      void this.fail(session.id, "stop_timeout", "capture host did not stop before the deadline");
    }, this.deps.stopTimeoutMs);
    this.deps.host.stop(session.id);
  }

  /** False means quit was deferred; outstanding work remains owned by this recorder. */
  shutdown(): Promise<boolean> {
    if (this.shuttingDown) return this.shuttingDown;
    this.quitAdmission = true;
    if (this.session && (this.session.phase === "opening" || this.session.phase === "starting")) {
      this.session.stopOnStart = true;
    }
    // Defer execution until the shared promise is installed (stop can emit synchronously).
    const attempt = Promise.resolve().then(() => new Promise<boolean>((resolve) => {
      let checking = false;
      const finish = (safe: boolean): void => {
        clearTimeout(timer);
        unsubscribe();
        this.workChanged.delete(check);
        resolve(safe);
      };
      const check = (): void => {
        if (checking) return;
        checking = true;
        if (this._state.type === "recording") this.stop();
        checking = false;
        if (!this.session && this.work.size === 0) finish(true);
      };
      const unsubscribe = this.subscribe((event) => { if (event.type === "state") check(); });
      this.workChanged.add(check);
      const timer = setTimeout(() => {
        // Capture's own start/stop timers own failure. A quit deadline cannot
        // cancel an in-flight permission request or a filesystem operation.
        finish(false);
      }, this.deps.shutdownTimeoutMs);
      check();
    }));
    this.shuttingDown = attempt;
    void attempt.then((safe) => {
      this.shuttingDown = undefined;
      if (!safe) this.quitAdmission = false;
    }, () => { this.shuttingDown = undefined; this.quitAdmission = false; });
    return attempt;
  }

  /** Quit was declined after capture drained (for example unsaved history): admit recordings again. */
  resumeAdmission(): void {
    if (!this.shuttingDown) this.quitAdmission = false;
  }

  private track(task: () => Promise<void>): Promise<void> {
    let release!: () => void;
    const owned = new Promise<void>((resolve) => { release = resolve; });
    this.work.add(owned);
    const result = task();
    return result.finally(() => { this.work.delete(owned); release(); for (const changed of this.workChanged) changed(); });
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

  private start(): Promise<void> {
    return this.track(() => this.startOwned());
  }

  private async startOwned(): Promise<void> {
    if (this.quitAdmission || this._state.type !== "idle" || this.session) return;
    const blocker = this.deps.preflight?.();
    if (blocker) {
      const result: RecordingFailure = { id: randomUUID(), occurredAt: this.deps.now().toISOString(),
        code: blocker, detail: "", outcome: "pending" };
      await this.publishFailure(result);
      await this.publishFailure({ ...result, outcome: "empty" });
      this.emit({ type: "failed", code: blocker, detail: "" });
      return;
    }

    const session: Session = {
      id: this.deps.newSessionId(),
      phase: "opening",
      quality: this.deps.quality(),
      finalizing: false,
      stopOnStart: false,
      hasMedia: false,
      nextSeq: 0,
      writes: Promise.resolve(),
    };
    this.session = session;
    const dir = this.deps.outputDir();
    session.opening = Promise.resolve().then(async () => {
      await this.deps.ensureWritableDir(dir);
      if (this.session !== session) return;
      session.writer = await this.openUniqueWriter(dir, formatTimestamp(this.deps.now()));
    });
    this.deps.onSessionStart?.(session.id);
    this.setState({ type: "starting" });
    session.timer = setTimeout(() => {
      void this.fail(session.id, "output_open_failed", dir, { outputDirUnavailable: true });
    }, this.deps.startTimeoutMs);
    try {
      await session.opening;
    } catch (cause) {
      await this.fail(session.id, errorCodeOf(cause, "output_open_failed"), messageOf(cause), {
        outputDirUnavailable: true,
      });
      return;
    }
    // A timed-out opening belongs to the failure owner, including its late handle.
    if (this.session !== session) return;

    session.phase = "starting";
    this.clearTimer(session);
    session.timer = setTimeout(() => {
      void this.fail(session.id, "capture_start_failed", "screen/audio capture request timed out; complete system permission prompts and retry");
    }, this.deps.captureRequestTimeoutMs);
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
      if (session && !session.finalizing && (message.sessionId === undefined || message.sessionId === session.id)) {
        const code = this.deps.mapHostError ? this.deps.mapHostError(message.code) : message.code;
        if (message.displayFailure && !session.finalizing) this.emit({ type: "displayFailed", detail: message.displayFailure });
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
          this.clearTimer(session);
          if (!session.hasMedia) {
            session.timer = setTimeout(() => {
              void this.fail(session.id, "capture_start_failed", "capture host did not send media before the deadline");
            }, this.deps.startTimeoutMs);
          }
          this.deps.log(`recorder: session ${session.id} capture: ${describeCapture(session.quality, message.capture)}`);
          this.setState({ type: "recording", startedAt: this.deps.now().toISOString() });
          if (session.stopOnStart) this.stop();
          this.emit({ type: "captureStarted", requested: session.quality, capture: message.capture });
        }
        return;
      case "chunk":
        this.handleChunk(session, message.seq, message.bytes);
        return;
      case "stopped":
        if (session.finalizing) return;
        this.deps.log(`recorder: session ${session.id} host stopped; tracksStoppedAt=${message.tracksStoppedAt ?? "unknown"}`);
        if (session.phase === "stopping") {
          this.clearTimer(session);
          session.finalizing = true;
          void this.track(() => this.finalize(session));
        } else {
          void this.fail(session.id, "capture_failed", "capture host ended capture without a stop request");
        }
        return;
    }
  }

  private handleChunk(session: Session, seq: number, bytes: ArrayBuffer): void {
    if (session.finalizing) return;
    if (session.phase !== "starting" && session.phase !== "recording" && session.phase !== "stopping") {
      return;
    }
    if (seq !== session.nextSeq) {
      void this.fail(session.id, "capture_failed", `chunk sequence mismatch: expected ${session.nextSeq}, received ${seq}`);
      return;
    }
    session.nextSeq += 1;
    if (!session.hasMedia && bytes.byteLength > 0) {
      session.hasMedia = true;
      this.deps.log(`recorder: session ${session.id} first chunk ${bytes.byteLength} bytes`);
      if (session.phase !== "stopping") this.clearTimer(session);
    }
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
      // Zero confirmed bytes arrive here as capture_start_failed; disk errors keep their code.
      await this.fail(session.id, errorCodeOf(cause, "output_write_failed"), messageOf(cause));
      return;
    }
    if (this.session !== session) return;
    this.deps.log(`recorder: session ${session.id} file finalized ${finalPath}`);
    this.session = undefined;
    this.setState({ type: "idle", lastSavedPath: finalPath });
    this.emit({ type: "saved", path: finalPath });
  }

  /** Display loss shares the idempotent failure path with track end and host failure. */
  displayRemoved(): void {
    const session = this.session;
    if (session && !session.finalizing) {
      this.emit({ type: "displayFailed", detail: "target_removed" });
      void this.fail(session.id, "capture_failed", "recording display removed");
    }
  }

  private handleHostFailure(
    code: "capture_host_crashed" | "capture_host_unresponsive",
    detail: string,
  ): void {
    if (this.session && !this.session.finalizing) void this.fail(this.session.id, code, detail);
  }

  private fail(
    sessionId: string,
    code: ErrorCode,
    detail: string,
    idleFlags: { outputDirUnavailable?: boolean } = {},
  ): Promise<void> {
    return this.track(() => this.failOwned(sessionId, code, detail, idleFlags));
  }

  private async failOwned(
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
    // End the recording state before file cleanup. Native painting can still
    // wait on synchronous subscriber IO (docs/system-design/recording.md).
    const result: RecordingFailure = { id: randomUUID(), occurredAt: this.deps.now().toISOString(),
      code, detail, outcome: "pending", ...(session.writer?.recordingPath ? { recordingPath: session.writer.recordingPath } : {}) };
    // Set idle and request tray updates before synchronous metadata persistence.
    this.setState({ type: "idle", ...idleFlags });
    await this.publishFailure(result);
    const finish = (async (): Promise<void> => {
      let partialPath: string | undefined;
      let outcome: RecordingFailure["outcome"] = "empty";
      try {
        await session.opening?.catch(() => undefined);
        partialPath = session.writer ? await session.writer.abandon() : undefined;
        outcome = session.writer?.preservationUncertain ? "unknown" : partialPath ? "partial" : "empty";
        if (outcome === "unknown") partialPath = undefined;
      } catch (cause) {
        outcome = "unknown";
        this.deps.log(`recorder: failure cleanup could not be confirmed: ${messageOf(cause)}`);
      }
      const { recordingPath: initialPath, ...settledResult } = result;
      const candidate = initialPath ?? session.writer?.recordingPath;
      await this.publishFailure({ ...settledResult, outcome,
        ...(partialPath ? { partialPath } : {}),
        ...(outcome === "unknown" && candidate ? { recordingPath: candidate } : {}),
      });
      this.emit(
        partialPath === undefined
          ? { type: "failed", code, detail }
          : { type: "failed", code, detail, partialPath },
      );
    })();
    await finish;
  }

  private async publishFailure(result: RecordingFailure): Promise<void> {
    this.emit({ type: "failureStatus", result });
    try { await this.deps.publishFailure?.(result); }
    catch (cause) { this.deps.log(`recorder: failure result publication failed: ${messageOf(cause)}`); }
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

}
