/**
 * Supervises the native engine's capture host (plan 076): every `start` forks a fresh `utilityProcess` for that attempt (native-host-process.ts), validates
 * every inbound message, and detects a crash (the process exits) or a hang (two missed pongs while a session is in
 * flight). The owner calls `destroy` when the attempt settles, which ends the process, so nothing idles between
 * recordings.
 *
 * Before posting `start` it resolves the display through `DisplayMedia`, which keeps display choice, its diagnostics and
 * the countdown's display in main. The
 * display is chosen while the process starts, so neither waits for the other.
 *
 * On Windows the engine finds the display by a point on it, and cannot leave RecordStuff's windows out of the
 * recording itself: from `start` until the attempt is torn down, main marks them excluded from capture.
 *
 * After `stopped` the engine still finishes the file, which on a slow volume can take long after the recorder went
 * idle and tore the attempt down: that process is kept until it reports `finished` or the write error that kept the
 * file from being finished (`fileOutcome` hands either to the writer), exits, or outlives `FINISH_BOUND_MS`.
 *
 * `listMicrophones` (plan 074) forks a process of its own, which lists the audio inputs and is ended: the engine stays
 * out of main, and an attempt's process is never asked. `openMonitor` (plan 079) forks one that lives while Settings is
 * open, following the device list and reading the input level meter's device.
 */
import { utilityProcess, type UtilityProcess } from "electron";
import { recordedPosition } from "../../shared/camera-layout";
import { PREVIEW_PORT_MESSAGE } from "../../shared/camera-preview";
import { HostStartError, MEDIA_COMPONENTS_MISSING_EXIT, isHostMessage, type EngineFileReport, type HostMessage, type MainMessage, type MicrophoneDevice, type CameraChoice, type CameraDevice, type ScreenAccess } from "../../shared/protocol";
import type { QualitySettings } from "../../shared/quality";
import { volumeDb, type AudioVolume } from "../../shared/audio-volume";
import type { RecorderHost, SessionCamera, SessionCapture } from "./recorder";
import { FileWriteError } from "./file-writer";
import { pipeLines } from "../lib/pipe-lines";

export interface NativeCaptureHostOptions {
  /** The built native-host-process.js. */
  entryPath: string;
  /** The engine's `.node` file, outside the asar archive. */
  addonPath: string;
  /**
   * The display this attempt records (Electron's display id), or undefined when main refused one. `screenAccess` asks
   * the attempt's process whether macOS lets the engine capture a display (plan 089, D1), once that process is ready.
   */
  resolveDisplay: (sessionId: string, screenAccess: (displayId: string) => Promise<ScreenAccess>) => Promise<string | undefined>;
  /** A point on that display in physical screen pixels, which is how the engine finds it on Windows. */
  displayPoint?: (displayId: string) => { x: number; y: number } | undefined;
  /** Keeps RecordStuff's windows out of capture, or lets them back in (Windows, where the engine cannot). */
  excludeOwnWindows?: (excluded: boolean) => void;
  /**
   * Before the engine reads what it may capture (macOS, plan 078 step 2): ScreenCaptureKit lists an app, and so can
   * leave it out, only while it owns a window, and a menu bar app with nothing open owns none (its status item is
   * Control Center's). Main makes sure it owns one.
   */
  beforeCapture?: () => void;
  /** RecordStuff's processes, main first, whose windows and sound the recording leaves out. */
  ownPids: () => number[];
  hideSystemUi: () => boolean;
  /**
   * Before a recording with the microphone (plan 074): asks macOS for access if it never has, so the prompt comes
   * while the session starts, the recorder's capture-request deadline covering it, and not as a silent refusal.
   */
  prepareMicrophone?: () => Promise<void>;
  pingIntervalMs?: number;
  readyTimeoutMs?: number;
  log?: (message: string) => void;
  /** Forks the host; tests pass a fake. */
  fork?: (entryPath: string, args: string[]) => UtilityProcess;
  /** Each recording attempt's process, once forked (plan 075's prototype hands it the preview page's port). */
  onLaunch?: (child: UtilityProcess) => void;
  now?: () => number;
}

type FailureCode = "capture_host_crashed" | "capture_host_unresponsive";

