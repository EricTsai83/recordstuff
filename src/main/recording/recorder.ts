/**
 * The state machine (docs/system-design/recording.md) and the single owner of
 * `RecordingState`. Everything with side effects — capture host, file writer,
 * clock — is injected, so this file has no Electron import and is unit-testable.
 *
 * Failure never fakes success: any error goes back to `idle` with a `failed`
 * event and, when bytes were written, a kept `.recording.mp4`.
 */
import type { CameraLayout } from "../../shared/camera-layout";
import type { AudioVolume } from "../../shared/audio-volume";
import type { RecordingFailure } from "../../shared/recording-result";
import type { DisplayFailure } from "../../shared/display";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HostStartError, type HostErrorCode, type HostMessage, type MicrophoneChoice, type HealthSample } from "../../shared/protocol";
import { COUNTDOWN_TIMING, type CountdownSeconds } from "../../shared/countdown";
import { describeCapture, type CaptureReport, type QualitySettings } from "../../shared/quality";
import { isErrorCode, type ErrorCode, type RecordingState } from "../../shared/state";
import { RECORDING_HEALTH, type RecordingHealth } from "./recording-health";
import { SessionSentinelTracker, type SentinelStore } from "./session-sentinel";
import { EARLY_STOP_TEXT, type EarlyStop, type FailureOutcome, type SessionTiming } from "../../shared/session-record";
import { NO_MEDIA_DETAIL, type FinishTimings } from "./file-writer";
import { errnoCode, messageOf } from "../lib/errors";
import { EDITABLE_MARKER } from "../../shared/versions";

export interface RecorderWriter {
  readonly recordingPath?: string;
  /** The name the finished file is published under, chosen again when a Live preview becomes a recording (D20). */
  retarget?(finalPath: string): void;
  readonly preservationUncertain?: boolean;
  /** Confirmed bytes and the steps of a successful finish; diagnostics only. */
  readonly bytesWritten?: number;
  readonly finishTimings?: FinishTimings | undefined;
  /**
   * Publishes the finished file under the final name; resolves with it. Rejects instead of publishing zero bytes,
   * and with the engine's write error when it could not finish the file.
   */
  finish(): Promise<string>;
  /** Close and keep the partial file; resolves with its path if it was kept. */
  abandon(): Promise<string | undefined>;
}

/** What one session captures besides the quality (plan 074); a snapshot taken when the session begins. */
export interface SessionCapture {
  /** False when the session records no system audio (plan 101); absent records it. */
  systemAudio?: false;
  /** Present only when the microphone is on. */
  microphone?: MicrophoneChoice;
  /** Present only when the camera is on (plan 075). */
  camera?: SessionCamera;
  /** Plan 087: the screen, each sound and the camera on tracks of their own; present only for an editable recording. */
  editable?: true;
}

/** The camera setting as a session reads it (plan 075): the device and the layout, whose position the host picks for the display. */
export interface SessionCamera {
  deviceId?: string;
  layout: CameraLayout;
}

/** The microphone setting as a session reads it: the choice, and the device's name for the log. */
export interface SessionMicrophone extends MicrophoneChoice {
  label?: string;
}

export interface RecorderHost {
  /**
   * Ensures the capture host is up and posts `start` with the quality
   * snapshot; rejects if it cannot. The host replies `prepared`, not recording.
   * `recordingPath` is the temporary file the writer opened, which the native
   * engine writes itself (plan 076, D3).
   */
  start(sessionId: string, quality: QualitySettings, recordingPath?: string, capture?: SessionCapture): Promise<void>;
  /** Begins encoding the prepared session (plan 040); throws when it cannot be sent. */
  record(sessionId: string): void;
  stop(sessionId: string): void;
  /** The session's camera from its next frame on (plan 075, D7 and D13); absent where no camera is composed. */
  setCamera?(sessionId: string, camera: SessionCamera, hidden: boolean): void;
  /** Mutes the session's system audio and microphone, or not, from their next sound on (plan 075, D19). */
  setMuted?(sessionId: string, system: boolean, microphone: boolean): void;
  /** The session's inputs' volumes in dB from their next sound on (plan 075, D21). */
  setGains?(sessionId: string, gain: AudioVolume): void;
  /** Records another microphone from now on (plan 079, D3); false when the host does not run the session. */
  setMicrophone?(sessionId: string, deviceId: string | undefined): boolean;
  onMessage(listener: (message: HostMessage) => void): void;
  onFailure(
    listener: (code: "capture_host_crashed" | "capture_host_unresponsive", detail: string) => void,
  ): void;
}

/** How the overlay presents this session's countdown; a snapshot taken when the session begins. */
export interface CountdownPresentation {
  /** A tick plays with each digit (plan 046). */
  sound: boolean;
  /** A line under the digit (plan 097): the problems the recording starts with, so the user can still cancel. */
  notice?: string;
}

/**
 * Draws the countdown digit (plan 040). Recorder stays free of Electron: the
 * app injects the overlay window. Errors are logged and never fail a
 * recording; the tray still shows the countdown.
 */
export interface CountdownPresenter {
  /** Preparation began and a countdown will follow: build the overlay so the first digit appears on time. */
  prepare?(presentation: CountdownPresentation): void;
  show(remaining: number, presentation: CountdownPresentation): void;
  update(remaining: number): void;
  /** Fades the digit out; resolves once it is gone from the screen. */
  dismiss(): Promise<void>;
  /** Removes the overlay at once: cancel, failure, or a dismissal past its bound. Idempotent. */
  close(): void;
}

/** What an editable recording records each input at (plan 097, D6): as it comes. */
const EDITABLE_VOLUME: AudioVolume = { system: 100, microphone: 100 };

export interface RecorderDeps {
  host: RecorderHost;
  /** Windows lacks Media Foundation (plan 078), found at launch: a start is refused, as the tray and Settings explain. */
  mediaComponentsMissing?: boolean;
  outputDir: () => string;
  /** Read once per session when it starts; later changes affect the next recording only. */
  quality: () => QualitySettings;
  /** Read once per session like quality; absent means no countdown. */
  countdownSeconds?: () => CountdownSeconds;
  /** Read once per session with the countdown; absent means silent. */
  countdownSound?: () => boolean;
  /** The problems a recording starts with (plan 097), read once per session with the countdown; absent or empty is none. */
  countdownNotice?: () => string | undefined;
  /** Whether the session records the system's sound (plan 101), read once per session like quality; absent means on. */
  systemAudio?: () => boolean;
  /** Read once per session like quality (plan 074); absent means off. */
  microphone?: () => SessionMicrophone;
  /** The same for the camera (plan 075); absent, or undefined from it, means off. */
  camera?: () => SessionCamera | undefined;
  /** The inputs' volumes (plan 075, D21), read when a session is prepared and sent again by `updateGains`; absent is 0 dB. */
  audioVolume?: () => AudioVolume;
  /**
   * Whether the session records an editable file (plan 087): the setting, or the tray's Start editable recording once.
   * Read once per session like quality; absent is never. An editable session records every input as it comes (plan 097,
   * D6): at 100%, never muted, the camera never hidden; Edit… sets them afterwards.
   */
  editable?: () => boolean;
  countdown?: CountdownPresenter;
  /** Monotonic milliseconds for countdown anchors and timing logs; defaults to `performance.now()`. */
  monotonic?: () => number;
  ensureWritableDir: (dir: string) => Promise<void>;
  openWriter: (recordingPath: string, finalPath: string) => Promise<RecorderWriter>;
  /** The saved file's name, without its extension, for a recording requested at `date`; read once per session. Defaults to `formatTimestamp`. */
  fileName?: (date: Date) => string;
  now?: () => Date;
  newSessionId?: () => string;
  /** Returns an error code when recording is impossible on this machine. */
  preflight?: () => ErrorCode | undefined;
  /**
   * Lets the owner replace a host-reported error code with the real cause it
   * knows about (e.g. main denied the display-media request for `no_display`).
   */
  mapHostError?: (code: HostErrorCode) => ErrorCode;
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
  sentinels?: SentinelStore;
  /** Overrides for the `RECORDING_HEALTH` guards, for tests. */
  health?: Partial<RecorderHealth>;
}

/** The guards Recorder applies. */
type RecorderHealth = RecordingHealth;

