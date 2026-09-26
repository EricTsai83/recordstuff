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
import { COUNTDOWN_TIMING, type CountdownSeconds } from "../shared/countdown";
import { describeCapture, type CaptureReport, type QualitySettings } from "../shared/quality";
import { isErrorCode, type ErrorCode, type RecordingState } from "../shared/state";
import { RECORDING_HEALTH, type RecordingHealth } from "./recording-health";
import type { SessionSentinel } from "./session-sentinel";
import type { FailureOutcome, SessionTiming } from "../shared/session-record";
import type { FinishTimings } from "./file-writer";

export interface RecorderWriter {
  readonly recordingPath?: string;
  readonly preservationUncertain?: boolean;
  /** Accepted bytes not yet confirmed written; diagnostics only. */
  readonly backlogBytes?: number;
  /** Confirmed bytes and the steps of a successful finish; diagnostics only. */
  readonly bytesWritten?: number;
  readonly finishTimings?: FinishTimings | undefined;
  append(bytes: Uint8Array): Promise<void>;
  /** Settles after queued work; resolves with a retained write/sync error, if any. */
  drain?(): Promise<unknown>;
  /**
   * Flush, close and publish under the final name; resolves with it. Rejects instead of
   * publishing zero confirmed bytes, after any retained write/sync error.
   */
  finish(): Promise<string>;
  /** Close and keep the partial file; resolves with its path if it was kept. */
  abandon(): Promise<string | undefined>;
}

export interface RecorderHost {
  /**
   * Ensures the capture host is up and posts `start` with the quality
   * snapshot; rejects if it cannot. The host replies `prepared`, not recording.
   */
  start(sessionId: string, quality: QualitySettings): Promise<void>;
  /** Begins encoding the prepared session (plan 040); throws when it cannot be sent. */
  record(sessionId: string): void;
  stop(sessionId: string): void;
  onMessage(listener: (message: HostMessage) => void): void;
  onFailure(
    listener: (code: "capture_host_crashed" | "capture_host_unresponsive", detail: string) => void,
  ): void;
}

/**
 * Draws the countdown digit (plan 040). Recorder stays free of Electron: the
 * app injects the overlay window. Errors are logged and never fail a
 * recording; the tray still shows the countdown.
 */
export interface CountdownPresenter {
  /** Preparation began and a countdown will follow: build the overlay so the first digit appears on time. */
  prepare?(): void;
  show(remaining: number): void;
  update(remaining: number): void;
  /** Fades the digit out; resolves once it is gone from the screen. */
  dismiss(): Promise<void>;
  /** Removes the overlay at once: cancel, failure, or a dismissal past its bound. Idempotent. */
  close(): void;
}

export interface RecorderDeps {
  host: RecorderHost;
  outputDir: () => string;
  /** Read once per session when it starts; later changes affect the next recording only. */
  quality: () => QualitySettings;
  /** Read once per session like quality; absent means no countdown. */
  countdownSeconds?: () => CountdownSeconds;
  countdown?: CountdownPresenter;
  /** Monotonic milliseconds for countdown anchors and timing logs; defaults to `performance.now()`. */
  monotonic?: () => number;
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
  /** Available bytes on the volume holding `dir`; absent disables the disk guard. */
  freeSpace?: (dir: string) => Promise<number>;
  /** Interruption evidence: written before the temporary file exists, removed on the terminal outcome. */
  sentinels?: {
    write(sentinel: SessionSentinel): Promise<void>;
    remove(sessionId: string): Promise<void>;
  };
  /** Overrides for `RECORDING_HEALTH`, for tests. */
  health?: Partial<RecordingHealth>;
}

/** Why a saved recording ended before the user asked; carried on the saved event. */
export type EarlyStop = "lowDisk";

/** What cancelled an attempt before capture began (plan 040). A cancel is not a failure. */
export type CancelReason = "toggle" | "menu" | "quit";

/**
 * The session a terminal event belongs to (plan 029). A failure's cleanup can
 * finish after the next session started, so completion order is no identity.
 */
export interface SessionTrace extends SessionTiming {
  id: string;
  /** The temporary file the session opened, when it got that far. */
  recordingPath?: string;
}