/** How long windows stay excluded after the capture process was told to end, if it does not report its exit. */
const RELEASE_BOUND_MS = 5000;
/** Past the engine's own 120 s bound for finishing a file: a process still silent then is ended, the file kept. */
const FINISH_BOUND_MS = 150_000;
/** Listing the audio inputs: the process's start and AVFoundation's or WASAPI's answer. */
const LIST_BOUND_MS = 8000;
/** Past the engine's 15 s bound on ScreenCaptureKit's content: the grant is then "unknown". */
const ACCESS_BOUND_MS = 16_000;

/** Settings' monitor process (plan 079): what main posts to it, and its end. */
export interface MonitorProcess {
  post(message: MainMessage): void;
  close(): void;
}

interface FileOutcome {
  promise: Promise<EngineFileReport>;
  settled: boolean;
  resolve: (report: EngineFileReport) => void;
  reject: (cause: Error) => void;
}

/** A process that stopped capturing and is finishing `recordingPath`. */
interface Finishing { sessionId: string; recordingPath: string; bound: ReturnType<typeof setTimeout> }

/**
 * The camera's choice for a recording of `display` (plan 075): the bubble where it was placed on that display, else
 * where it was placed for the primary display, else the default position.
 */
export function cameraChoice(camera: SessionCamera, display: string): CameraChoice {
  const { width, height, rounding, mirror } = camera.layout;
  const { x, y } = recordedPosition(camera.layout, display);
  return { ...(camera.deviceId ? { deviceId: camera.deviceId } : {}), width, height, rounding, x, y, mirror };
}

export { pipeLines } from "../lib/pipe-lines";