/** What cancelled an attempt before capture began (plan 040). A cancel is not a failure. */
/** `preview`: a Live preview let go of (plan 075, D20), never recorded. */
export type CancelReason = "toggle" | "menu" | "quit" | "sleep" | "preview";

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
  /**
   * `microphoneLost`: the microphone dropped out partway, and that part has system audio only (plan 074);
   * `cameraLost`: the camera did, and that part shows the screen alone (plan 075); `cameraNotReady`: the camera gave no
   * picture in the time it has to start, and the recording shows the screen alone until it did (plan 090). `microphones`: the devices recorded
   * in turn, when the user switched while recording (plan 079, D3).
   */
  | { type: "saved"; path: string; stoppedEarly?: EarlyStop; microphoneLost?: true; cameraLost?: true; cameraNotReady?: true; microphones?: string[]; session: SessionTrace;
    /** An editable recording (plan 087), whose Video is prepared once it is saved (plan 100, D2). */
    editable?: true }
  /** The microphone stopped while recording; the recording goes on without it. Told once per session (plan 074). */
  | { type: "microphoneLost"; sessionId: string; detail: string }
  /** The camera stopped while recording; the recording goes on without it. Told once per session (plan 075). */
  | { type: "cameraLost"; sessionId: string; detail: string }
  /** The camera gave no first frame in time; the recording goes on without it until it does. Told once per session (plan 090). */
  | { type: "cameraNotReady"; sessionId: string; detail: string }
  /** The camera's state in `camera` changed (plan 090): Settings redraws what its preview says. */
  | { type: "cameraState" }
  /** One second of a recording's health (plan 100 step 4), for the governor of versions prepared alongside it. */
  | { type: "health"; sessionId: string; health: HealthSample }
  /** The host confirmed capture; `requested` is the session snapshot, `capture` what it got. */
  | { type: "captureStarted"; sessionId: string; requested: QualitySettings; capture: CaptureReport }
  | { type: "displayFailed"; detail: DisplayFailure }
  | { type: "failed"; code: ErrorCode; detail: string; partialPath?: string; outcome: FailureOutcome; session: SessionTrace; preflight?: never }
  /** Preflight refused before any attempt: no session exists, and none is borrowed. */
  | { type: "failed"; code: ErrorCode; detail: string; partialPath?: never; preflight: true }
  | { type: "permissionRequested"; needsRelaunch: boolean }
  /** No media existed: the temporary file is removed and idle returns without a failure. */
  | { type: "cancelled"; reason: CancelReason; session: SessionTrace }
  /**
   * A Live preview (plan 075, D20) began, became live, ended or could not start (`failure`, which is no recording's:
   * nothing is reported or kept). The state stays idle throughout; this says what the Recording Studio shows.
   */
  | { type: "preview"; failure?: { code: ErrorCode; detail: string } }
  /** Recordings being saved after capture stopped changed: one began or ended, or became slow (`Recorder.saving`). */
  | { type: "saving"; saving: readonly SavingRecording[] }
  /** A save outlived `saveSlowMs`: its drive may have stopped answering. Told once per save. */
  | { type: "savingSlow"; dir: string; session: SessionTrace };

/** A recording whose capture stopped and whose file is still being finished in the background. */
export interface SavingRecording {
  sessionId: string;
  /** The temporary `.recording.mp4` being finished. */
  recordingPath: string;
  /** It outlived `saveSlowMs`. */
  slow: boolean;
}

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
/** `previewing`: a Live preview's prepared session, held without writing until Start takes it (plan 075, D20). */
type Phase = "opening" | "preparing" | "previewing" | "countdown" | "arming" | "recording" | "stopping";

/** Names the phase in a start failure's detail. */
const BEFORE_CAPTURE: Partial<Record<Phase, string>> = {
  preparing: "preparing capture",
  previewing: "previewing",
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
  /** Whether the countdown ticks; taken with `countdownSeconds`, and false without a countdown. */
  countdownSound: boolean;
  /** Said under the countdown's digit (plan 097). */
  countdownNotice?: string;
  /** Whether the session records the system's sound (plan 101), a snapshot taken when the session was created. */
  systemAudio: boolean;
  /** Microphone snapshot taken when the session was created (plan 074). */
  microphone: SessionMicrophone;
  /** The engine told that the microphone stopped while recording. */
  microphoneLost?: boolean;
  /** The microphones recorded in turn, by name (plan 079, D3): the one prepared, then each one switched to. */
  microphones?: string[];
  /** A switch sent and not yet answered: the choice the session takes when it is. */
  microphoneSwitch?: SessionMicrophone | undefined;
  /** A choice made while a switch was being made, sent once that one is answered: one switch in flight at a time. */
  microphoneNext?: SessionMicrophone | undefined;
  /** Camera snapshot taken when the session was created (plan 075); absent is off. */
  camera?: SessionCamera;
  /** The engine told that the camera stopped while recording. */
  cameraLost?: boolean;
  /** The engine told that the camera gave no first frame in time (plan 090). */
  cameraNotReady?: boolean;
  /** What the camera does now (plan 090): absent until its first frame, which the engine tells as `cameraReady`. */
  cameraState?: "ready" | "notReady" | "lost";
  /** Hidden from the tray (D13); the camera stays open. */
  cameraHidden?: boolean;
  /**
   * A Live preview's session (plan 075, D20), until Start takes it: the state stays idle, nothing is reported as a
   * recording's, and its file is named again when Start takes it. `promote`: Start came before it was prepared.
   */
  preview?: { promote?: boolean };
  /** The name Start gave a taken preview's file (D20), applied once its writer opens if it was still opening. */
  claimedTarget?: string;
  /** Muted from the Recording Studio (plan 075, D19), for this recording only. */
  systemMuted?: boolean;
  microphoneMuted?: boolean;
  /** An editable recording (plan 087), read once when the session begins; it records every input as it comes (plan 097, D6). */
  editable?: boolean;
  /** Quit or sleep arrived before capture was prepared: cancel instead of counting down or recording. */
  cancelOnPrepared?: CancelReason;
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
  /**
   * `stopped` arrived and the finalizer owns the attempt: late host errors and
   * loss, a duplicate `stopped`, progress and display removal are ignored; only
   * the engine's outcome for the file can still fail it.
   */
  finalizing: boolean;
  /**
   * A cancel, quit or sleep that came after `record` went out: capture stops as soon as it starts. Should it stop
   * before a single frame, nothing was recorded, and that is the cancel, not a failed start.
   */
  stopOnStart?: CancelReason;
  /** The engine reported bytes written; nothing written neither satisfies the first-media deadline nor counts as media. */
  hasMedia: boolean;
  writer?: RecorderWriter;
  opening?: Promise<void>;
  timer?: ReturnType<typeof setTimeout> | undefined;
  /** Output folder, polled for free space while recording. */
  dir: string;
  startedAt: string;
  /** Set when the host confirmed capture and when stop was requested; carried on the terminal event. */
  recordingAt?: string;
  stoppingAt?: string;
  /** Guard between media reports after media began; the first-media deadline covers the time before. */
  stall?: ReturnType<typeof setTimeout> | undefined;
  disk?: ReturnType<typeof setTimeout> | undefined;
  diskWarned: boolean;
  diskPollFailed: boolean;
  stoppedEarly?: EarlyStop;
  /** Interruption evidence, from before the temporary file exists to the terminal outcome. */
  sentinel: SessionSentinelTracker;
}

const DEFAULT_START_TIMEOUT_MS = 8000;
/**
 * How long a start must have lasted before the shortcut or a click cancels it (plan 065):
 * above the 396 ms 95th percentile of 739 logged starts and the fastest logged double
 * press (290 ms), below the waits a person would try to escape (1.1 s and up).
 */
export const START_CANCEL_GRACE_MS = 1000;
const DEFAULT_CAPTURE_REQUEST_TIMEOUT_MS = 120_000;
const MAX_NAME_ATTEMPTS = 10;
/** A cleanup's file check that went unanswered (`withinCleanupCheck`). */
const CHECK_UNANSWERED = Symbol("check unanswered");
const DEFAULT_STOP_TIMEOUT_MS = 10_000;

/** `2026-09-11 14-30-00`, local time, safe on every file system. */
/**
 * The saved file's name for `stem`: `<stem>.mp4`, or for an editable recording `<stem>.recordstuff.mp4` (plan 100, D3),
 * so it is not taken for the video to send. The marker is only for people: the app knows an editable recording by the
 * description inside it, never by its name.
 */
export function savedName(stem: string, editable: boolean | undefined): string {
  return `${stem}${editable ? EDITABLE_MARKER : ""}.mp4`;
}

export function formatTimestamp(date: Date): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
    `${two(date.getHours())}-${two(date.getMinutes())}-${two(date.getSeconds())}`
  );
}

function errorCodeOf(cause: unknown, fallback: ErrorCode): ErrorCode {
  const code = errnoCode(cause);
  return isErrorCode(code) ? code : fallback;
}