export type RecorderEvent =
  | { type: "failureStatus"; result: RecordingFailure }
  | { type: "state"; state: RecordingState }
  | { type: "saved"; path: string; stoppedEarly?: EarlyStop; session: SessionTrace }
  /** The host confirmed capture; `requested` is the session snapshot, `capture` what it got. */
  | { type: "captureStarted"; sessionId: string; requested: QualitySettings; capture: CaptureReport }
  | { type: "displayFailed"; detail: DisplayFailure }
  | { type: "failed"; code: ErrorCode; detail: string; partialPath?: string; outcome: FailureOutcome; session: SessionTrace; preflight?: never }
  /** Preflight refused before any attempt: no session exists, and none is borrowed. */
  | { type: "failed"; code: ErrorCode; detail: string; partialPath?: never; preflight: true }
  | { type: "permissionRequested"; needsRelaunch: boolean }
  /** No media existed: the temporary file is removed and idle returns without a failure. */
  | { type: "cancelled"; reason: CancelReason; session: SessionTrace };

export interface PermissionStatus {
  granted: boolean;
  needsRelaunch: boolean;
}

type IdleState = Extract<RecordingState, { type: "idle" }>;

/**
 * `opening` probes the folder and opens the temporary file; `preparing` waits
 * for the host's `prepared`; `countdown` shows the digits; `arming` sent
 * `record` and waits for `started` (docs/system-design/recording.md).
 */
type Phase = "opening" | "preparing" | "countdown" | "arming" | "recording" | "stopping";

/** Names the phase in a start failure's detail. */
const BEFORE_CAPTURE: Partial<Record<Phase, string>> = {
  preparing: "preparing capture",
  countdown: "counting down",
  arming: "starting capture",
};

interface Countdown {
  /** Monotonic time of `prepared`; every tick is measured from it. */
  anchor: number;
  timers: Array<ReturnType<typeof setTimeout>>;
  /** Capture may begin once both hold: N seconds passed and the overlay is gone. */
  elapsed: boolean;
  dismissed: boolean;
}

interface Session {
  id: string;
  phase: Phase;
  /** Quality snapshot taken when the session was created. */
  quality: QualitySettings;
  /** Countdown snapshot taken when the session was created. */
  countdownSeconds: CountdownSeconds;
  /** Quit arrived before capture was prepared: cancel instead of counting down or recording. */
  cancelOnPrepared: boolean;
  /** What `prepared` reported; carried on `captureStarted`. */
  capture?: CaptureReport;
  countdown?: Countdown;
  /** The overlay may be on screen or loading; cleanup closes it. */
  overlay: boolean;
  /** Monotonic times for the timing log. */
  requestedAt: number;
  recordSentAt?: number;
  stopRequestedAt?: number;
  hostStoppedAt?: number;
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
  /** Output folder, polled for free space while recording. */
  dir: string;
  startedAt: string;
  /** Set when the host confirmed capture and when stop was requested; carried on the terminal event. */
  recordingAt?: string;
  stoppingAt?: string;
  /** Inter-chunk guard after media began; the first-media deadline covers the time before. */
  stall?: ReturnType<typeof setTimeout> | undefined;
  disk?: ReturnType<typeof setTimeout> | undefined;
  diskWarned: boolean;
  diskPollFailed: boolean;
  stoppedEarly?: EarlyStop;
  /** A sentinel write was attempted, so the terminal outcome removes it. */
  sentinel: boolean;
  sentinelFailed: boolean;
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
  /** Latest watcher status, independent of the recording state (plan 027). */
  private permission: PermissionStatus = { granted: true, needsRelaunch: false };
  /** What idle shows once permission allows; needsPermission carries only its lastSavedPath. */
  private idleState: IdleState = { type: "idle" };
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
  private readonly health: RecordingHealth;

  private readonly monotonic: () => number;

  constructor(deps: RecorderDeps) {
    this.monotonic = deps.monotonic ?? (() => performance.now());
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
    this.health = { ...RECORDING_HEALTH, ...deps.health };
    deps.host.onMessage((message) => this.handleHostMessage(message));
    deps.host.onFailure((code, detail) => this.handleHostFailure(code, detail));
  }

  get state(): RecordingState {
    return this._state;
  }

  /** The in-flight session, for diagnostics such as sleep/wake logging. */
  get sessionId(): string | undefined {
    return this.session?.id;
  }