export class NativeCaptureHost implements RecorderHost {
  private child: UtilityProcess | undefined;
  private generation = 0;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private watching: string | undefined;
  private missedPongs = 0;
  private abandonReady: ((cause: Error) => void) | undefined;
  /** How each attempt's file ended, by temporary path; taken once by EngineFileWriter. */
  private readonly outcomes = new Map<string, FileOutcome>();
  private readonly finishing = new Map<UtilityProcess, Finishing>();
  private recordingPath: string | undefined;
  /** The display the session records, for the camera's position on it (plan 075). */
  private display: string | undefined;
  private excluding = false;
  /** Counts exclusions: a deferred release lets windows back in only if no exclusion came after its own. */
  private exclusions = 0;
  private readonly messageListeners = new Set<(message: HostMessage) => void>();
  private readonly failureListeners = new Set<(code: FailureCode, detail: string) => void>();
  private readonly pingIntervalMs: number;
  private readonly readyTimeoutMs: number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: NativeCaptureHostOptions) {
    this.pingIntervalMs = options.pingIntervalMs ?? 5000;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 8000;
    this.log = options.log ?? (() => undefined);
  }

  onMessage(listener: (message: HostMessage) => void): void {
    this.messageListeners.add(listener);
  }

  onFailure(listener: (code: FailureCode, detail: string) => void): void {
    this.failureListeners.add(listener);
  }

  /**
   * Settles once the engine has finished `recordingPath`: with its report, or rejecting with the write error (a
   * `FileWriteError`) or why the engine ended without finishing it. Taken once.
   */
  fileOutcome(recordingPath: string): Promise<EngineFileReport> {
    const outcome = this.outcomes.get(recordingPath);
    if (!outcome) return Promise.reject(new Error("the capture host never stopped a recording into this file"));
    return outcome.promise.finally(() => this.outcomes.delete(recordingPath));
  }

  async start(sessionId: string, quality: QualitySettings, recordingPath?: string, capture?: SessionCapture): Promise<void> {
    this.cancelListing();
    this.teardown();
    const generation = this.generation;
    if (!recordingPath) throw new Error("the native engine needs the recording file's path");
    this.recordingPath = recordingPath;
    this.expectFile(recordingPath);
    const now = this.options.now ?? (() => performance.now());
    const began = now();
    let chosenAt = began;
    // Forked first, so the display's request can ask this process about the screen grant once it is ready.
    const created = this.create();
    created.catch(() => undefined);
    let chose = false;
    const choice = this.options.resolveDisplay(sessionId, (displayId) => this.screenAccess(created, generation, displayId, () => chose)).then(
      (display) => { chose = true; chosenAt = now(); return { display }; },
      (cause: unknown) => { chose = true; return { cause }; },
    );
    // Alongside the process's start; a refusal is the engine's to report, as `microphone_unavailable`.
    const microphoneAsked = capture?.microphone?.enabled && this.options.prepareMicrophone
      ? this.options.prepareMicrophone().catch((cause: unknown) => this.log(`capture host: asking for the microphone failed: ${String(cause)}`))
      : undefined;
    try {
      await created;
    } catch (cause) {
      if (generation === this.generation) this.teardown();
      throw cause;
    }
    const readyAt = now();
    if (generation !== this.generation) throw new Error("capture host was invalidated during startup");
    this.watching = sessionId;
    this.missedPongs = 0;
    this.pingTimer ??= setInterval(() => this.ping(), this.pingIntervalMs);
    const chosen = await choice;
    if ("cause" in chosen) throw chosen.cause;
    await microphoneAsked;
    if (generation !== this.generation) throw new Error("capture host was invalidated while macOS asked for the microphone");
    const display = chosen.display;
    this.display = display;
    this.log(`capture host: timing: process ready ${Math.round(readyAt - began)} ms, display chosen ${Math.round(chosenAt - began)} ms`);
    if (generation !== this.generation) throw new Error("capture host was invalidated while the display was chosen");
    if (!display || !/^\d+$/.test(display)) {
      // Main refused a display (the recorder's `mapHostError` names why) or has none to offer.
      this.emit({ type: "error", sessionId, code: "capture_start_failed", detail: "no display was granted for this recording" });
      return;
    }
    const displayPoint = this.options.displayPoint?.(display);
    this.options.beforeCapture?.();
    if (this.options.excludeOwnWindows) {
      this.options.excludeOwnWindows(true);
      this.excluding = true;
      this.exclusions += 1;
    }
    this.post({ type: "start", sessionId, quality, native: {
      displayId: Number(display), ...(displayPoint ? { displayPoint } : {}), recordingPath,
      ownPids: this.options.ownPids(), hideSystemUi: this.options.hideSystemUi(),
      ...(capture?.microphone ? { microphone: capture.microphone } : {}),
      ...(capture?.camera ? { camera: cameraChoice(capture.camera, display) } : {}),
      // The recorder's choice for the session (plan 087), read once when it began, so its controls match its file.
      ...(capture?.editable ? { editable: true } : {}),
    } });
  }

  /**
   * The engine's answer on the screen grant for `displayId` (plan 089, D1), from the attempt's process once `ready`:
   * "unknown" when the process did not start, was replaced, ended or did not answer within the bound. Not asked once
   * the display was `chosen` before the process was ready, the usual case with the grant intact: nobody waits for it.
   */
  private async screenAccess(ready: Promise<void>, generation: number, displayId: string, chosen: () => boolean): Promise<ScreenAccess> {
    if (!/^\d+$/.test(displayId)) return "unknown";
    try { await ready; } catch { return "unknown"; }
    const child = this.child;
    if (!child || generation !== this.generation || chosen()) return "unknown";
    return new Promise<ScreenAccess>((resolve) => {
      const done = (answer: ScreenAccess): void => {
        clearTimeout(bound);
        child.off("message", heard);
        child.off("exit", ended);
        resolve(answer);
      };
      const heard = (data: unknown): void => {
        if (!isHostMessage(data) || data.type !== "screenAccess") return;
        if (data.detail) this.log(`capture host: screen access ${data.answer}: ${data.detail}`);
        done(data.answer);
      };
      const ended = (): void => done("unknown");
      const bound = setTimeout(() => done("unknown"), ACCESS_BOUND_MS);
      child.on("message", heard);
      child.on("exit", ended);
      child.postMessage({ type: "checkScreenAccess", displayId: Number(displayId) } satisfies MainMessage);
    });
  }

  /** The listing in flight, which a session that starts ends at once (`cancelListing`). */
  private listing: ((cause: Error) => void) | undefined;

  /**
   * The audio inputs the engine can open, from a process of their own that is ended once it answers, the bound passes or
   * `cancelListing` is called. `allowed` is asked again once the process is ready, before it lists anything.
   */
  listMicrophones(allowed: () => boolean = () => true): Promise<MicrophoneDevice[]> {
    return this.list("microphones", "the audio inputs", allowed);
  }

  /** The cameras, the same way (plan 075, D9); a listing in flight of either kind is replaced. */
  listCameras(allowed: () => boolean = () => true): Promise<CameraDevice[]> {
    return this.list("cameras", "the cameras", allowed);
  }

  private list(kind: "microphones" | "cameras", what: string, allowed: () => boolean): Promise<MicrophoneDevice[]> {
    // Forked inside the promise: a process that cannot start rejects this listing, never throws into its caller.
    return new Promise<MicrophoneDevice[]>((resolve, reject) => {
      const child = this.spawn(`capture host (${kind})`);
      let settled = false;
      const done = (result: MicrophoneDevice[] | Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(bound);
        if (this.listing === cancel) this.listing = undefined;
        child.kill();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const bound = setTimeout(() => done(new Error(`${what} were not listed within ${LIST_BOUND_MS} ms`)), LIST_BOUND_MS);
      const cancel = (cause: Error): void => done(cause);
      this.listing?.(new Error("a newer listing replaced it"));
      this.listing = cancel;
      child.on("exit", (code) => done(new Error(`the process listing ${what} exited with ${code}`)));
      child.on("message", (data: unknown) => {
        if (!isHostMessage(data)) return;
        if (data.type === "ready") {
          if (allowed()) child.postMessage({ type: kind === "microphones" ? "listMicrophones" : "listCameras" } satisfies MainMessage);
          else done(new Error(`a recording started before ${what} were listed`));
        }
        else if (data.type === kind) done("devices" in data ? data.devices : new Error(data.error));
      });
    });
  }

  /**
   * Settings' monitor process (plan 079), never an attempt's: it follows the device list (`watchDevices`, answered with
   * `microphones` on each change) and reads the input level meter's device (`meter`) until `close`. `onExit` hears it
   * end on its own, or fail to start within the listing's bound.
   */
  openMonitor(onMessage: (message: HostMessage) => void, onExit: (detail: string) => void): MonitorProcess {
    const child = this.spawn("capture host (monitor)");
    let ready = false, closed = false;
    const queued: MainMessage[] = [];
    const end = (detail: string): void => {
      if (closed) return;
      closed = true;
      clearTimeout(bound);
      child.kill();
      onExit(detail);
    };
    const bound = setTimeout(() => { if (!ready) end(`it did not start within ${LIST_BOUND_MS} ms`); }, LIST_BOUND_MS);
    child.on("exit", (code) => end(`it exited with ${code}`));
    child.on("message", (data: unknown) => {
      if (closed || !isHostMessage(data)) return;
      if (data.type === "ready") {
        ready = true;
        clearTimeout(bound);
        for (const message of queued.splice(0)) child.postMessage(message);
        return;
      }
      onMessage(data);
    });
    return {
      post: (message) => {
        if (closed) return;
        if (ready) child.postMessage(message);
        else queued.push(message);
      },
      close: () => {
        if (closed) return;
        closed = true;
        clearTimeout(bound);
        child.kill();
      },
    };
  }

  /** Ends a listing in flight: a session is starting, and no input is listed while one runs (plan 074). */
  cancelListing(): void {
    this.listing?.(new Error("a recording started before the inputs were listed"));
  }

  record(sessionId: string): void {
    if (!this.child || this.watching !== sessionId) throw new Error("capture host is not running this session");
    this.post({ type: "record", sessionId });
  }

  stop(sessionId: string): void {
    if (!this.child) return;
    this.post({ type: "stop", sessionId });
  }

  /** The session's camera from its next frame on (plan 075): the bubble at its position on the recorded display. */
  setCamera(sessionId: string, camera: SessionCamera, hidden: boolean): void {
    if (!this.child || this.watching !== sessionId || !this.display) return;
    this.post({ type: "cameraLayout", sessionId, camera: cameraChoice(camera, this.display), hidden });
  }

  /**
   * Hands the session's process its end of the Recording Studio's port (plan 081), for the preview's frames and the
   * levels: false, the port unused, when this host's process does not run the session.
   */
  joinStudio(sessionId: string, port: Electron.MessagePortMain): boolean {
    if (!this.child || this.watching !== sessionId) return false;
    this.child.postMessage({ type: PREVIEW_PORT_MESSAGE }, [port]);
    return true;
  }

  /** Whether the session's preview is watched (plan 075 step 7); false when this host's process does not run the session. */
  watchPreview(sessionId: string, watching: boolean): boolean {
    if (!this.child || this.watching !== sessionId) return false;
    this.post({ type: "cameraPreview", sessionId, watching });
    return true;
  }

  /** Mutes the session's system audio and microphone, or not (plan 075, D19). */
  setMuted(sessionId: string, system: boolean, microphone: boolean): void {
    if (!this.child || this.watching !== sessionId) return;
    this.post({ type: "mute", sessionId, system, microphone });
  }

  /** The session's inputs' volumes (plan 075, D21), sent to the engine in dB. */
  setGains(sessionId: string, volume: AudioVolume): void {
    if (!this.child || this.watching !== sessionId) return;
    this.post({ type: "gain", sessionId, system: volumeDb(volume.system), microphone: volumeDb(volume.microphone) });
  }

  /** Records another microphone from now on (plan 079, D3); false when this host's process does not run the session. */
  setMicrophone(sessionId: string, deviceId: string | undefined): boolean {
    if (!this.child || this.watching !== sessionId) return false;
    this.post({ type: "microphone", sessionId, ...(deviceId ? { deviceId } : {}) });
    return true;
  }

  /** Whether the session's levels are watched (D19); false when this host's process does not run the session. */
  watchLevels(sessionId: string, watching: boolean): boolean {
    if (!this.child || this.watching !== sessionId) return false;
    this.post({ type: "levels", sessionId, watching });
    return true;
  }

  destroy(): void {
    this.teardown();
  }

  private async create(): Promise<void> {
    const { child, ready } = this.launch();
    this.child = child;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    let abandon: ((cause: Error) => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      abandon = reject;
      this.abandonReady = reject;
      readyTimer = setTimeout(() => reject(new Error("capture host did not report ready before the deadline")), this.readyTimeoutMs);
    });
    deadline.catch(() => undefined);
    try {
      await Promise.race([ready, deadline]);
    } finally {
      if (readyTimer) clearTimeout(readyTimer);
      if (this.abandonReady === abandon) this.abandonReady = undefined;
    }
  }

  /** Forks an engine process whose output lines are logged under `label`. */
  private spawn(label: string): UtilityProcess {
    const fork = this.options.fork ?? ((entry, args) => utilityProcess.fork(entry, args, { serviceName: "RecordStuff Capture", stdio: "pipe" }));
    const child = fork(this.options.entryPath, [this.options.addonPath]);
    for (const stream of [child.stdout, child.stderr]) if (stream) pipeLines(stream, (line) => this.log(`${label}: ${line}`));
    return child;
  }

  /** Forks a process; `ready` settles when it reports ready, whether or not an attempt owns it by then. */
  private launch(): { child: UtilityProcess; ready: Promise<void> } {
    const child = this.spawn("capture host");
    this.options.onLaunch?.(child);
    let resolveReady!: () => void;
    let rejectReady!: (cause: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    child.on("exit", (code) => {
      rejectReady(code === MEDIA_COMPONENTS_MISSING_EXIT
        ? new HostStartError("media_components_missing", "the capture engine could not be loaded: Windows's media components (Media Foundation) are missing")
        : new Error(`capture host exited with ${code} before it reported ready`));
      const finishing = this.finishing.get(child);
      if (finishing) this.fileEnded(child, finishing, new Error(`capture process exited with ${code} before the file was finished`));
      if (this.child !== child) return;
      const lost = this.watching !== undefined;
      // Gone: nothing is left to capture RecordStuff's windows.
      this.child = undefined;
      this.teardown();
      this.log(`capture host: process exited (${code})${lost ? " during a session" : ""}`);
      if (lost) this.emitFailure("capture_host_crashed", `capture process exited with ${code}`);
    });
    child.on("message", (data: unknown) => {
      const finishing = this.finishing.get(child);
      if (finishing && isHostMessage(data) && (data.type === "finished" || data.type === "writeError") && data.sessionId === finishing.sessionId) {
        this.fileEnded(child, finishing, data.type === "finished" ? data.file : new FileWriteError(data.code, finishing.recordingPath, data.detail));
        return;
      }
      if (isHostMessage(data) && data.type === "ready") resolveReady();
      if (this.child !== child) return;
      if (!isHostMessage(data)) {
        this.log(`capture host: dropped malformed message of type ${typeof data === "object" && data ? String((data as { type?: unknown }).type) : typeof data}`);
        return;
      }
      if (data.type === "pong") this.missedPongs = 0;
      // `screenAccess` answers the display's request (above), not the recorder.
      if (data.type === "screenAccess") return;
      // Before the recorder hears it and tears the attempt down: this process now finishes the file.
      if (data.type === "stopped" && data.sessionId === this.watching && this.recordingPath) this.keepFinishing(child, data.sessionId, this.recordingPath);
      this.emit(data);
    });
    return { child, ready };
  }

  private expectFile(recordingPath: string): void {
    let resolve!: (report: EngineFileReport) => void;
    let reject!: (cause: Error) => void;
    const promise = new Promise<EngineFileReport>((done, fail) => { resolve = done; reject = fail; });
    // Read only when the recording is saved; a failed attempt never asks.
    promise.catch(() => undefined);
    const outcome: FileOutcome = {
      promise, settled: false,
      resolve: (report) => { outcome.settled = true; resolve(report); },
      reject: (cause) => { outcome.settled = true; reject(cause); },
    };
    this.outcomes.set(recordingPath, outcome);
  }

  private keepFinishing(child: UtilityProcess, sessionId: string, recordingPath: string): void {
    const bound = setTimeout(() => {
      this.log(`capture host: the file was not finished within ${FINISH_BOUND_MS} ms of the stop; ending the process`);
      const finishing = this.finishing.get(child);
      if (finishing) this.fileEnded(child, finishing, new Error(`the capture process did not finish the file within ${FINISH_BOUND_MS} ms`));
    }, FINISH_BOUND_MS);
    this.finishing.set(child, { sessionId, recordingPath, bound });
  }

  /** The file's outcome is known: the writer hears it, and a process no attempt owns any more is ended. */
  private fileEnded(child: UtilityProcess, finishing: Finishing, result: EngineFileReport | Error): void {
    clearTimeout(finishing.bound);
    this.finishing.delete(child);
    const outcome = this.outcomes.get(finishing.recordingPath);
    if (result instanceof Error) {
      this.log(`capture host: the file was not finished: ${result.message}`);
      outcome?.reject(result);
    } else {
      this.log(`capture host: engine finished ${result.bytes} bytes ${Math.round(result.finalizeMs)} ms after the stop` +
        `${result.fragmented ? `, left fragmented: ${result.fragmented}` : ", plain MP4"}`);
      outcome?.resolve(result);
    }
    if (this.child !== child) child.kill();
  }

  private emit(message: HostMessage): void {
    if ((message.type === "stopped" || message.type === "error" || message.type === "writeError") && message.sessionId === this.watching) {
      this.stopHeartbeat();
    }
    for (const listener of this.messageListeners) listener(message);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    this.watching = undefined;
    this.missedPongs = 0;
  }

  private ping(): void {
    if (this.missedPongs >= 2) {
      this.log("capture host: two pings unanswered");
      this.teardown();
      this.emitFailure("capture_host_unresponsive", "two consecutive pings received no response");
      return;
    }
    this.missedPongs += 1;
    this.post({ type: "ping" });
  }

  private post(message: MainMessage): void {
    this.child?.postMessage(message);
  }

  private emitFailure(code: FailureCode, detail: string): void {
    for (const listener of this.failureListeners) listener(code, detail);
  }

  private teardown(): void {
    this.generation += 1;
    this.abandonReady?.(new Error("capture host was torn down before it reported ready"));
    this.abandonReady = undefined;
    this.stopHeartbeat();
    const child = this.child;
    this.child = undefined;
    // A process finishing the file has stopped capturing: it is ended once the file's outcome is known.
    const finishing = child !== undefined && this.finishing.has(child);
    const outcome = this.recordingPath === undefined ? undefined : this.outcomes.get(this.recordingPath);
    if (!finishing && outcome && !outcome.settled) {
      outcome.reject(new Error("the capture host ended before the recording stopped"));
      this.outcomes.delete(this.recordingPath!);
    }
    this.recordingPath = undefined;
    if (this.excluding) this.releaseWindows(finishing ? undefined : child);
    if (!finishing) child?.kill();
  }

  /**
   * Lets RecordStuff's windows back into capture once `child` can no longer capture them: at once when it has already
   * exited, otherwise when it does, or after a bound if it never says so. An attempt that excluded them after this one
   * owns them from then on, so this release is dropped even after that attempt has ended.
   */
  private releaseWindows(child: UtilityProcess | undefined): void {
    this.excluding = false;
    const own = this.exclusions;
    const release = (): void => {
      clearTimeout(bound);
      // A later attempt excluded them again: its own teardown lets them back in, whether or not it still runs.
      if (own !== this.exclusions) return;
      this.options.excludeOwnWindows?.(false);
    };
    if (!child) {
      this.options.excludeOwnWindows?.(false);
      return;
    }
    const bound = setTimeout(release, RELEASE_BOUND_MS);
    child.once("exit", release);
  }
}