export class Recorder {
  private _state: RecordingState = { type: "idle" };
  /** Latest watcher status, independent of the recording state (plan 027). */
  private permission: PermissionStatus = { granted: true, needsRelaunch: false };
  /** What idle shows once permission allows: the unusable-folder flag, which needsPermission does not carry. */
  private idleState: IdleState = { type: "idle" };
  private session: Session | undefined;
  /** Registered before any synchronous subscriber can request exit. */
  private pendingWork = 0;
  private shuttingDown: Promise<boolean> | undefined;
  private quitAdmission = false;
  /**
   * Folder checks that outlived their attempt's deadline (a network volume that stopped answering), by folder. Each
   * holds one of the main process's four file-system threads until the volume answers, and with all four held the
   * settings, history, sentinel and log writes queue behind them; a new attempt on that folder waits on it instead.
   */
  private hungChecks = new Map<string, Promise<void>>();
  private readonly workChanged = new Set<() => void>();
  /** Recordings whose capture stopped, still being finished (`saving`); the idle state no longer waits for them. */
  private readonly savings = new Map<string, SavingRecording & { slowTimer: ReturnType<typeof setTimeout> }>();
  /** Shared by every caller while media stays pending, so repeated quits add no listeners. */
  private mediaSettled: Promise<void> | undefined;
  private readonly listeners = new Set<(event: RecorderEvent) => void>();
  private readonly deps: Required<
    Pick<RecorderDeps, "now" | "newSessionId" | "startTimeoutMs" | "captureRequestTimeoutMs" | "stopTimeoutMs" | "shutdownTimeoutMs" | "log">
  > &
    RecorderDeps;
  private readonly health: RecorderHealth;

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
   * A session, or the cleanup and saving one left behind, is still in flight,
   * even when the state already reads idle. A windowless modal dialog now would
   * hold its writes and deadlines until answered (plan 056).
   */
  get mediaPending(): boolean {
    return this.session !== undefined || this.pendingWork > 0;
  }

  /** Recordings still being saved after their capture stopped, oldest first. */
  get saving(): readonly SavingRecording[] {
    return [...this.savings.values()].map(({ sessionId, recordingPath, slow }) => ({ sessionId, recordingPath, slow }));
  }

  /**
   * Quit waits only for saves: no session, and no other recording work (a failure's cleanup, a cancel). Quitting
   * without them leaves their sentinels, so the next launch reports each as possibly incomplete with its file kept.
   */
  get waitingOnlyForSaves(): boolean {
    return this.session === undefined && this.savings.size > 0 && this.pendingWork === this.savings.size;
  }

  /** Resolves once `mediaPending` is false, at once when it already is; the same test quit waits on. */
  whenMediaSettled(): Promise<void> {
    if (!this.mediaPending) return Promise.resolve();
    this.mediaSettled ??= new Promise((resolve) => {
      const check = (): void => {
        if (this.mediaPending) return;
        unsubscribe();
        this.workChanged.delete(check);
        this.mediaSettled = undefined;
        resolve();
      };
      const unsubscribe = this.subscribe((event) => { if (event.type === "state") check(); });
      this.workChanged.add(check);
    });
    return this.mediaSettled;
  }

  /**
   * The tray's Start recording (plan 048): the left click's start, countdown
   * included, but only from idle. An open macOS menu cannot change, so a
   * Start chosen after the state moved on must never stop or cancel anything.
   */
  startIfIdle(): boolean {
    if (this._state.type !== "idle") return false;
    this.toggle();
    return true;
  }

  /**
   * Left click and the shortcut (plan 016, one action for both): start when idle, stop when
   * recording, cancel a countdown, and cancel a start that has lasted `START_CANCEL_GRACE_MS`
   * (plan 065), as Cancel recording does. Within the grace a second press is a double press
   * and is ignored, as are presses while stopping; both are logged.
   */
  toggle(): void {
    switch (this._state.type) {
      case "idle":
        // Nothing can encode (plan 078): the tray and Settings say why, and a start would only fail.
        if (this.deps.mediaComponentsMissing) {
          this.deps.log("recorder: start refused: Windows's media components are missing");
          return;
        }
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
      case "starting": {
        const session = this.session;
        // `requestedAt` is taken in the same synchronous step that enters starting.
        const since = session ? this.monotonic() - session.requestedAt : undefined;
        if (since !== undefined && since >= START_CANCEL_GRACE_MS) this.cancelCountdown("toggle");
        else this.deps.log(`recorder: session ${session?.id ?? "?"} toggle ignored while starting (${since === undefined ? "?" : Math.round(since)} ms after the start)`);
        return;
      }
      case "stopping": {
        const session = this.session;
        const since = session?.stopRequestedAt === undefined ? "?" : this.elapsed(session.stopRequestedAt);
        this.deps.log(`recorder: session ${session?.id ?? "?"} toggle ignored while stopping (${since} ms after the stop)`);
        return;
      }
    }
  }

  /**
   * Before `record` is sent the attempt is cancelled. After it, the request
   * becomes a stop applied once `started` arrives, so a race of a few
   * milliseconds cannot leave capture running.
   *
   * A tray menu opened during the countdown stays as it was: macOS does not
   * let the app update or close an open tray menu, so its Cancel recording can
   * arrive after capture began. It still means "no recording", so it stops at
   * once and the file is saved, as a toggle after `record` would.
   *
   * The same Cancel is offered while starting, and a toggle reaches it once the
   * start has lasted the grace. With the countdown Off, `record` goes out at
   * `prepared` and the state stays starting, so a Cancel after it becomes the
   * stop-on-start request, as it does during a countdown.
   */
  cancelCountdown(reason: "toggle" | "menu" = "menu"): void {
    const session = this.session;
    const state = this._state.type;
    if (reason === "menu" && state === "recording" && session?.phase === "recording") {
      this.deps.log(`recorder: session ${session.id} Cancel recording arrived after capture started (a menu opened during the countdown); stopping`);
      this.stop();
      return;
    }
    if ((state !== "starting" && state !== "countdown") || !session) return;
    if (session.phase === "opening" || session.phase === "preparing" || session.phase === "countdown") {
      this.cancel(session, reason);
    } else if (session.phase === "arming" && !session.stopOnStart) {
      session.stopOnStart = reason;
      this.deps.log(`recorder: session ${session.id} cancel (${reason}) arrived after record was sent; stopping once capture starts`);
    }
  }

  /**
   * The session's camera and whether it is hidden (D13), while it can be changed (`updateCamera`), so nothing offers a
   * change it would refuse: once the engine's session is prepared and the state says so (the countdown or the
   * recording), since the state's change is what redraws Settings and the tray. Without a countdown the short arming
   * after `prepared` keeps `starting`.
   */
  get camera(): { hidden: boolean; state?: "waiting" | "notReady" | "lost" } | undefined {
    const session = this.cameraSession();
    if (!session) return undefined;
    // `state` only while the camera gives no picture (plan 090): waiting for its first frame, not ready or lost.
    const state = session.cameraState ?? "waiting";
    return { hidden: session.cameraHidden === true, ...(state === "ready" ? {} : { state }) };
  }

  /**
   * The recording in progress's audio while it can be changed (plan 075, D19): from its countdown, or without one its
   * start, until it stops, as `camera`; whether it records the microphone, and what is muted.
   */
  get audio(): { sessionId: string; systemMuted: boolean; system?: false; microphone?: { muted: boolean }; editable?: true } | undefined {
    const session = this.liveSession();
    if (!session) return undefined;
    return { sessionId: session.id, systemMuted: session.systemMuted === true, ...(session.systemAudio ? {} : { system: false as const }),
      ...(session.microphone.enabled ? { microphone: { muted: session.microphoneMuted === true } } : {}),
      ...(session.editable ? { editable: true as const } : {}) };
  }

  /**
   * Whether the session in progress, a Live preview's or a recording's, records an editable file (plan 087), from its
   * start until its file is handed to be saved; undefined without one.
   */
  get editable(): boolean | undefined {
    const session = this.session;
    return session ? session.editable === true : undefined;
  }

  /**
   * Mutes the recording's system audio or microphone, or not, from their next sound on (D19); false without one. An
   * editable recording refuses: it records every input as it comes, set afterwards in Edit… (plan 097, D6).
   */
  updateAudio(change: { system?: boolean; microphone?: boolean }): boolean {
    const session = this.liveSession();
    if (!session) return false;
    if (session.editable) {
      this.deps.log(`recorder: session ${session.id} is editable; its inputs are recorded as they come, not muted`);
      return false;
    }
    if (change.system !== undefined) session.systemMuted = change.system;
    if (change.microphone !== undefined) session.microphoneMuted = change.microphone;
    this.deps.log(`recorder: session ${session.id} system audio ${session.systemMuted ? "muted" : "on"}, microphone ${session.microphoneMuted ? "muted" : "on"}`);
    try {
      this.deps.host.setMuted?.(session.id, session.systemMuted === true, session.microphoneMuted === true);
    } catch (cause) {
      this.deps.log(`recorder: session ${session.id} mute not sent: ${messageOf(cause)}`);
      return false;
    }
    return true;
  }