  subscribe(listener: (event: RecorderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Left click and the shortcut (ADR-7): start when idle, stop when
   * recording, cancel a countdown, else ignore.
   */
  toggle(): void {
    switch (this._state.type) {
      case "idle":
        void this.start();
        return;
      case "recording":
        this.stop();
        return;
      case "countdown":
        this.cancelCountdown("toggle");
        return;
      case "needsPermission":
        this.emit({ type: "permissionRequested", needsRelaunch: this._state.needsRelaunch });
        return;
      case "starting":
      case "stopping":
        return;
    }
  }

  /**
   * Before `record` is sent the attempt is cancelled. After it, the request
   * becomes a stop applied once `started` arrives, so a race of a few
   * milliseconds cannot leave capture running.
   *
   * A tray menu opened during the countdown stays as it was: macOS does not
   * let the app update or close an open tray menu, so its Cancel countdown can
   * arrive after capture began. It still means "no recording", so it stops at
   * once and the file is saved, as a toggle after `record` would.
   */
  cancelCountdown(reason: Exclude<CancelReason, "quit"> = "menu"): void {
    const session = this.session;
    if (reason === "menu" && this._state.type === "recording" && session?.phase === "recording") {
      this.deps.log(`recorder: session ${session.id} Cancel countdown arrived after capture started (a menu opened during the countdown); stopping`);
      this.stop();
      return;
    }
    if (this._state.type !== "countdown" || !session) return;
    if (session.phase === "countdown") {
      this.cancel(session, reason);
    } else if (session.phase === "arming" && !session.stopOnStart) {
      session.stopOnStart = true;
      this.deps.log(`recorder: session ${session.id} cancel (${reason}) arrived after record was sent; stopping once capture starts`);
    }
  }

  stop(): void {
    const session = this.session;
    if (this._state.type !== "recording" || !session || session.phase !== "recording") return;
    session.phase = "stopping";
    session.stoppingAt = this.deps.now().toISOString();
    session.stopRequestedAt = this.monotonic();
    this.setState({ type: "stopping" });
    this.clearTimer(session);
    this.clearDisk(session);
    session.timer = setTimeout(() => {
      void this.fail(session.id, "stop_timeout", "capture host did not stop before the deadline");
    }, this.deps.stopTimeoutMs);
    this.deps.host.stop(session.id);
  }

  /** False means quit was deferred; outstanding work remains owned by this recorder. */
  shutdown(): Promise<boolean> {
    if (this.shuttingDown) return this.shuttingDown;
    this.quitAdmission = true;
    // No media exists before `record`: quit cancels the attempt instead of
    // recording and saving it. After `record`, capture stops once it starts.
    const pending = this.session;
    if (pending && (pending.phase === "opening" || pending.phase === "preparing")) pending.cancelOnPrepared = true;
    if (pending && pending.phase === "arming") pending.stopOnStart = true;
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
        if (this.session?.phase === "countdown") this.cancel(this.session, "quit");
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

  /**
   * macOS only. Always stored, even while busy: a permission change never
   * interrupts a running session, and the session's end settles from it.
   */
  setPermission(status: PermissionStatus): void {
    this.permission = status;
    const current = this._state;
    if (current.type !== "idle" && current.type !== "needsPermission") return;
    const unchanged = status.granted
      ? current.type === "idle"
      : current.type === "needsPermission" && current.needsRelaunch === status.needsRelaunch;
    if (!unchanged) this.settle(this.idleState);
  }

  /** The user picked a new folder; forget that the old one was unusable. */
  outputDirChanged(): void {
    if (!this.idleState.outputDirUnavailable) return;
    const { outputDirUnavailable: _drop, ...rest } = this.idleState;
    this.idleState = rest;
    if (this._state.type === "idle") this.setState(rest);
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
      this.emit({ type: "failed", code: blocker, detail: "", preflight: true });
      return;
    }

    const dir = this.deps.outputDir();
    const session: Session = {
      id: this.deps.newSessionId(),
      phase: "opening",
      quality: this.deps.quality(),
      countdownSeconds: this.deps.countdownSeconds?.() ?? 0,
      cancelOnPrepared: false,
      overlay: false,
      requestedAt: this.monotonic(),
      finalizing: false,
      stopOnStart: false,
      hasMedia: false,
      nextSeq: 0,
      writes: Promise.resolve(),
      dir,
      startedAt: this.deps.now().toISOString(),
      diskWarned: false,
      diskPollFailed: false,
      sentinel: false,
      sentinelFailed: false,
    };
    this.session = session;
    session.opening = Promise.resolve().then(async () => {
      await this.deps.ensureWritableDir(dir);
      if (this.session !== session) return;
      session.writer = await this.openUniqueWriter(session, formatTimestamp(this.deps.now()));
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
    // Quit arrived while the folder was probed: no capture request at all.
    if (session.cancelOnPrepared) {
      this.cancel(session, "quit");
      return;
    }

    session.phase = "preparing";
    this.clearTimer(session);
    // Bounds `start → prepared`: permission prompts, missing audio, unsupported
    // MP4 and display errors all surface here, before any countdown.
    session.timer = setTimeout(() => {
      void this.fail(session.id, "capture_start_failed", "screen/audio capture request timed out; complete system permission prompts and retry");
    }, this.deps.captureRequestTimeoutMs);
    if (session.countdownSeconds > 0 && this.deps.countdown) {
      session.overlay = true;
      this.present("prepare", (presenter) => presenter.prepare?.());
    }
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
  private async openUniqueWriter(session: Session, stamp: string): Promise<RecorderWriter> {
    for (let attempt = 1; ; attempt += 1) {
      const name = attempt === 1 ? stamp : `${stamp}-${attempt}`;
      const recordingPath = path.join(session.dir, `${name}.recording.mp4`);
      // Named before it exists, so a crash never leaves a temporary file no sentinel names.
      await this.markInFlight(session, recordingPath);
      try {
        return await this.deps.openWriter(recordingPath, path.join(session.dir, `${name}.mp4`));
      } catch (cause) {
        const errno =
          typeof cause === "object" && cause !== null && "cause" in cause
            ? (cause as { cause?: { code?: unknown } }).cause?.code
            : undefined;
        if (errno !== "EEXIST" || attempt >= MAX_NAME_ATTEMPTS) throw cause;
      }
    }
  }

  /** A failed sentinel write is logged once and never blocks the recording. */
  private async markInFlight(session: Session, recordingPath: string): Promise<void> {
    const sentinels = this.deps.sentinels;
    if (!sentinels) return;
    session.sentinel = true;
    try {
      await sentinels.write({ sessionId: session.id, startedAt: session.startedAt, recordingPath });
    } catch (cause) {
      if (!session.sentinelFailed) this.deps.log(`recorder: session ${session.id} interruption sentinel not written: ${messageOf(cause)}`);
      session.sentinelFailed = true;
    }
  }

  /** Every terminal outcome, including failures, removes the session's own sentinel. */
  private async clearInFlight(session: Session): Promise<void> {
    if (!session.sentinel || !this.deps.sentinels) return;
    session.sentinel = false;
    try { await this.deps.sentinels.remove(session.id); }
    catch (cause) { this.deps.log(`recorder: session ${session.id} interruption sentinel not removed: ${messageOf(cause)}`); }
  }

  private handleHostMessage(message: HostMessage): void {
    if (message.type === "ready" || message.type === "pong") return;
    const session = this.session;
    if (message.type === "error") {
      if (session && !session.finalizing && (message.sessionId === undefined || message.sessionId === session.id)) {
        let code = this.deps.mapHostError ? this.deps.mapHostError(message.code) : message.code;
        let detail = message.detail;
        // Nothing was recorded yet: a source that ended is a start failure.
        const phase = BEFORE_CAPTURE[session.phase];
        if (phase && (code === "capture_failed" || code === "capture_start_failed")) {
          code = "capture_start_failed";
          detail = `${detail} (while ${phase})`;
        }
        if (message.displayFailure && !session.finalizing) this.emit({ type: "displayFailed", detail: message.displayFailure });
        void this.fail(session.id, code, detail);
      }
      return;
    }
    if (!session || message.sessionId !== session.id) {
      // A session we already gave up on (e.g. start timed out while the host
      // was still inside getDisplayMedia) must not keep capturing unseen.
      if (message.type === "prepared" || message.type === "started" || message.type === "chunk") {
        this.deps.log(`recorder: stopping stale session ${message.sessionId} (${message.type})`);
        this.deps.host.stop(message.sessionId);
      }
      return;
    }
    switch (message.type) {
      case "prepared":
        if (session.phase !== "preparing") return;
        this.clearTimer(session);
        session.capture = message.capture;
        this.deps.log(`recorder: session ${session.id} prepared after ${this.elapsed(session.requestedAt)} ms; countdown ${session.countdownSeconds} s`);
        if (session.cancelOnPrepared) {
          this.cancel(session, "quit");
          return;
        }
        if (session.countdownSeconds > 0) this.beginCountdown(session);
        else this.record(session);
        return;
      case "started": {
        if (session.phase !== "arming") return;
        const capture = session.capture ?? message.capture;
        if (!capture) {
          void this.fail(session.id, "capture_start_failed", "capture host started without a prepared capture report");
          return;
        }
        session.phase = "recording";
        this.clearTimer(session);
        if (!session.hasMedia) {
          session.timer = setTimeout(() => {
            void this.fail(session.id, "capture_start_failed", "capture host did not send media before the deadline");
          }, this.deps.startTimeoutMs);
        }
        this.deps.log(`recorder: session ${session.id} started ${session.recordSentAt === undefined ? "?" : this.elapsed(session.recordSentAt)} ms after record`);
        this.deps.log(`recorder: session ${session.id} capture: ${describeCapture(session.quality, capture)}`);
        if (session.hasMedia) this.armStall(session);
        this.watchDisk(session);
        session.recordingAt = this.deps.now().toISOString();
        this.setState({ type: "recording", startedAt: session.recordingAt });
        if (session.stopOnStart) this.stop();
        this.emit({ type: "captureStarted", sessionId: session.id, requested: session.quality, capture });
        return;
      }
      case "chunk":
        this.handleChunk(session, message.seq, message.bytes);
        return;
      case "stopped":
        if (session.finalizing) return;
        this.deps.log(`recorder: session ${session.id} host stopped; tracksStoppedAt=${message.tracksStoppedAt ?? "unknown"}`);
        // A normal drain after stop must never read as a stall.
        this.clearHealth(session);
        if (session.phase === "stopping") {
          session.hostStoppedAt = this.monotonic();
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
    // Media can exist only after `record`.
    if (session.phase !== "arming" && session.phase !== "recording" && session.phase !== "stopping") {
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
    // Empty chunks are not media, so they do not reset the stall guard either.
    if (bytes.byteLength > 0 && session.phase !== "arming") this.armStall(session);
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

  /**
   * Ticks from one monotonic anchor, so timer lateness never accumulates. The
   * overlay is asked to leave `overlayLeadMs` before N seconds; `record` goes
   * out at N seconds, or when the dismissal settles if that is later.
   */
  private beginCountdown(session: Session): void {
    const seconds = session.countdownSeconds;
    const { tickMs, overlayLeadMs } = COUNTDOWN_TIMING;
    const countdown: Countdown = { anchor: this.monotonic(), timers: [], elapsed: false, dismissed: false };
    session.countdown = countdown;
    session.phase = "countdown";
    this.setState({ type: "countdown", remaining: seconds });
    if (this.deps.countdown) {
      session.overlay = true;
      this.present("show", (presenter) => presenter.show(seconds));
    }
    const at = (offsetMs: number, run: () => void): void => {
      countdown.timers.push(setTimeout(run, Math.max(0, countdown.anchor + offsetMs - this.monotonic())));
    };
    for (let k = 1; k < seconds; k += 1) {
      const remaining = seconds - k;
      at(k * tickMs, () => {
        if (this.session !== session || session.phase !== "countdown") return;
        this.setState({ type: "countdown", remaining });
        if (session.overlay) this.present("update", (presenter) => presenter.update(remaining));
      });
    }
    at(seconds * tickMs - overlayLeadMs, () => this.dismissOverlay(session));
    at(seconds * tickMs, () => {
      countdown.elapsed = true;
      this.recordAfterCountdown(session);
    });
  }

  /** Waits for the overlay's confirmation within a bound; past it, the overlay is destroyed and capture proceeds. */
  private dismissOverlay(session: Session): void {
    const countdown = session.countdown;
    if (this.session !== session || session.phase !== "countdown" || !countdown) return;
    const presenter = this.deps.countdown;
    if (!presenter || !session.overlay) {
      countdown.dismissed = true;
      this.recordAfterCountdown(session);
      return;
    }
    const began = this.monotonic();
    let bound: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      bound = setTimeout(() => resolve("timeout"), COUNTDOWN_TIMING.dismissTimeoutMs);
      countdown.timers.push(bound);
    });
    const dismissal = Promise.resolve()
      .then(() => presenter.dismiss())
      .then(() => "dismissed" as const, (cause: unknown) => {
        this.deps.log(`recorder: countdown overlay dismiss failed: ${messageOf(cause)}`);
        return "error" as const;
      });
    void Promise.race([dismissal, timedOut]).then((outcome) => {
      clearTimeout(bound);
      if (this.session !== session || session.phase !== "countdown") return;
      if (outcome === "timeout") {
        this.deps.log(`recorder: session ${session.id} countdown overlay did not confirm dismissal within ${COUNTDOWN_TIMING.dismissTimeoutMs} ms; destroying it`);
      } else {
        this.deps.log(`recorder: session ${session.id} countdown overlay ${outcome} after ${this.elapsed(began)} ms`);
      }
      this.closeOverlay(session);
      countdown.dismissed = true;
      this.recordAfterCountdown(session);
    });
  }

  private recordAfterCountdown(session: Session): void {
    const countdown = session.countdown;
    if (this.session !== session || session.phase !== "countdown" || !countdown?.elapsed || !countdown.dismissed) return;
    this.clearCountdown(session);
    this.record(session);
  }

  /** `record → started` uses the start deadline; the state keeps its last countdown value meanwhile. */
  private record(session: Session): void {
    session.phase = "arming";
    this.clearTimer(session);
    session.recordSentAt = this.monotonic();
    this.deps.log(`recorder: session ${session.id} record sent ${session.countdown
      ? `${Math.round(session.recordSentAt - session.countdown.anchor)} ms after the ${session.countdownSeconds} s countdown began`
      : "without a countdown"}`);
    session.timer = setTimeout(() => {
      void this.fail(session.id, "capture_start_failed", "capture host did not confirm recording started before the deadline (while starting capture)");
    }, this.deps.startTimeoutMs);
    try {
      this.deps.host.record(session.id);
    } catch (cause) {
      void this.fail(session.id, "capture_start_failed", `record refused: ${messageOf(cause)} (while starting capture)`);
    }
  }

  /**
   * No media exists before `record`, so a cancel is not a failure: no failure
   * status, history, notification or display diagnostic. The empty temporary
   * file is removed and the idle state from before the attempt returns.
   */
  private cancel(session: Session, reason: CancelReason): void {
    if (this.session !== session) return;
    this.session = undefined;
    this.clearTimer(session);
    this.clearCountdown(session);
    this.clearHealth(session);
    this.closeOverlay(session);
    if (session.phase !== "opening") this.deps.host.stop(session.id);
    this.deps.log(`recorder: session ${session.id} cancelled (${reason}) while ${BEFORE_CAPTURE[session.phase] ?? "opening the recording file"}`);
    // Owned before idle is published: a quit waiting on that state change
    // must also wait for the temporary file and the sentinel to go.
    void this.track(async () => {
      await session.opening?.catch(() => undefined);
      try {
        const kept = await session.writer?.abandon();
        if (kept) this.deps.log(`recorder: cancelled session ${session.id} unexpectedly kept ${kept}`);
      } catch (cause) {
        this.deps.log(`recorder: cancelled session ${session.id} cleanup could not be confirmed: ${messageOf(cause)}`);
      }
      this.emit({ type: "cancelled", reason, session: this.trace(session) });
      await this.clearInFlight(session);
    });
    // Opening succeeded, so the folder is usable again.
    const { outputDirUnavailable: _usable, ...idle } = this.idleState;
    this.settle(idle);
  }

  private present(what: string, act: (presenter: CountdownPresenter) => void): void {
    const presenter = this.deps.countdown;
    if (!presenter) return;
    try { act(presenter); }
    catch (cause) { this.deps.log(`recorder: countdown overlay ${what} failed: ${messageOf(cause)}`); }
  }

  private closeOverlay(session: Session): void {
    if (!session.overlay) return;
    session.overlay = false;
    this.present("close", (presenter) => presenter.close());
  }

  private clearCountdown(session: Session): void {
    for (const timer of session.countdown?.timers ?? []) clearTimeout(timer);
    if (session.countdown) session.countdown.timers = [];
  }

  private elapsed(since: number): number {
    return Math.round(this.monotonic() - since);
  }

  private async finalize(session: Session): Promise<void> {
    await session.writes;
    const drainedAt = this.monotonic();
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
    const early = session.stoppedEarly === "lowDisk" ? " (stopped early: disk almost full)" : "";
    this.deps.log(`recorder: session ${session.id} file finalized ${finalPath}${early}`);
    this.logFinalizeTiming(session, drainedAt);
    this.session = undefined;
    this.settle({ type: "idle", lastSavedPath: finalPath });
    this.emit({ type: "saved", path: finalPath, ...(session.stoppedEarly ? { stoppedEarly: session.stoppedEarly } : {}), session: this.trace(session) });
    await this.clearInFlight(session);
  }

  /** Where the wait between stop and saved went; stop-to-ready itself is the state lines' interval. */
  private logFinalizeTiming(session: Session, drainedAt: number): void {
    const timings = session.writer?.finishTimings;
    const ms = (value: number | undefined): string => value === undefined ? "?" : String(Math.round(value));
    const span = (from: number | undefined, to: number | undefined): number | undefined =>
      from === undefined || to === undefined ? undefined : to - from;
    this.deps.log(`recorder: session ${session.id} finalize timing: host ${ms(span(session.stopRequestedAt, session.hostStoppedAt))} ms, ` +
      `writes ${ms(span(session.hostStoppedAt, drainedAt))} ms, flush ${ms(timings?.flushMs)} ms, close ${ms(timings?.closeMs)} ms, ` +
      `publish ${ms(timings?.publishMs)} ms by ${timings?.method ?? "?"}${timings?.linkError ? ` (link ${timings.linkError})` : ""}, ` +
      `cleanup ${ms(timings?.cleanupMs)} ms; ` +
      `${session.writer?.bytesWritten ?? "?"} bytes`);
  }

  /**
   * One inter-chunk timer after media began: warn once at the first bound,
   * fail at the second with the partial file preserved. Heartbeats only prove
   * the renderer answers; this proves media still arrives.
   */
  private armStall(session: Session): void {
    if (session.stall) clearTimeout(session.stall);
    const { stallWarnMs, stallFailMs } = this.health;
    session.stall = setTimeout(() => {
      this.deps.log(`recorder: session ${session.id} no media for ${stallWarnMs} ms; writer backlog ${session.writer?.backlogBytes ?? "unknown"} bytes`);
      session.stall = setTimeout(() => {
        session.stall = undefined;
        void this.fail(session.id, "capture_failed", `capture stalled: no media for ${stallFailMs} ms while the capture host still responded`);
      }, stallFailMs - stallWarnMs);
    }, stallWarnMs);
  }

  /** Polls on one timer, never overlapping; a failed poll is logged once and ignored. */
  private watchDisk(session: Session): void {
    const freeSpace = this.deps.freeSpace;
    if (!freeSpace) return;
    const { diskPollMs, diskWarnBytes, diskStopBytes } = this.health;
    session.disk = setTimeout(() => {
      void freeSpace(session.dir).then((free) => {
        if (this.session !== session || session.phase !== "recording") return;
        if (free < diskStopBytes) {
          session.disk = undefined;
          session.stoppedEarly = "lowDisk";
          this.deps.log(`recorder: session ${session.id} ${free} bytes free in ${session.dir}, below ${diskStopBytes}; stopping early to save while space remains`);
          this.stop();
          return;
        }
        if (free < diskWarnBytes && !session.diskWarned) {
          session.diskWarned = true;
          this.deps.log(`recorder: session ${session.id} ${free} bytes free in ${session.dir}, below ${diskWarnBytes}; writer backlog ${session.writer?.backlogBytes ?? "unknown"} bytes`);
        }
        this.watchDisk(session);
      }, (cause: unknown) => {
        if (!session.diskPollFailed) this.deps.log(`recorder: session ${session.id} free-space check failed: ${messageOf(cause)}`);
        session.diskPollFailed = true;
        if (this.session === session && session.phase === "recording") this.watchDisk(session);
      });
    }, diskPollMs);
  }

  private clearDisk(session: Session): void {
    if (session.disk) clearTimeout(session.disk);
    session.disk = undefined;
  }

  private clearHealth(session: Session): void {
    this.clearDisk(session);
    if (session.stall) clearTimeout(session.stall);
    session.stall = undefined;
  }

  /**
   * A generic start failure can hide a disk error a background sync already
   * retained (the writer opens before the capture request). Classify only after
   * the writer's queued work settles, within a bound, so a sick disk keeps its
   * own code and guidance. Only `capture_start_failed` asks; specific host causes keep their code.
   */
  private async retainedWriteError(session: Session): Promise<{ code: ErrorCode; detail: string } | undefined> {
    const writer = session.writer;
    if (!writer?.drain) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const retained = await Promise.race([
      writer.drain().catch(() => undefined),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), this.health.startDrainMs); }),
    ]).finally(() => clearTimeout(timer));
    return retained ? { code: errorCodeOf(retained, "output_write_failed"), detail: messageOf(retained) } : undefined;
  }

  /** Display loss shares the idempotent failure path with track end and host failure. */
  displayRemoved(): void {
    const session = this.session;
    if (session && !session.finalizing) {
      this.emit({ type: "displayFailed", detail: "target_removed" });
      const phase = BEFORE_CAPTURE[session.phase];
      if (phase) void this.fail(session.id, "capture_start_failed", `recording display removed (while ${phase})`);
      else void this.fail(session.id, "capture_failed", "recording display removed");
    }
  }

  private handleHostFailure(
    code: "capture_host_crashed" | "capture_host_unresponsive",
    detail: string,
  ): void {
    const session = this.session;
    if (!session || session.finalizing) return;
    // Before `record` nothing was captured: a lost host is a start failure.
    const phase = BEFORE_CAPTURE[session.phase];
    if (phase) void this.fail(session.id, "capture_start_failed", `${code === "capture_host_crashed" ? "capture host crashed" : "capture host stopped responding"}: ${detail} (while ${phase})`);
    else void this.fail(session.id, code, detail);
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
    this.clearCountdown(session);
    this.clearHealth(session);
    this.closeOverlay(session);
    if (session.phase !== "opening") this.deps.host.stop(session.id);
    this.deps.log(`recorder: session ${session.id} failed: ${code} ${detail}`);
    const occurredAt = this.deps.now().toISOString();
    // End the recording state before file cleanup. Native painting can still
    // wait on synchronous subscriber IO (docs/system-design/recording.md).
    // Set idle and request tray updates before synchronous metadata persistence.
    this.settle({ type: "idle", ...idleFlags });
    if (code === "capture_start_failed") {
      const retained = await this.retainedWriteError(session);
      if (retained) {
        this.deps.log(`recorder: session ${session.id} start failure reported as ${retained.code}: the writer retained ${retained.detail}`);
        detail = `${retained.detail} (start ended: ${detail})`;
        code = retained.code;
      }
    }
    const result: RecordingFailure = { id: randomUUID(), occurredAt,
      code, detail, outcome: "pending", ...(session.writer?.recordingPath ? { recordingPath: session.writer.recordingPath } : {}) };
    await this.publishFailure(result);
    const finish = (async (): Promise<void> => {
      let partialPath: string | undefined;
      let outcome: FailureOutcome = "empty";
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
      this.emit({ type: "failed", code, detail, ...(partialPath === undefined ? {} : { partialPath }), outcome, session: this.trace(session) });
      await this.clearInFlight(session);
    })();
    await finish;
  }

  private async publishFailure(result: RecordingFailure): Promise<void> {
    this.emit({ type: "failureStatus", result });
    try { await this.deps.publishFailure?.(result); }
    catch (cause) { this.deps.log(`recorder: failure result publication failed: ${messageOf(cause)}`); }
  }

  private trace(session: Session): SessionTrace {
    const recordingPath = session.writer?.recordingPath;
    return {
      id: session.id,
      ...(recordingPath ? { recordingPath } : {}),
      ...(session.recordingAt ? { recordingAt: session.recordingAt } : {}),
      ...(session.stoppingAt ? { stoppingAt: session.stoppingAt } : {}),
    };
  }

  private clearTimer(session: Session): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = undefined;
  }

  /** Every return to a non-busy state lands here, so it reflects the latest permission. */
  private settle(idle: IdleState): void {
    this.idleState = idle;
    this.setState(this.permission.granted ? idle : {
      type: "needsPermission", needsRelaunch: this.permission.needsRelaunch,
      ...(idle.lastSavedPath ? { lastSavedPath: idle.lastSavedPath } : {}),
    });
  }

  private setState(state: RecordingState): void {
    this._state = state;
    this.emit({ type: "state", state });
  }

  private emit(event: RecorderEvent): void {
    for (const listener of this.listeners) listener(event);
  }

}