  /**
   * Sends the saved volumes (D21) to the session whose sound is or will be read: a Live preview's or a recording's,
   * once prepared, until it stops. One still preparing takes them when prepared; false without one.
   */
  updateGains(): boolean {
    const session = this.session;
    const prepared = session && ["previewing", "countdown", "arming", "recording"].includes(session.phase);
    return prepared ? this.sendGains(session) : false;
  }

  /**
   * Sends the saved Input device to the recording in progress that records a microphone (plan 079, D3), from its
   * countdown until it stops; the engine opens it and tells whether it switched. False without one. A Live preview is
   * prepared again instead (index.ts).
   */
  updateMicrophone(): boolean {
    const session = this.session;
    if (!session || !session.microphone.enabled || !["countdown", "arming", "recording"].includes(session.phase)) return false;
    const chosen = this.deps.microphone?.();
    if (!chosen?.enabled || !this.deps.host.setMicrophone) return false;
    // One switch in flight at a time, so each answer is the request it answers (review of plan 079): a choice made
    // meanwhile waits for it, the latest replacing an earlier one that waits.
    if (session.microphoneSwitch) {
      if (chosen.deviceId === (session.microphoneNext ?? session.microphoneSwitch).deviceId) return false;
      session.microphoneNext = chosen;
      return true;
    }
    return this.sendMicrophone(session, chosen);
  }

  private sendMicrophone(session: Session, chosen: SessionMicrophone): boolean {
    if (chosen.deviceId === session.microphone.deviceId) return false;
    try {
      if (!this.deps.host.setMicrophone?.(session.id, chosen.deviceId)) return false;
    } catch (cause) {
      this.deps.log(`recorder: session ${session.id} microphone switch not sent: ${messageOf(cause)}`);
      return false;
    }
    session.microphoneSwitch = chosen;
    this.deps.log(`recorder: session ${session.id} switching the microphone to ${chosen.label ?? chosen.deviceId ?? "the system default input"}`);
    return true;
  }

  /** The switch in flight was answered: the choice that waited for it, if any, is sent now. */
  private microphoneAnswered(session: Session): void {
    session.microphoneSwitch = undefined;
    const next = session.microphoneNext;
    session.microphoneNext = undefined;
    if (next && ["countdown", "arming", "recording"].includes(session.phase)) this.sendMicrophone(session, next);
  }

  private sendGains(session: Session): boolean {
    // An editable recording keeps each input at 100% in its track, whatever the faders say (plan 097, D6): the saved
    // volumes stay for plain recordings, and Edit… sets an editable one's.
    const gain = session.editable ? EDITABLE_VOLUME : this.deps.audioVolume?.();
    if (!gain || !this.deps.host.setGains) return false;
    try {
      this.deps.host.setGains(session.id, gain);
    } catch (cause) {
      this.deps.log(`recorder: session ${session.id} volumes not sent: ${messageOf(cause)}`);
      return false;
    }
    return true;
  }

  /** The id of the session `camera` describes, which Settings' preview joins (plan 075 step 7). */
  get cameraSessionId(): string | undefined {
    return this.cameraSession()?.id;
  }

  private cameraSession(): Session | undefined {
    const session = this.liveSession();
    return session?.camera ? session : undefined;
  }

  /** The session once the engine's is prepared and the state says so (the countdown or the recording). */
  private liveSession(): Session | undefined {
    const session = this.session;
    // A Live preview's held session is live too (D20): its camera and mutes change as a recording's would.
    if (session?.phase === "previewing") return session;
    const prepared = session?.phase === "countdown" || session?.phase === "arming" || session?.phase === "recording";
    const shown = this._state.type === "countdown" || this._state.type === "recording";
    return session && prepared && shown ? session : undefined;
  }

  /**
   * Changes the camera of the session in progress (plan 075): a new layout (D7) or hiding and showing it (D13), from
   * its next frame on. Only while `camera` offers it, so a change is never kept here but lost there; nothing without a
   * session composing a camera. Logged with the session.
   */
  updateCamera(change: { layout?: CameraLayout; hidden?: boolean }): boolean {
    const session = this.cameraSession();
    if (!session?.camera) return false;
    // An editable recording's camera track is never hidden (plan 097, D6): Edit… hides stretches of it afterwards.
    if (session.editable && change.hidden !== undefined) {
      this.deps.log(`recorder: session ${session.id} is editable; its camera is not hidden while it records`);
      if (!change.layout) return false;
      change = { layout: change.layout };
    }
    if (change.layout) session.camera = { ...session.camera, layout: change.layout };
    if (change.hidden !== undefined) session.cameraHidden = change.hidden;
    this.deps.log(`recorder: session ${session.id} camera ${change.layout ? "layout changed" : ""}${change.layout && change.hidden !== undefined ? ", " : ""}` +
      `${change.hidden === undefined ? "" : change.hidden ? "hidden" : "shown"}`);
    try {
      this.deps.host.setCamera?.(session.id, session.camera, session.cameraHidden === true);
    } catch (cause) {
      this.deps.log(`recorder: session ${session.id} camera change not sent: ${messageOf(cause)}`);
      return false;
    }
    return true;
  }

  stop(): void {
    const session = this.session;
    if (this._state.type !== "recording" || !session || session.phase !== "recording") return;
    session.phase = "stopping";
    session.stoppingAt = this.deps.now().toISOString();
    session.stopRequestedAt = this.monotonic();
    this.clearTimer(session);
    this.clearDisk(session);
    session.timer = setTimeout(() => {
      void this.fail(session.id, "stop_timeout", "capture host did not stop before the deadline");
    }, this.deps.stopTimeoutMs);
    // The host's reply is always asynchronous, so the stop goes out before the
    // subscribers' logging and UI work: on sleep the tracks end ~150 ms later.
    // A request that throws still reads as stopping; the deadline above settles it.
    this.requestHostStop(session.id);
    this.setState({ type: "stopping" });
  }

  /**
   * The Mac is going to sleep (plan 050). An app cannot refuse a sleep the user
   * asked for, and capture ends about 150 ms later, so a recording is stopped
   * and saved now: once the host has the stop, a track ending afterwards no
   * longer turns it into a failure. Before capture there is nothing to keep: a
   * countdown is cancelled at once, and an attempt still opening or preparing is
   * cancelled once `prepared` (or whatever else ends it) arrives, since unlike
   * quit, sleep does not stop a pending capture request. The save may finish
   * after waking, because the system suspends the processes.
   */
  systemWillSleep(): void {
    const session = this.session;
    if (!session) return;
    switch (session.phase) {
      case "recording":
        session.stoppedEarly = "sleep";
        this.stop();
        this.deps.log(`recorder: session ${session.id} the Mac is going to sleep; stopped to save the recording`);
        return;
      case "countdown":
      case "previewing":
        this.cancel(session, "sleep");
        return;
      case "arming":
        session.stoppedEarly = "sleep";
        session.stopOnStart ??= "sleep";
        this.deps.log(`recorder: session ${session.id} the Mac is going to sleep after record was sent; stopping once capture starts`);
        return;
      case "opening":
      case "preparing":
        session.cancelOnPrepared ??= "sleep";
        return;
      case "stopping":
        return;
    }
  }

  /** False means quit was deferred; outstanding work remains owned by this recorder. */
  shutdown(): Promise<boolean> {
    if (this.shuttingDown) return this.shuttingDown;
    this.quitAdmission = true;
    // No media exists before `record`: quit cancels the attempt at once, as
    // Cancel recording does (plan 065), instead of waiting for a capture
    // request that may stay pending for minutes. The mark covers whatever
    // could end the attempt before `check` runs. After `record`, capture
    // stops once it starts.
    const pending = this.session;
    if (pending && (pending.phase === "opening" || pending.phase === "preparing")) pending.cancelOnPrepared ??= "quit";
    if (pending && pending.phase === "arming") pending.stopOnStart ??= "quit";
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
        const phase = this.session?.phase;
        if (phase === "opening" || phase === "preparing" || phase === "countdown" || phase === "previewing") this.cancel(this.session!, "quit");
        checking = false;
        if (!this.mediaPending) finish(true);
      };
      const unsubscribe = this.subscribe((event) => { if (event.type === "state") check(); });
      this.workChanged.add(check);
      const timer = setTimeout(() => {
        // Capture's own start/stop timers own failure. A quit deadline cannot
        // end a filesystem operation the cancelled attempt still awaits.
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
    this.pendingWork += 1;
    return task().finally(() => { this.pendingWork -= 1; for (const changed of this.workChanged) changed(); });
  }

  /**
   * macOS only. Always stored, even while busy: a permission change never
   * interrupts a running session, and the session's end settles from it.
   */
  setPermission(status: PermissionStatus): void {
    this.permission = status;
    // A Live preview cannot outlive screen recording's permission: let go of before the state says so (D20).
    if (!status.granted) this.stopPreview();
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
    return this.track(() => this.startOwned(false));
  }

  /**
   * A Live preview (plan 075, D20): the recording's own session, prepared and held without writing, so the Recording
   * Studio shows what a recording will hold and Start takes it into the countdown with no gap. Only from idle; the
   * state stays idle. False when none can begin now.
   */
  startPreview(): boolean {
    if (this.quitAdmission || this._state.type !== "idle" || this.session || this.deps.mediaComponentsMissing) return false;
    void this.track(() => this.startOwned(true));
    return true;
  }

  /**
   * Lets a Live preview go (D20): the Studio left, the window hidden or closed, or its settings changed. Never one
   * Start has taken, even while it still prepares: that is a recording now.
   */
  stopPreview(): void {
    const session = this.session;
    if (session?.preview && !session.preview.promote) this.cancel(session, "preview");
  }

  /** The Live preview, while there is one and Start has not taken it: whether it is live yet (prepared). */
  get preview(): { sessionId: string; live: boolean } | undefined {
    const session = this.session;
    return session?.preview && !session.preview.promote ? { sessionId: session.id, live: session.phase === "previewing" } : undefined;
  }

  /** The session whose picture the Recording Studio may show: a live preview or a recording, prepared (D20). */
  get previewSessionId(): string | undefined {
    return this.liveSession()?.id;
  }

  /**
   * Start takes the Live preview's session (D20): named now, as a recording started now would be, then the countdown
   * or the recording as for any start. One still preparing is taken once prepared.
   */
  private promote(session: Session): void {
    // Taken once: the name, the countdown and the start's time are this Start's, however long preparing still takes.
    const requested = this.deps.now();
    const stamp = (this.deps.fileName ?? formatTimestamp)(requested);
    session.claimedTarget = path.join(session.dir, savedName(stamp, session.editable));
    session.writer?.retarget?.(session.claimedTarget);
    session.startedAt = requested.toISOString();
    session.requestedAt = this.monotonic();
    session.countdownSeconds = this.deps.countdownSeconds?.() ?? 0;
    session.countdownSound = session.countdownSeconds > 0 && (this.deps.countdownSound?.() ?? false);
    const notice = session.countdownSeconds > 0 ? this.deps.countdownNotice?.() : undefined;
    if (notice) session.countdownNotice = notice;
    else delete session.countdownNotice;
    // A recording now, which a crash leaves evidence of; the preview left none (it is no recording's).
    session.sentinel = new SessionSentinelTracker(this.deps.sentinels, { id: session.id, startedAt: session.startedAt }, this.deps.log);
    const recordingPath = session.writer?.recordingPath;
    if (recordingPath) void this.track(() => session.sentinel.mark(recordingPath));
    session.preview = { promote: true };
    this.deps.log(`recorder: session ${session.id} Live preview taken by Start while ${session.phase}`);
    this.emit({ type: "preview" });
    this.setState({ type: "starting" });
    if (session.phase === "previewing") this.completePromotion(session);
  }

  /** The taken preview's session, prepared, goes on as any prepared start: the countdown or the recording. */
  private completePromotion(session: Session): void {
    delete session.preview;
    if (session.countdownSeconds > 0 && this.deps.countdown) {
      session.overlay = true;
      this.present("prepare", (presenter) => presenter.prepare?.(this.presentation(session)));
    }
    if (session.countdownSeconds > 0) this.beginCountdown(session);
    else this.record(session);
  }

  private async startOwned(preview: boolean): Promise<void> {
    if (!preview && this.session?.preview && !this.session.preview.promote && this._state.type === "idle" && !this.quitAdmission) {
      this.promote(this.session);
      return;
    }
    if (this.quitAdmission || this._state.type !== "idle" || this.session) return;
    const blocker = this.deps.preflight?.();
    if (blocker && preview) {
      // No recording was asked for: the Studio says why the preview could not start, nothing is reported.
      this.emit({ type: "preview", failure: { code: blocker, detail: "" } });
      return;
    }
    if (blocker) {
      const result: RecordingFailure = { id: randomUUID(), occurredAt: this.deps.now().toISOString(),
        code: blocker, detail: "", outcome: "pending" };
      await this.publishFailure(result);
      await this.publishFailure({ ...result, outcome: "empty" });
      this.emit({ type: "failed", code: blocker, detail: "", preflight: true });
      return;
    }

    const dir = this.deps.outputDir();
    const countdownSeconds = this.deps.countdownSeconds?.() ?? 0;
    // One instant names the file and dates the session's sentinel, even when the folder is slow to open.
    const requested = this.deps.now();
    const id = this.deps.newSessionId(), startedAt = requested.toISOString();
    const session: Session = {
      id,
      phase: "opening",
      quality: this.deps.quality(),
      countdownSeconds,
      countdownSound: countdownSeconds > 0 && (this.deps.countdownSound?.() ?? false),
      ...(() => { const notice = countdownSeconds > 0 ? this.deps.countdownNotice?.() : undefined; return notice ? { countdownNotice: notice } : {}; })(),
      systemAudio: this.deps.systemAudio?.() ?? true,
      microphone: this.deps.microphone?.() ?? { enabled: false },
      ...(() => { const camera = this.deps.camera?.(); return camera ? { camera } : {}; })(),
      ...(this.deps.editable?.() ? { editable: true } : {}),
      overlay: false,
      requestedAt: this.monotonic(),
      finalizing: false,
      hasMedia: false,
      dir,
      startedAt,
      diskWarned: false,
      diskPollFailed: false,
      // A preview leaves no interruption evidence until Start takes it (D20): a crash while previewing lost no recording.
      sentinel: new SessionSentinelTracker(preview ? undefined : this.deps.sentinels, { id, startedAt }, this.deps.log),
      ...(preview ? { preview: {} } : {}),
    };
    this.session = session;
    let check: Promise<void> | undefined;
    let checked = false;
    session.opening = Promise.resolve().then(async () => {
      const hung = this.hungChecks.get(dir);
      if (hung) this.deps.log(`recorder: session ${session.id} waits on the earlier check of ${dir}, still unanswered`);
      check = hung ?? this.deps.ensureWritableDir(dir);
      void check.then(() => { checked = true; }, () => { checked = true; });
      await check;
      if (this.session !== session) return;
      if (this.deps.freeSpace) {
        // Advisory, as during recording: a lookup that fails must not refuse a folder the probe just wrote to.
        const free = await this.deps.freeSpace(dir).catch((cause: unknown) => {
          this.deps.log(`recorder: session ${session.id} free-space check before start failed: ${messageOf(cause)}; starting without it`);
          return undefined;
        });
        if (free !== undefined && free < this.health.diskStopBytes) throw Object.assign(new Error("Insufficient free space to begin recording"), { code: "disk_full" });
      }
      if (this.session !== session) return;
      session.writer = await this.openUniqueWriter(session, (this.deps.fileName ?? formatTimestamp)(requested));
      // Start took the preview while its file was opening (D20): Start's name, and the recording's evidence.
      if (session.claimedTarget) {
        session.writer.retarget?.(session.claimedTarget);
        const recordingPath = session.writer.recordingPath;
        if (recordingPath) await session.sentinel.mark(recordingPath);
      }
    });
    // Isolated like the overlay and the subscribers: a throw here would leave the session set with no state to end it,
    // refusing every later start. Without its preparation the attempt fails through the normal capture path.
    try { this.deps.onSessionStart?.(session.id); }
    catch (cause) { this.deps.log(`recorder: session ${session.id} start hook failed: ${messageOf(cause)}`); }
    // A Live preview keeps the state idle: the tray and the shortcut still start a recording, which takes it.
    if (preview) this.emit({ type: "preview" });
    else this.setState({ type: "starting" });
    session.timer = setTimeout(() => {
      if (check && !checked) this.rememberHungCheck(dir, check);
      if (this.cancelMarked(session, "opening the folder timed out")) return;
      void this.fail(session.id, "output_open_failed", `opening ${dir} did not finish within ${this.deps.startTimeoutMs} ms`,
        { outputDirUnavailable: true });
    }, this.deps.startTimeoutMs);
    try {
      await session.opening;
    } catch (cause) {
      if (this.cancelMarked(session, "opening the folder failed", messageOf(cause))) return;
      const code = errorCodeOf(cause, "output_open_failed");
      // A full disk is not an unusable folder: the tray says "Output folder unavailable" only for the latter.
      await this.fail(session.id, code, messageOf(cause), code === "disk_full" ? {} : { outputDirUnavailable: true });
      return;
    }
    // A timed-out opening belongs to the failure owner, including its late handle.
    if (this.session !== session) return;
    // Quit or sleep arrived while the folder was probed: no capture request at all.
    if (session.cancelOnPrepared) {
      this.cancel(session, session.cancelOnPrepared);
      return;
    }

    session.phase = "preparing";
    this.clearTimer(session);
    // Bounds `start → prepared`: permission prompts, missing audio, unsupported
    // MP4 and display errors all surface here, before any countdown.
    session.timer = setTimeout(() => {
      if (this.cancelMarked(session, "capture request timed out")) return;
      void this.fail(session.id, "capture_start_failed", "screen/audio capture request timed out; complete system permission prompts and retry");
    }, this.deps.captureRequestTimeoutMs);
    if (!session.preview && session.countdownSeconds > 0 && this.deps.countdown) {
      session.overlay = true;
      this.present("prepare", (presenter) => presenter.prepare?.(this.presentation(session)));
    }
    try {
      const { label: _label, ...microphone } = session.microphone;
      const capture: SessionCapture = { ...(session.systemAudio ? {} : { systemAudio: false as const }), ...(microphone.enabled ? { microphone } : {}), ...(session.camera ? { camera: session.camera } : {}),
        ...(session.editable ? { editable: true as const } : {}) };
      await this.deps.host.start(session.id, session.quality, session.writer?.recordingPath, Object.keys(capture).length ? capture : undefined);
    } catch (cause) {
      if (this.cancelMarked(session, "capture request failed", messageOf(cause))) return;
      await this.fail(session.id, cause instanceof HostStartError ? cause.code : "capture_start_failed", messageOf(cause));
    }
  }

  /**
   * Sleep or quit already asked to cancel this attempt before `prepared`, and
   * nothing was captured, so whatever ends it now (a host error or loss, a
   * removed display, a timed-out or refused request) is that cancel, not a
   * failure: the tracks and timers of a Mac going to sleep are not a fault.
   * The mark exists only while opening or preparing; `prepared` consumes it.
   */
  private cancelMarked(session: Session, cause: string, detail?: string): boolean {
    const reason = session.cancelOnPrepared;
    if (!reason || this.session !== session) return false;
    this.deps.log(`recorder: session ${session.id} ${cause} after cancel (${reason}) was requested${detail === undefined ? "" : `: ${detail}`}`);
    this.cancel(session, reason);
    return true;
  }

  /** `check` of `dir` outlived its deadline: later attempts on the folder wait on it until it answers. */
  private rememberHungCheck(dir: string, check: Promise<void>): void {
    if (this.hungChecks.get(dir) === check) return;
    this.hungChecks.set(dir, check);
    const forget = (): void => { if (this.hungChecks.get(dir) === check) this.hungChecks.delete(dir); };
    void check.then(forget, forget);
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
      await session.sentinel.mark(recordingPath);
      try {
        return await this.deps.openWriter(recordingPath, path.join(session.dir, savedName(name, session.editable)));
      } catch (cause) {
        // `FileWriteError` wraps the open error as its cause.
        const errno = errnoCode(cause instanceof Error ? cause.cause : undefined);
        // An attempt that already ended (its deadline, a cancel) creates no further name or sentinel.
        if (errno !== "EEXIST" || attempt >= MAX_NAME_ATTEMPTS || this.session !== session) throw cause;
      }
    }
  }

  private handleHostMessage(message: HostMessage): void {
    // `microphones` and `cameras` answer a listing process, never an attempt's; `screenAccess` answers main's display request.
    if (message.type === "ready" || message.type === "pong" || message.type === "microphones" || message.type === "cameras" || message.type === "screenAccess") return;
    // Settings' monitor process answers these (plan 079), never an attempt's.
    if (message.type === "meterStarted" || message.type === "meterLevel" || message.type === "meterStopped") return;
    const session = this.session;
    if (message.type === "error") {
      if (session && !session.finalizing && message.sessionId === session.id) {
        if (this.cancelMarked(session, `host reported ${message.code}`, message.detail)) return;
        let code = this.deps.mapHostError ? this.deps.mapHostError(message.code) : message.code;
        let detail = message.detail;
        // Nothing was recorded yet: a source that ended is a start failure.
        const phase = BEFORE_CAPTURE[session.phase];
        if (phase && (code === "capture_failed" || code === "capture_start_failed")) {
          code = "capture_start_failed";
          detail = `${detail} (while ${phase})`;
        }
        if (message.displayFailure) this.emit({ type: "displayFailed", detail: message.displayFailure });
        void this.fail(session.id, code, detail);
      }
      return;
    }
    if (!session || message.sessionId !== session.id) {
      // A session we already gave up on (e.g. start timed out while the host
      // was still preparing) must not keep capturing unseen.
      if (message.type === "prepared" || message.type === "started" || message.type === "progress") {
        this.deps.log(`recorder: stopping stale session ${message.sessionId} (${message.type})`);
        this.requestHostStop(message.sessionId);
      }
      return;
    }
    switch (message.type) {
      case "prepared":
        if (session.phase !== "preparing") return;
        this.clearTimer(session);
        session.capture = message.capture;
        if (message.capture.microphone) session.microphones = [message.capture.microphone];
        this.deps.log(`recorder: session ${session.id} prepared after ${this.elapsed(session.requestedAt)} ms; countdown ${session.countdownSeconds} s; sound ${session.countdownSound ? "on" : "off"}; mime ${message.mimeType}; ${describeMicrophone(session.microphone, message.capture.microphone)}`);
        if (session.cancelOnPrepared) {
          this.cancel(session, session.cancelOnPrepared);
          return;
        }
        // Before its levels are watched or its sound taken, the volumes as they are now (D21).
        this.sendGains(session);
        if (session.preview) {
          // Held without writing until Start takes it (D20), or taken now if Start came while it was preparing.
          session.phase = "previewing";
          // The bubble as it is now: changed while preparing, it reached no session yet.
          const camera = this.deps.camera?.();
          if (session.camera && camera && JSON.stringify(camera.layout) !== JSON.stringify(session.camera.layout)) {
            session.camera = { ...session.camera, layout: camera.layout };
            try { this.deps.host.setCamera?.(session.id, session.camera, session.cameraHidden === true); }
            catch (cause) { this.deps.log(`recorder: session ${session.id} camera layout not sent: ${messageOf(cause)}`); }
          }
          if (session.preview.promote) this.completePromotion(session);
          else this.emit({ type: "preview" });
          return;
        }
        if (session.countdownSeconds > 0) this.beginCountdown(session);
        else this.record(session);
        return;
      case "started": {
        // `arming` follows `prepared`, which set the report.
        const capture = session.capture;
        if (session.phase !== "arming" || !capture) return;
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
      case "progress":
        // The engine writes the file itself and reports that media still arrives.
        this.mediaArrived(session, message.bytes, "engine progress");
        return;
      case "health":
        // Plan 100 step 4: what paces a version prepared alongside the recording; nothing of the recording's own.
        if (!this.acceptsMedia(session)) return;
        this.emit({ type: "health", sessionId: session.id, health: { late: message.late, lost: message.lost, backlog: message.backlog } });
        return;
      case "writeError":
        if (!session.finalizing) void this.fail(session.id, message.code, message.detail);
        return;
      case "microphoneLost":
        // The recording goes on with system audio, and takes the microphone again if it comes back; each dropout is
        // logged, and the saved recording and one notice say there was one (plan 074).
        if (!this.acceptsMedia(session)) return;
        this.deps.log(`recorder: session ${session.id} microphone lost; recording continues without it: ${message.detail}`);
        if (session.microphoneLost) return;
        session.microphoneLost = true;
        this.emit({ type: "microphoneLost", sessionId: session.id, detail: message.detail });
        return;
      case "microphoneResumed":
        if (this.acceptsMedia(session)) this.deps.log(`recorder: session ${session.id} microphone resumed: ${message.detail}`);
        return;
      case "microphoneSwitched":
        // The user's choice while recording (plan 079, D3), from the countdown on: the log and the saved record name
        // every device.
        if (session.finalizing || !session.microphoneSwitch) return;
        session.microphone = session.microphoneSwitch;
        // The device recorded already (System default and that device by name): the choice is taken, nothing switched.
        if (message.from === message.to) this.deps.log(`recorder: session ${session.id} microphone ${message.to} kept: it is the one chosen`);
        else {
          this.deps.log(`recorder: session ${session.id} microphone switched from ${message.from} to ${message.to}`);
          session.microphones = [...(session.microphones ?? [message.from]), message.to];
        }
        this.microphoneAnswered(session);
        return;
      case "microphoneSwitchFailed":
        if (session.finalizing || !session.microphoneSwitch) return;
        this.deps.log(`recorder: session ${session.id} microphone not switched: ${message.detail}`);
        this.microphoneAnswered(session);
        return;
      case "cameraLost":
        // The recording goes on with the screen alone, and composes the camera again if it comes back (plan 075, D12).
        if (!this.acceptsMedia(session)) return;
        this.cameraStateChanged(session, "lost");
        this.deps.log(`recorder: session ${session.id} camera lost; recording continues without it: ${message.detail}`);
        if (session.cameraLost) return;
        session.cameraLost = true;
        this.emit({ type: "cameraLost", sessionId: session.id, detail: message.detail });
        return;
      case "cameraNotReady":
        // Not a loss (plan 090, D1): the recording began with the screen alone and composes the camera once it delivers.
        if (!this.acceptsMedia(session)) return;
        this.cameraStateChanged(session, "notReady");
        this.deps.log(`recorder: session ${session.id} camera not ready; recording continues without it: ${message.detail}`);
        if (session.cameraNotReady) return;
        session.cameraNotReady = true;
        this.emit({ type: "cameraNotReady", sessionId: session.id, detail: message.detail });
        return;
      case "cameraReady":
        // Also while preparing, a Live preview or the countdown: the Studio waits for the camera from its opening.
        if (session.finalizing) return;
        this.deps.log(`recorder: session ${session.id} camera ready: ${message.detail}`);
        this.cameraStateChanged(session, "ready");
        return;
      case "cameraResumed":
        if (session.finalizing) return;
        if (this.acceptsMedia(session)) this.deps.log(`recorder: session ${session.id} camera resumed: ${message.detail}`);
        this.cameraStateChanged(session, "ready");
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
          // The file is the engine's to finish now: the recording is over, and saving it goes on in the background, owned like
          // any other recording work (quit waits for it), while the next recording may already start (2026-10-09).
          this.session = undefined;
          this.closeOverlay(session);
          // Owned before idle is told: a quit that the idle state wakes must find the save still pending.
          void this.track(() => this.finalize(session));
          this.settle({ type: "idle" });
        } else {
          void this.fail(session.id, "capture_failed", "capture host ended capture without a stop request");
        }
        return;
    }
  }

  /** Media can exist only after `record`, and not once the finalizer owns the attempt. */
  /** What the countdown's overlay shows with each digit: the tick, and the line under it. */
  private presentation(session: Session): CountdownPresentation {
    return { sound: session.countdownSound, ...(session.countdownNotice ? { notice: session.countdownNotice } : {}) };
  }

  private cameraStateChanged(session: Session, state: NonNullable<Session["cameraState"]>): void {
    if (session.cameraState === state) return;
    session.cameraState = state;
    this.emit({ type: "cameraState" });
  }

  private acceptsMedia(session: Session): boolean {
    return !session.finalizing && (session.phase === "arming" || session.phase === "recording" || session.phase === "stopping");
  }

  /**
   * Media arrived (the engine's progress): the first-media deadline and the stall guard hear it.
   * Empty media is not media, so it neither satisfies the deadline nor resets the guard.
   */
  private mediaArrived(session: Session, bytes: number, source?: "engine progress"): void {
    if (!this.acceptsMedia(session)) return;
    const nonEmpty = bytes > 0;
    if (!session.hasMedia && nonEmpty) {
      session.hasMedia = true;
      // "first chunk" is what the acceptance runners time to; the engine's progress counts the bytes written so far.
      this.deps.log(`recorder: session ${session.id} first chunk ${bytes} bytes${source ? ` (${source})` : ""}`);
      // Only the first-chunk deadline ends here: before `started` the timer is the record → started deadline.
      if (session.phase === "recording") this.clearTimer(session);
    }
    if (nonEmpty && session.phase !== "arming") this.armStall(session);
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
      this.present("show", (presenter) => presenter.show(seconds, this.presentation(session)));
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

  /** Where a cancel and a failure begin: the session leaves, its timers and overlay go, and capture is told to stop. */
  private detach(session: Session): void {
    this.session = undefined;
    this.clearTimer(session);
    this.clearCountdown(session);
    this.clearHealth(session);
    this.closeOverlay(session);
    if (session.phase === "opening") return;
    // The session is already gone: a throw here would leave its state with nothing to settle it.
    this.requestHostStop(session.id);
  }

  /**
   * Every stop request goes through here. A throw must reach neither the caller (a sleep, a shortcut, the host's
   * own message) nor the state: each path has a deadline or an outcome of its own that settles the session.
   */
  private requestHostStop(sessionId: string): void {
    try { this.deps.host.stop(sessionId); }
    catch (cause) { this.deps.log(`recorder: session ${sessionId} stop request failed: ${messageOf(cause)}`); }
  }

  /**
   * No media exists before `record`, so a cancel is not a failure: no failure
   * status, history, notification or display diagnostic. The empty temporary
   * file is removed and the idle state from before the attempt returns.
   */
  private cancel(session: Session, reason: CancelReason): void {
    if (this.session !== session) return;
    this.detach(session);
    this.deps.log(`recorder: session ${session.id} cancelled (${reason}) while ${BEFORE_CAPTURE[session.phase] ?? "opening the recording file"}`);
    // Owned before idle is published: a quit waiting on that state change
    // must also wait for the temporary file and the sentinel to go.
    void this.track(async () => {
      await session.opening?.catch(() => undefined);
      try {
        const kept = session.writer ? await this.withinCleanupCheck(session.writer.abandon()) : undefined;
        if (kept === CHECK_UNANSWERED) this.deps.log(`recorder: cancelled session ${session.id} cleanup unanswered after ${this.health.cleanupCheckMs} ms; the drive may not be responding`);
        else if (kept) this.deps.log(`recorder: cancelled session ${session.id} unexpectedly kept ${kept}`);
      } catch (cause) {
        this.deps.log(`recorder: cancelled session ${session.id} cleanup could not be confirmed: ${messageOf(cause)}`);
      }
      this.emit({ type: "cancelled", reason, session: this.trace(session) });
      await session.sentinel.clear();
    });
    // The Studio's preview is gone with it.
    if (session.preview) this.emit({ type: "preview" });
    // Only an opened writer proves the folder usable again; a cancel while it is still being checked keeps the flag.
    if (session.writer) {
      const { outputDirUnavailable: _usable, ...idle } = this.idleState;
      this.settle(idle);
    } else this.settle(this.idleState);
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

  /**
   * Saves a recording whose capture stopped, in the background: the state is idle already. Listed in `saving` while it
   * runs, said to be slow once it outlives `saveSlowMs`, and never abandoned for being slow. Its outcome is reported
   * like any session's, without touching the state, which may belong to the next recording by then.
   */
  private async finalize(session: Session): Promise<void> {
    const writer = session.writer;
    if (!writer) return;
    const slowTimer = setTimeout(() => {
      const entry = this.savings.get(session.id);
      if (!entry) return;
      this.deps.log(`recorder: session ${session.id} still saving to ${session.dir} after ${this.health.saveSlowMs} ms; the drive may not be responding`);
      entry.slow = true;
      this.emit({ type: "saving", saving: this.saving });
      this.emit({ type: "savingSlow", dir: session.dir, session: this.trace(session) });
    }, this.health.saveSlowMs);
    this.savings.set(session.id, { sessionId: session.id, recordingPath: writer.recordingPath ?? "", slow: false, slowTimer });
    this.emit({ type: "saving", saving: this.saving });
    try {
      await this.save(session, writer);
    } finally {
      this.endSaving(session);
    }
  }

  /** The save has an outcome: it leaves `saving` before that outcome is told. Idempotent. */
  private endSaving(session: Session): void {
    const entry = this.savings.get(session.id);
    if (!entry) return;
    clearTimeout(entry.slowTimer);
    this.savings.delete(session.id);
    this.emit({ type: "saving", saving: this.saving });
  }

  private async save(session: Session, writer: RecorderWriter): Promise<void> {
    const drainedAt = this.monotonic();
    let finalPath: string;
    try {
      finalPath = await writer.finish();
    } catch (cause) {
      // The writer already removed the empty file: a stop that ended a cancelled start before its first frame recorded
      // nothing, which is what the cancel asked for.
      const reason = session.stopOnStart;
      this.endSaving(session);
      if (reason && cause instanceof Error && cause.cause === NO_MEDIA_DETAIL) {
        this.deps.log(`recorder: session ${session.id} cancelled (${reason}) after record was sent; capture stopped before its first frame`);
        this.emit({ type: "cancelled", reason, session: this.trace(session) });
        await session.sentinel.clear();
        return;
      }
      // Zero confirmed bytes arrive here as capture_start_failed; disk errors keep their code.
      const code = errorCodeOf(cause, "output_write_failed"), detail = messageOf(cause);
      this.deps.log(`recorder: session ${session.id} failed: ${code} ${detail}`);
      await this.reportFailure(session, code, detail, this.deps.now().toISOString());
      return;
    }
    let checkpointMs: number | undefined;
    const checkpointAt = this.monotonic();
    const checkpoint = session.sentinel.complete(finalPath);
    if (checkpoint) { await checkpoint; checkpointMs = this.monotonic() - checkpointAt; }
    const early = session.stoppedEarly ? ` (stopped early: ${EARLY_STOP_TEXT[session.stoppedEarly]})` : "";
    this.deps.log(`recorder: session ${session.id} file finalized ${finalPath}${early}`);
    this.logFinalizeTiming(session, drainedAt, checkpointMs);
    this.endSaving(session);
    this.emit({ type: "saved", path: finalPath, ...(session.stoppedEarly ? { stoppedEarly: session.stoppedEarly } : {}),
      ...(session.microphoneLost ? { microphoneLost: true as const } : {}), ...(session.cameraLost ? { cameraLost: true as const } : {}),
      ...(session.cameraNotReady ? { cameraNotReady: true as const } : {}),
      ...((session.microphones?.length ?? 0) > 1 ? { microphones: session.microphones } : {}),
      ...(session.editable ? { editable: true as const } : {}),
      session: this.trace(session) });
    await session.sentinel.clear();
  }

  /** Where the wait between stop and saved went; stop-to-ready itself is the state lines' interval. */
  private logFinalizeTiming(session: Session, drainedAt: number, checkpointMs: number | undefined): void {
    const timings = session.writer?.finishTimings;
    const ms = (value: number | undefined): string => value === undefined ? "?" : String(Math.round(value));
    const span = (from: number | undefined, to: number | undefined): number | undefined =>
      from === undefined || to === undefined ? undefined : to - from;
    this.deps.log(`recorder: session ${session.id} finalize timing: host ${ms(span(session.stopRequestedAt, session.hostStoppedAt))} ms, ` +
      `writes ${ms(span(session.hostStoppedAt, drainedAt))} ms, flush ${ms(timings?.flushMs)} ms, ` +
      `finalize ${ms(timings?.finalizeMs)} ms ${timings ? timings.fragmented === undefined ? "to plain MP4" : `kept fragmented (${timings.fragmented})` : "?"}, ` +
      `close ${ms(timings?.closeMs)} ms, ` +
      `publish ${ms(timings?.publishMs)} ms by ${timings?.method ?? "?"}${timings?.linkError ? ` (link ${timings.linkError})` : ""}, ` +
      `cleanup ${ms(timings?.cleanupMs)} ms${timings?.cleanupError ? ` (temporary name kept: ${timings.cleanupError})` : ""}, ` +
      `checkpoint ${ms(checkpointMs)} ms; ` +
      `${session.writer?.bytesWritten ?? "?"} bytes`);
  }

  /**
   * One timer between media reports after media began: warn once at the first bound,
   * fail at the second with the partial file preserved. Heartbeats only prove
   * the capture process answers; this proves media still arrives.
   */
  private armStall(session: Session): void {
    if (session.stall) clearTimeout(session.stall);
    const { stallWarnMs, stallFailMs } = this.health;
    session.stall = setTimeout(() => {
      this.deps.log(`recorder: session ${session.id} no media for ${stallWarnMs} ms`);
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
          this.deps.log(`recorder: session ${session.id} ${free} bytes free in ${session.dir}, below ${diskWarnBytes}`);
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
   * Display loss shares the idempotent failure path with track end and host
   * failure. Once the host has the stop, the file is complete up to it and a
   * track ending afterwards does not fail it (as on sleep, plan 050): the stop's
   * reply or its deadline decides.
   */
  displayRemoved(): void {
    const session = this.session;
    if (session && !session.finalizing) {
      if (session.phase === "stopping") {
        this.deps.log(`recorder: session ${session.id} display removed after the stop was sent; saving what was recorded`);
        return;
      }
      if (this.cancelMarked(session, "recording display removed")) return;
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
    if (this.cancelMarked(session, code, detail)) return;
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
    if (session.preview && !session.preview.promote) {
      // A Live preview that could not start or went on failing (D20) is no recording's failure: nothing is reported
      // or kept, the Studio says why, and a recording can still start.
      this.cancel(session, "preview");
      this.deps.log(`recorder: session ${session.id} Live preview ended: ${code} ${detail}`);
      this.emit({ type: "preview", failure: { code, detail } });
      return;
    }
    this.detach(session);
    this.deps.log(`recorder: session ${session.id} failed: ${code} ${detail}`);
    const occurredAt = this.deps.now().toISOString();
    // End the recording state before file cleanup. Native painting can still
    // wait on synchronous subscriber IO (docs/system-design/recording.md).
    // Set idle and request tray updates before synchronous metadata persistence.
    this.settle({ type: "idle", ...idleFlags });
    /** The idle this failure set; any later settle, folder change or failure replaces it, and with it the flag's owner. */
    const flaggedIdle = this.idleState;
    const opened = await this.reportFailure(session, code, detail, occurredAt);
    // A folder that answered only after the opening deadline (a drive waking, a slow share) is usable: the flag this
    // failure set would otherwise go on saying it is unavailable until another folder is chosen. Only while the flag is
    // still this failure's: a newer attempt, even one that failed on its own folder, decides (review pass 1, F1).
    if (opened && idleFlags.outputDirUnavailable && !this.session && this.idleState === flaggedIdle) {
      this.deps.log(`recorder: session ${session.id} the output folder answered after the failure; it is usable again`);
      this.outputDirChanged();
    }
  }

  /**
   * The failure's report and its file's outcome: the partial kept, or why not, then the failed event and the
   * sentinel's removal. Resolves whether the session's folder opening finished after all. It never touches the state:
   * a failure ends its session first, and a save in the background has no session left to end.
   */
  private async reportFailure(session: Session, code: ErrorCode, detail: string, occurredAt: string): Promise<boolean> {
    const result: RecordingFailure = { id: randomUUID(), occurredAt,
      code, detail, outcome: "pending", ...(session.writer?.recordingPath ? { recordingPath: session.writer.recordingPath } : {}) };
    // Before the report, so a process that ends while the cleanup below still runs (a stalled share, then a force
    // quit) has its leftover sentinel reported under this id, not as a second entry (review pass 1, F1).
    const failing = session.sentinel.failing(result.id);
    if (failing) await failing;
    await this.publishFailure(result);
    let partialPath: string | undefined;
    let outcome: FailureOutcome = "empty";
    /** The opening finished after all: its probe wrote to the folder, whatever else ended the attempt. */
    let opened = false;
    try {
      opened = session.opening ? await session.opening.then(() => true, () => false) : false;
      const kept = session.writer ? await this.withinCleanupCheck(session.writer.abandon()) : undefined;
      if (kept === CHECK_UNANSWERED) {
        this.deps.log(`recorder: session ${session.id} partial check unanswered after ${this.health.cleanupCheckMs} ms; the drive may not be responding`);
        outcome = "unknown";
      } else {
        partialPath = kept;
        outcome = session.writer?.preservationUncertain ? "unknown" : partialPath ? "partial" : "empty";
        if (outcome === "unknown") partialPath = undefined;
      }
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
    await session.sentinel.clear();
    return opened;
  }

  /** `work`'s answer, or CHECK_UNANSWERED once `cleanupCheckMs` passed without one (a drive that stopped answering). */
  private async withinCleanupCheck<T>(work: Promise<T>): Promise<T | typeof CHECK_UNANSWERED> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unanswered = new Promise<typeof CHECK_UNANSWERED>((resolve) => { timer = setTimeout(() => resolve(CHECK_UNANSWERED), this.health.cleanupCheckMs); });
    try { return await Promise.race([work, unanswered]); }
    finally { clearTimeout(timer); }
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
    this.setState(this.permission.granted ? idle : { type: "needsPermission", needsRelaunch: this.permission.needsRelaunch });
  }

  private setState(state: RecordingState): void {
    this._state = state;
    this.emit({ type: "state", state });
  }

  /**
   * A throwing subscriber is logged and skipped: it must not keep the others
   * from the event, nor abort the recorder's own work after the emit, such as
   * removing the session's sentinel or arming the next deadline.
   */
  private emit(event: RecorderEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); }
      catch (cause) { this.deps.log(`recorder: ${event.type} subscriber failed: ${messageOf(cause)}`); }
    }
  }

}

/**
 * The prepared line's microphone (plan 074): `mic off`, or `mic on` with the device the engine opened, which is the
 * default input's when a chosen one was not connected; the requested one only when the engine named none.
 */
function describeMicrophone(microphone: SessionMicrophone, opened: string | undefined): string {
  if (!microphone.enabled) return "mic off";
  return `mic on (${opened ?? microphone.label ?? microphone.deviceId ?? "system default"})`;
}
