/**
 * The native engine's capture host (plan 076): the entry of the
 * Electron `utilityProcess` main forks for each attempt (native-capture-host.ts). It loads the Rust engine
 * (native/capture), whose path is its first argument, and speaks the capture protocol (shared/protocol.ts) over the parent
 * port: `start` prepares capture into the file main created and answers `prepared`, `record` answers `started`, `stop`
 * answers `stopped` once capture has ended and then `finished` once the file is (or `writeError`), so a slow volume's
 * save is no part of the stop. The engine writes the file; the host reports `progress` (bytes written
 * while media arrives) and `writeError`. A crash in native code ends this process only;
 * main sees it exit, fails the session and keeps what was written, which is a readable fragmented MP4.
 */
import { MEDIA_COMPONENTS_MISSING_EXIT, OUTPUT_MIME_TYPE, isMainMessage, type CameraChoice, type HostErrorCode, type HostMessage, type MainMessage, type MicrophoneDevice, type NativeStart } from "../../shared/protocol";
import { cameraPreviewOn, PREVIEW_PORT_MESSAGE } from "../../shared/camera-preview";
import { isStudioDrawn, isStudioPreviewDiagnostics, isStudioRate, isStudioViewMessage, STUDIO_DIAGNOSTICS_MS, STUDIO_STALL_ENV, studioStallOf, type StudioDiagnosticsRequest, type StudioStallRequest } from "../../shared/studio-port";
import { DIAGNOSTICS_ENV, PIPELINE_SCHEMA } from "../../shared/pipeline-histogram";
import { PreviewDelivery } from "./preview-delivery";
import { AUDIO_BITS_PER_SECOND, fitWithinCap, videoBitsPerSecond, type CaptureReport, type QualitySettings } from "../../shared/quality";

interface ProbeResult { width: number; height: number }
interface PreparedInfo {
  width: number; height: number; sampleRate: number; channelCount: number; primingFrames: number;
  excludedApps: number; hiddenWindows: number; warnings: string[];
  /** Where the engine's prepare spent its time. */
  timings?: string;
  /** The microphone the engine opened, by name (plan 074); absent (or null from napi) without one. */
  microphone?: string | null;
}
interface StopReport {
  drainMs?: number; drainPaddedFrames?: number; frameLeadAvgMs?: number; frameLeadMaxMs?: number; lateAudioFrames?: number[];
  /** Plan 074: frames inserted and dropped per audio input to keep it on the clock, and samples the limiter changed. */
  insertedAudioFrames?: number[]; droppedAudioFrames?: number[]; limitedAudioSamples?: number;
  /** What capture delivered while recording (plan 076 step 7): pictures, deliveries without one, the longest gap between pictures. */
  capturedPictures?: number; capturedWithoutPicture?: number; capturedLongestGapMs?: number;
}
interface FinishReport { bytes: number; fragmented?: string | null; finalizeMs: number }
interface EngineEvent {
  kind: "progress" | "writeError" | "captureError" | "microphoneLost" | "microphoneResumed" | "cameraLost" | "cameraReady" | "cameraNotReady" | "cameraResumed" | "levels"
    | "microphoneSwitched" | "microphoneSwitchFailed" | "meter" | "meterLost" | "devices";
  bytes?: number; code?: string; detail?: string;
  /** With `levels` (plan 075, D19). */
  system?: number | null; microphone?: number | null;
  /** With `meter` (plan 079, D1): linear peak and RMS over 50 ms. */
  peak?: number | null; rms?: number | null;
  /** With `microphoneSwitched` (plan 079, D3): the devices' names. */
  from?: string | null; to?: string | null;
}
/**
 * A preview chunk of the composed picture (plan 075's prototype, D17's second option): H.264 in AVCC form for WebCodecs,
 * the `avcC` record (`description`) with every key frame; `timestamp` is host time in microseconds.
 */
export interface PreviewFrame { width: number; height: number; data: Uint8Array; key: boolean; timestamp: number; description?: Uint8Array | null }
/** What the picture shows (plan 076 step 4: the engine's; the pickers are a later plan). */
export interface CaptureSource {
  kind: "display" | "window" | "area" | "apps";
  windowId?: number;
  area?: { x: number; y: number; width: number; height: number };
  pids?: number[];
}
/** The camera composed into the frames (plan 075): the engine's `CameraOptions`. */
export interface CameraOptions { deviceId?: string; width: number; height: number; rounding: number; x: number; y: number; mirror: boolean; preview?: boolean }
/** Whose sound the track holds: the system's (or chosen apps'), and the microphone mixed in (plan 074). */
export interface AudioOptions { system: "all" | "apps" | "off"; pids?: number[]; microphone: boolean; microphoneId?: string }
interface NativeCapture {
  probe(displayId: number, displayPoint?: { x: number; y: number }, source?: CaptureSource): Promise<ProbeResult>;
  prepare(options: {
    displayId: number; displayPoint?: { x: number; y: number }; width: number; height: number; frameRate: number;
    videoBitrate: number; audioBitrate: number; ownPids: number[]; hideSystemUi: boolean; path: string;
    source?: CaptureSource; audio?: AudioOptions; camera?: CameraOptions; editable?: boolean;
  }): Promise<PreparedInfo>;
  record(): void;
  stop(): Promise<StopReport>;
  finish(): Promise<FinishReport>;
  cancel(): Promise<void>;
  microphones(): Promise<MicrophoneDevice[]>;
  /** Plan 075: the cameras. */
  cameras?(): Promise<MicrophoneDevice[]>;
  /** Plan 075: the camera's bubble and whether it is shown, from the next frame on; false without a camera. */
  setCameraLayout?(options: CameraOptions, hidden: boolean): boolean;
  /** Plan 075: preview chunks while a session composes the camera and its preview is watched. */
  onPreview?(onFrame: (frame: PreviewFrame) => void): void;
  /** Plan 075 step 7: whether the session's preview is watched; false without a camera. */
  setCameraPreview?(watching: boolean): boolean;
  /** Plan 081, D1: the preview's frames a second; false without a preview. */
  setPreviewRate?(fps: number): boolean;
  /** What the preview shows (plan 092, D3; plan 094): `composed`, `screen` or `camera`. */
  setPreviewView?(view: string): boolean;
  /** Plan 084: a key frame at the preview's next frame time; false without a preview or while it is not watched. */
  requestPreviewKey?(): boolean;
  /** Plan 075, D19: whether the inputs' levels are told, and which inputs are muted. */
  watchLevels?(watching: boolean): boolean;
  setMuted?(system: boolean, microphone: boolean): boolean;
  /** Plan 075, D21: the inputs' volumes in dB. */
  setGains?(system: number, microphone: number): boolean;
  /** Plan 079, D3: records another microphone from now on; false when the session records none. */
  setMicrophone?(deviceId?: string): boolean;
  /** Plan 079, D2: `devices` events while the device list is followed. */
  watchDevices?(watching: boolean): void;
  /** Plan 079, D1: Settings' input level meter, `meter` events until stopped; resolves with the device's name. */
  startMeter?(deviceId?: string): Promise<string>;
  stopMeter?(): void;
  /** Plan 083: the last session's stage figures as JSON once it has ended; null unless it kept them. */
  diagnostics?(): string | null;
}
interface EngineModule { NativeCapture: new (onEvent: (event: EngineEvent) => void) => NativeCapture }

/**
 * The Recording Studio's port (studio-port.ts): a `MessagePortMain` main hands over to Settings or the prototype's
 * page (plan 075); preview chunks and levels go out on it, the page's rate, view and what it drew come back.
 */
export interface PreviewPort {
  postMessage(message: unknown): void;
  close(): void;
  on?(event: "message", listener: (message: { data: unknown }) => void): void;
  /** Electron's `MessagePortMain` says when the page's end closed: the page is gone. */
  on?(event: "close", listener: () => void): void;
  start?(): void;
}

/** The subset of Electron's `process.parentPort` the host uses; lets tests pass a fake. */
export interface ParentPort {
  on(event: "message", listener: (message: { data: unknown; ports?: PreviewPort[] }) => void): void;
  postMessage(message: unknown): void;
}

export { cameraPreviewOn, cameraPrototypeOn, PREVIEW_PORT_MESSAGE } from "../../shared/camera-preview";

const HOST_CODES: readonly string[] = ["permission_denied", "no_display", "no_audio_track", "microphone_unavailable", "camera_unavailable", "media_components_missing", "capture_start_failed", "capture_failed"];
const WRITE_CODES: readonly string[] = ["disk_full", "output_write_failed"];

const NUMBER_LIST = /^\d+(,\d+)*$/;
const numbers = (text: string): number[] => text.split(",").map(Number);

/** What the development switches choose; absent fields record as today. */
export interface DevelopmentCapture { source?: CaptureSource; audio?: AudioOptions; editable?: true }

/**
 * Step 4's development switches, until a later plan's pickers choose: `RECORDSTUFF_CAPTURE_SOURCE` is `window:<id>`,
 * `area:<x>,<y>,<width>,<height>` (the display's pixels) or `apps:<pid>,…`, and `RECORDSTUFF_CAPTURE_AUDIO` is `off`
 * or `apps:<pid>,…`. `RECORDSTUFF_CAPTURE_EDITABLE=1` is plan 087's editable recording prototype (macOS): the screen
 * without the camera, each sound input and the camera on tracks of their own. Anything else, or nothing, records as
 * today. The microphone is the user's setting (plan 074), which `start` carries and these switches keep.
 */
export function developmentCapture(env: Record<string, string | undefined>): DevelopmentCapture {
  const result: DevelopmentCapture = {};
  const [kind, value = ""] = (env["RECORDSTUFF_CAPTURE_SOURCE"] ?? "").split(":", 2);
  if (kind === "window" && /^\d+$/.test(value)) result.source = { kind: "window", windowId: Number(value) };
  if (kind === "area" && NUMBER_LIST.test(value) && numbers(value).length === 4) {
    const [x, y, width, height] = numbers(value) as [number, number, number, number];
    result.source = { kind: "area", area: { x, y, width, height } };
  }
  if (kind === "apps" && NUMBER_LIST.test(value)) result.source = { kind: "apps", pids: numbers(value) };
  const [audio, pids = ""] = (env["RECORDSTUFF_CAPTURE_AUDIO"] ?? "").split(":", 2);
  if (audio === "off") result.audio = { system: "off", microphone: false };
  if (audio === "apps" && NUMBER_LIST.test(pids)) result.audio = { system: "apps", pids: numbers(pids), microphone: false };
  if (env["RECORDSTUFF_CAPTURE_EDITABLE"] === "1") result.editable = true;
  return result;
}

/**
 * The exit code for an engine that could not be loaded: on Windows, a library the module links that is missing
 * (ERROR_MOD_NOT_FOUND, whose text Node passes on) is a Windows without its media components, since the module links
 * nothing else outside Windows itself (plan 078); anything else is 3.
 */
export function engineLoadExit(platform: NodeJS.Platform, message: string): number {
  return platform === "win32" && /specified module could not be found/i.test(message) ? MEDIA_COMPONENTS_MISSING_EXIT : 3;
}

/** The engine rejects with `code|detail`. */
export function engineFailure(cause: unknown): { code: string; detail: string } {
  const message = cause instanceof Error ? cause.message : String(cause);
  const split = message.indexOf("|");
  return split > 0 ? { code: message.slice(0, split), detail: message.slice(split + 1) } : { code: "capture_start_failed", detail: message };
}

type Phase = "preparing" | "prepared" | "recording" | "stopping";

/** How long the device list settles before it is listed again (plan 079, D2): one change is told several times. */
const DEVICES_SETTLE_MS = 300;
/** How often a running session's figures are logged under the diagnostics switch (plan 083). */
const DIAGNOSTICS_SNAPSHOT_MS = 5000;

export class NativeHost {
  private session: { id: string; phase: Phase; recordingPath: string; cancelled: boolean } | undefined;
  /** The screen access check in flight (plan 089, D1), which a start's own probe waits for. */
  private accessCheck: Promise<void> | undefined;
  private previewPort: PreviewPort | undefined;
  private previewFrames = 0;
  /** What the page has not yet said it is done with, and the bound on it (plan 084). */
  private readonly delivery = new PreviewDelivery(() => this.capture.requestPreviewKey?.() ?? false);
  /** The bytes of the preview chunks forwarded, and their count at the session's start (plan 084). */
  private previewBytes = 0;
  private previewBytesBefore = 0;
  /** Plan 084's development switch: the page's stall due on the port that holds it now. */
  private stallTimer: ReturnType<typeof setTimeout> | undefined;
  /** Preview chunks the engine gave while no page held a port, and `previewFrames` at the last figures (plan 083). */
  private previewWithoutPort = 0;
  private previewFramesBefore = 0;
  /** The latest session's id: the page's last figures come once its port is let go, after the session ended. */
  private lastSessionId: string | undefined;
  /** The running session's figures logged every `DIAGNOSTICS_SNAPSHOT_MS`: main ends a Live preview by ending this process. */
  private snapshots: ReturnType<typeof setInterval> | undefined;
  /** Settings' meter (plan 079, D1): the latest request, and the requests applied one after another. */
  private meterWanted: { deviceId?: string } | undefined;
  private meterRunning = false;
  private meterQueue: Promise<void> = Promise.resolve();
  private devicesTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly port: ParentPort,
    private readonly engine: NativeCapture | ((onEvent: (event: EngineEvent) => void) => NativeCapture),
    /** A line for main's log: the host's stdout reaches it as `capture host: …`. */
    private readonly log: (line: string) => void = (line) => console.log(line),
    private readonly now: () => number = () => performance.now(),
    private readonly development: DevelopmentCapture = {},
    /** The prototype's switch: the preview is watched from the start, for its page. */
    private readonly cameraPreview = false,
    /** Plan 083's development switch, `RECORDSTUFF_DIAGNOSTICS=1`: each session's figures are logged once it ends. */
    private readonly diagnostics = false,
    /** Plan 084's development switch (`RECORDSTUFF_STUDIO_STALL`): each port's page is asked to stall once. */
    private readonly stall?: { atMs: number; forMs: number },
  ) {
    if (typeof engine === "function") this.engine = engine((event) => this.event(event));
    // Frames come only while main says the preview is watched, or from the start under the prototype's switch.
    this.capture.onPreview?.((frame) => this.preview(frame));
    port.on("message", ({ data, ports }) => {
      if (typeof data === "object" && data !== null && (data as { type?: unknown }).type === PREVIEW_PORT_MESSAGE) {
        this.previewPort?.close();
        const studio = ports?.[0];
        this.previewPort = studio;
        this.delivery.joined();
        // The page went (its window closed or it let the port go): nothing more is posted to it.
        studio?.on?.("close", () => {
          if (studio !== this.previewPort) return;
          this.previewPort = undefined;
          this.delivery.joined();
        });
        // The page's rate and view for the preview (plan 092, D1, D3); the page says both on each port it is given.
        studio?.on?.("message", ({ data }) => {
          if (studio !== this.previewPort) return;
          if (isStudioDrawn(data)) {
            this.delivery.acknowledged(data.through, data.key === true);
            return;
          }
          if (isStudioPreviewDiagnostics(data)) {
            // Logged as it comes, whichever session it covers: the page's port outlives none of them.
            const { type: _type, ...figures } = data;
            if (this.diagnostics) this.log(`diagnostics: ${JSON.stringify({ kind: "page", session: this.session?.id ?? this.lastSessionId ?? null, ...figures })}`);
            return;
          }
          if (isStudioViewMessage(data)) {
            this.log(`studio: preview view ${data.view}${this.capture.setPreviewView?.(data.view) ? "" : " (no preview in this session)"}`);
            return;
          }
          if (!isStudioRate(data)) return;
          this.delivery.rate(data.fps);
          this.log(`studio: preview at ${data.fps} a second${this.capture.setPreviewRate?.(data.fps) ? "" : " (no preview in this session)"}`);
        });
        studio?.start?.();
        if (this.diagnostics) studio?.postMessage({ type: "diagnostics", everyMs: STUDIO_DIAGNOSTICS_MS } satisfies StudioDiagnosticsRequest);
        this.stallLater(studio);
        return;
      }
      this.handle(data);
    });
    this.send({ type: "ready" });
  }

  /** Asks the page on `studio` to stall once, `stall.atMs` from now, if the development switch says so (plan 084). */
  private stallLater(studio: PreviewPort | undefined): void {
    if (this.stallTimer !== undefined) clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
    const stall = this.stall;
    if (!stall || !studio) return;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = undefined;
      if (studio !== this.previewPort) return;
      this.log(`studio: the page asked to stall for ${stall.forMs} ms (development switch); ${this.previewFrames} preview chunks forwarded so far`);
      studio.postMessage({ type: "stall", ms: stall.forMs } satisfies StudioStallRequest);
    }, stall.atMs);
  }

  /** Forwards a preview chunk to the preview page, when main gave one; dropped otherwise. */
  private preview(frame: PreviewFrame): void {
    if (!this.previewPort) {
      this.previewWithoutPort += 1;
      return;
    }
    const bytes = frame.data.byteLength + (frame.description?.byteLength ?? 0);
    // Beyond what the page has drawn by a few chunks, none is posted (plan 084): numbered only once posted.
    if (!this.delivery.admit(this.previewFrames + 1, bytes, frame.key)) return;
    this.previewFrames += 1;
    this.previewBytes += bytes;
    this.previewPort.postMessage({
      width: frame.width, height: frame.height, data: frame.data, key: frame.key, timestamp: frame.timestamp,
      ...(frame.description ? { description: frame.description } : {}), sent: Date.now(), n: this.previewFrames,
    });
  }

  private get capture(): NativeCapture {
    return this.engine as NativeCapture;
  }

  private handle(data: unknown): void {
    if (!isMainMessage(data)) return;
    const message: MainMessage = data;
    switch (message.type) {
      case "ping":
        this.send({ type: "pong" });
        return;
      case "start":
        if (!message.native) {
          this.fail(message.sessionId, "capture_start_failed", "the native host needs the native start options");
          return;
        }
        void this.start(message.sessionId, message.quality, message.native);
        return;
      case "record":
        this.record(message.sessionId);
        return;
      case "stop":
        void this.stop(message.sessionId);
        return;
      case "checkScreenAccess":
        void this.checkScreenAccess(message.displayId);
        return;
      case "listMicrophones":
        void this.listMicrophones();
        return;
      case "listCameras":
        void this.listCameras();
        return;
      case "cameraLayout":
        this.cameraLayout(message.sessionId, message.camera, message.hidden);
        return;
      case "levels":
        if (this.session?.id !== message.sessionId) return;
        this.capture.watchLevels?.(message.watching);
        return;
      case "mute":
        if (this.session?.id !== message.sessionId) return;
        this.log(`audio: system ${message.system ? "muted" : "on"}, microphone ${message.microphone ? "muted" : "on"}${this.capture.setMuted?.(message.system, message.microphone) ? "" : " (no session)"}`);
        return;
      case "gain":
        if (this.session?.id !== message.sessionId) return;
        this.log(`audio: system ${message.system.toFixed(1)} dB, microphone ${message.microphone.toFixed(1)} dB${this.capture.setGains?.(message.system, message.microphone) ? "" : " (no session)"}`);
        return;
      case "cameraPreview":
        if (this.session?.id !== message.sessionId) return;
        this.log(`camera preview: ${message.watching ? "watched" : "not watched"}${this.capture.setCameraPreview?.(message.watching) ? "" : " (no camera in this session)"}`);
        return;
      case "microphone":
        this.switchMicrophone(message.sessionId, message.deviceId);
        return;
      case "watchDevices":
        this.watchDevices(message.watching);
        return;
      case "meter":
        this.meter(message.watching ? { ...(message.deviceId ? { deviceId: message.deviceId } : {}) } : undefined);
        return;
    }
  }

  /** The user switched the recording's microphone (plan 079, D3): the engine tells the outcome. */
  private switchMicrophone(sessionId: string, deviceId: string | undefined): void {
    const session = this.session;
    if (session?.id !== sessionId || session.phase === "preparing" || session.phase === "stopping") return;
    this.log(`microphone: switching to ${deviceId ?? "the system default input"}`);
    if (!this.capture.setMicrophone?.(deviceId)) this.send({ type: "microphoneSwitchFailed", sessionId, detail: "this recording records no microphone" });
  }

  /** Follows the device list while Settings is open (plan 079, D2); each change is answered with `microphones`. */
  private watchDevices(watching: boolean): void {
    if (this.session) return;
    try {
      this.capture.watchDevices?.(watching);
      this.log(`devices: ${watching ? "followed" : "no longer followed"}`);
    } catch (cause) {
      this.log(`devices: the device list cannot be followed: ${engineFailure(cause).detail}`);
    }
    if (!watching) {
      clearTimeout(this.devicesTimer);
      this.devicesTimer = undefined;
      return;
    }
    // What is connected now, which may have changed while nothing followed it, and which Settings cannot otherwise
    // list again during a recording (review of plan 079).
    this.devicesChanged();
  }

  /** Settings' meter (plan 079, D1), started, started again on another device or stopped, one request at a time. */
  private meter(wanted: { deviceId?: string } | undefined): void {
    if (this.session) return;
    this.meterWanted = wanted;
    this.meterQueue = this.meterQueue.then(() => this.applyMeter(wanted));
  }

  private async applyMeter(wanted: { deviceId?: string } | undefined): Promise<void> {
    // A later request is queued behind this one and settles it.
    if (this.meterWanted !== wanted) return;
    if (!wanted) {
      if (this.meterRunning) {
        this.capture.stopMeter?.();
        this.meterRunning = false;
        this.log("meter: stopped");
      }
      return;
    }
    try {
      const device = await (this.capture.startMeter?.(wanted.deviceId) ?? Promise.reject(new Error("microphone_unavailable|this engine has no meter")));
      this.meterRunning = true;
      // Stopped or replaced while it opened: the request queued behind settles it.
      if (this.meterWanted !== wanted) return;
      this.log(`meter: reading ${device}`);
      this.send({ type: "meterStarted", device });
    } catch (cause) {
      const { detail } = engineFailure(cause);
      this.log(`meter: not started: ${detail}`);
      if (this.meterWanted === wanted) this.send({ type: "meterStopped", error: detail });
    }
  }

  /**
   * Lists the inputs once the device list settles: one connection is told several times, and the HAL lists a Bluetooth
   * microphone a moment after its device.
   */
  private devicesChanged(): void {
    clearTimeout(this.devicesTimer);
    this.devicesTimer = setTimeout(() => {
      this.devicesTimer = undefined;
      this.log("devices: listing the inputs");
      void this.listMicrophones();
    }, DEVICES_SETTLE_MS);
  }

  /** Engine events of Settings' monitor process (plan 079), which runs no session. */
  private monitorEvent(event: EngineEvent): boolean {
    switch (event.kind) {
      case "meter":
        if (this.meterRunning && typeof event.peak === "number" && typeof event.rms === "number") this.send({ type: "meterLevel", peak: event.peak, rms: event.rms });
        return true;
      case "meterLost":
        this.meterRunning = false;
        this.log(`meter: ${event.detail ?? "stopped"}`);
        this.send({ type: "meterStopped", error: event.detail ?? "the device stopped" });
        return true;
      case "devices":
        this.devicesChanged();
        return true;
      default:
        return false;
    }
  }

  /** A new bubble or hiding for the session's camera (plan 075), logged with the session. */
  private cameraLayout(sessionId: string, camera: CameraChoice, hidden: boolean): void {
    if (this.session?.id !== sessionId) return;
    const { deviceId: _device, ...layout } = camera;
    const applied = this.capture.setCameraLayout?.(layout, hidden) ?? false;
    this.log(`camera layout: ${JSON.stringify(layout)}, ${hidden ? "hidden" : "shown"}${applied ? "" : " (no camera in this session)"}`);
  }

  /** The cameras, for the Settings device menu (plan 075). Never while a session holds the engine. */
  private async listCameras(): Promise<void> {
    if (this.session) {
      this.send({ type: "cameras", error: "a recording is in progress" });
      return;
    }
    try {
      const devices = (await this.capture.cameras?.()) ?? [];
      this.send({ type: "cameras", devices: devices.map(({ id, name, default: isDefault }) => ({ id, name, default: isDefault })) });
    } catch (cause) {
      this.send({ type: "cameras", error: engineFailure(cause).detail });
    }
  }

  /**
   * Whether macOS lets the engine capture the display (plan 089, D1), by the probe a start makes: ScreenCaptureKit
   * refuses a revoked grant as `permission_denied` even while Electron's enumeration waits on it.
   */
  private checkScreenAccess(displayId: number): Promise<void> {
    if (this.session) {
      this.send({ type: "screenAccess", answer: "unknown", detail: "a recording is in progress" });
      return Promise.resolve();
    }
    const check = this.askScreenAccess(displayId).finally(() => { if (this.accessCheck === check) this.accessCheck = undefined; });
    this.accessCheck = check;
    return check;
  }
  private async askScreenAccess(displayId: number): Promise<void> {
    try {
      await this.capture.probe(displayId);
      this.send({ type: "screenAccess", answer: "granted" });
    } catch (cause) {
      const { code, detail } = engineFailure(cause);
      this.send({ type: "screenAccess", answer: code === "permission_denied" ? "denied" : "unknown", detail });
    }
  }

  /** The audio inputs, for the Settings device menu (plan 074). Never while a session holds the engine. */
  private async listMicrophones(): Promise<void> {
    if (this.session) {
      this.send({ type: "microphones", error: "a recording is in progress" });
      return;
    }
    try {
      const devices = await this.capture.microphones();
      this.send({ type: "microphones", devices: devices.map(({ id, name, default: isDefault, lidClosed }) => ({ id, name, default: isDefault, ...(lidClosed ? { lidClosed } : {}) })) });
    } catch (cause) {
      this.send({ type: "microphones", error: engineFailure(cause).detail });
    }
  }

  /** The track's sound: the development switches' choice, with the user's microphone added; absent is 076's default. */
  private audio(native: NativeStart): AudioOptions | undefined {
    const chosen = native.microphone?.enabled
      ? { microphone: true, ...(native.microphone.deviceId ? { microphoneId: native.microphone.deviceId } : {}) }
      : undefined;
    const development = this.development.audio;
    if (development) return chosen ? { ...development, ...chosen } : development;
    return chosen ? { system: "all", ...chosen } : undefined;
  }

  private async start(sessionId: string, quality: QualitySettings, native: NativeStart): Promise<void> {
    if (this.session) {
      this.fail(sessionId, "capture_start_failed", "a recording is already in progress");
      return;
    }
    const session = { id: sessionId, phase: "preparing" as Phase, recordingPath: native.recordingPath, cancelled: false };
    this.session = session;
    this.lastSessionId = sessionId;
    // Counted per session, as the engine's figures are.
    this.previewFramesBefore = this.previewFrames;
    this.previewBytesBefore = this.previewBytes;
    this.delivery.restart();
    this.previewWithoutPort = 0;
    this.stopSnapshots();
    let capture: CaptureReport;
    try {
      // Both probes keep their content for `prepare`: the access check's, taken before main made sure RecordStuff
      // owns a window, must not be the one `prepare` uses (plan 089).
      await this.accessCheck;
      const began = this.now();
      // napi-rs reads an absent optional object as None and refuses null, so the point is left out on macOS.
      const chosen = this.development.source;
      const audio = this.audio(native);
      if (chosen || this.development.audio) this.log(`development capture: source ${JSON.stringify(chosen ?? "display")}, audio ${JSON.stringify(audio ?? "all")}`);
      if (this.development.editable) this.log("development capture: editable recording (plan 087 prototype): the screen, each sound and the camera on tracks of their own");
      const source = chosen
        ? await this.capture.probe(native.displayId, native.displayPoint, chosen)
        : await this.capture.probe(native.displayId, native.displayPoint);
      const probed = this.now();
      const size = fitWithinCap(source, quality.resolutionCap);
      const videoBps = videoBitsPerSecond(size, quality.frameRate, quality.videoQuality);
      const prepared = await this.capture.prepare({
        displayId: native.displayId, ...(native.displayPoint ? { displayPoint: native.displayPoint } : {}), width: size.width, height: size.height, frameRate: quality.frameRate,
        videoBitrate: videoBps, audioBitrate: AUDIO_BITS_PER_SECOND,
        ownPids: native.ownPids, hideSystemUi: native.hideSystemUi, path: native.recordingPath,
        ...(chosen ? { source: chosen } : {}), ...(audio ? { audio } : {}),
        ...(native.camera ? { camera: { ...native.camera, preview: this.cameraPreview } } : {}),
        ...(this.development.editable ? { editable: true } : {}),
      });
      this.log(`timing: probe ${Math.round(probed - began)} ms, prepare ${Math.round(this.now() - probed)} ms` +
        `${prepared.timings ? ` (${prepared.timings})` : ""}`);
      capture = {
        width: prepared.width, height: prepared.height, frameRate: quality.frameRate,
        sampleRate: prepared.sampleRate, channelCount: prepared.channelCount,
        videoBitsPerSecond: videoBps, audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
        ...(prepared.microphone ? { microphone: prepared.microphone } : {}),
        warnings: [
          ...prepared.warnings,
          `native engine: source ${source.width}x${source.height}, AAC priming ${prepared.primingFrames} frames, ` +
            `${prepared.excludedApps} own app(s) excluded, ${prepared.hiddenWindows} system window(s) hidden`,
        ],
      };
    } catch (cause) {
      this.session = undefined;
      if (session.cancelled) this.send({ type: "stopped", sessionId, tracksStoppedAt: Date.now() });
      else {
        const { code, detail } = engineFailure(cause);
        this.fail(sessionId, HOST_CODES.includes(code) ? code as HostErrorCode : "capture_start_failed", detail);
      }
      return;
    }
    // Main gave up while the engine prepared: never keep capturing with nobody listening.
    if (session.cancelled) {
      await this.capture.cancel().catch(() => undefined);
      this.logDiagnostics(sessionId, "cancelled");
      this.session = undefined;
      this.send({ type: "stopped", sessionId, tracksStoppedAt: Date.now() });
      return;
    }
    session.phase = "prepared";
    if (this.diagnostics) this.snapshots = setInterval(() => this.logDiagnostics(sessionId, "running"), DIAGNOSTICS_SNAPSHOT_MS);
    this.send({ type: "prepared", sessionId, mimeType: OUTPUT_MIME_TYPE, capture });
  }

  private record(sessionId: string): void {
    const session = this.session;
    if (session?.id === sessionId && session.phase === "recording") return;
    if (!session || session.id !== sessionId || session.phase !== "prepared") {
      this.fail(sessionId, "capture_start_failed", "record refused: this session is not prepared");
      return;
    }
    try {
      const began = this.now();
      this.capture.record();
      this.log(`timing: record ${(this.now() - began).toFixed(1)} ms`);
    } catch (cause) {
      const { detail } = engineFailure(cause);
      this.fail(sessionId, "capture_start_failed", detail);
      return;
    }
    session.phase = "recording";
    this.send({ type: "started", sessionId });
  }

  private async stop(sessionId: string): Promise<void> {
    const session = this.session;
    if (!session || session.id !== sessionId) return;
    if (session.phase === "preparing") {
      session.cancelled = true;
      return;
    }
    if (session.phase === "stopping") return;
    const wasRecording = session.phase === "recording";
    session.phase = "stopping";
    if (!wasRecording) {
      await this.capture.cancel().catch(() => undefined);
      this.logDiagnostics(sessionId, "cancelled");
      this.session = undefined;
      this.send({ type: "stopped", sessionId, tracksStoppedAt: Date.now() });
      return;
    }
    let stopped: StopReport;
    const began = this.now();
    try {
      stopped = await this.capture.stop();
    } catch (cause) {
      this.session = undefined;
      this.fail(sessionId, "capture_failed", engineFailure(cause).detail);
      return;
    }
    this.log(`timing: stop ${Math.round(this.now() - began)} ms (sound up to the stop ${Math.round(stopped.drainMs ?? 0)} ms, ` +
      `${stopped.drainPaddedFrames ?? 0} frame(s) filled with silence; ` +
      `frames stamped ${(stopped.frameLeadAvgMs ?? 0).toFixed(1)} ms ahead on average, ${(stopped.frameLeadMaxMs ?? 0).toFixed(1)} ms at most` +
      `${stopped.lateAudioFrames?.some((frames) => frames > 0) ? `; audio frames too late to mix, by input: ${stopped.lateAudioFrames.join(", ")}` : ""}` +
      `${[...(stopped.insertedAudioFrames ?? []), ...(stopped.droppedAudioFrames ?? [])].some((frames) => frames > 0)
        ? `; audio kept on the clock, by input: ${(stopped.insertedAudioFrames ?? []).join(", ")} frame(s) of silence inserted, ${(stopped.droppedAudioFrames ?? []).join(", ")} dropped`
        : ""}` +
      `${(stopped.limitedAudioSamples ?? 0) > 0 ? `; ${stopped.limitedAudioSamples} sample(s) of two inputs limited below full scale` : ""}` +
      `${stopped.capturedPictures === undefined ? "" : `; capture delivered ${stopped.capturedPictures} pictures and ${stopped.capturedWithoutPicture ?? 0} frames without one, ${(stopped.capturedLongestGapMs ?? 0).toFixed(1)} ms apart at most`})`);
    // Engine events after this are the file's, which `finish` answers for.
    this.session = undefined;
    this.send({ type: "stopped", sessionId, tracksStoppedAt: Date.now() });
    try {
      const file = await this.capture.finish();
      this.log(`timing: file finished ${Math.round(file.finalizeMs)} ms after the stop`);
      this.logDiagnostics(sessionId, "finished");
      this.send({ type: "finished", sessionId,
        file: { bytes: file.bytes, finalizeMs: file.finalizeMs, ...(file.fragmented ? { fragmented: file.fragmented } : {}) } });
    } catch (cause) {
      const { code, detail } = engineFailure(cause);
      this.logDiagnostics(sessionId, "writeError");
      this.send({ type: "writeError", sessionId, code: WRITE_CODES.includes(code) ? code as "disk_full" | "output_write_failed" : "output_write_failed", detail });
    }
  }

  /**
   * Logs the session's figures so far (plan 083) as one `diagnostics: {"kind":"engine",…}` line: the engine's stages and
   * queues, and the preview chunks this process forwarded to the page or had no port for. Every figure counts from the
   * session's start, so the last line of a session is its whole: `running` while it runs, its outcome once it ended.
   */
  private logDiagnostics(sessionId: string, outcome: "running" | "finished" | "writeError" | "cancelled" | "failed"): void {
    if (outcome !== "running") this.stopSnapshots();
    if (!this.diagnostics) return;
    let engine: unknown = null;
    try {
      const text = this.capture.diagnostics?.();
      engine = text ? JSON.parse(text) as unknown : null;
    } catch (cause) {
      this.log(`diagnostics: the engine's figures could not be read: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    const host = { previewForwarded: this.previewFrames - this.previewFramesBefore, previewWithoutPort: this.previewWithoutPort,
      previewForwardedBytes: this.previewBytes - this.previewBytesBefore, ...this.delivery.counts };
    this.log(`diagnostics: ${JSON.stringify({ kind: "engine", schema: PIPELINE_SCHEMA, session: sessionId, outcome, host, engine })}`);
  }

  private event(event: EngineEvent): void {
    if (this.monitorEvent(event)) return;
    const session = this.session;
    if (!session) return;
    if (event.kind === "progress") {
      this.send({ type: "progress", sessionId: session.id, bytes: event.bytes ?? 0 });
    } else if (event.kind === "writeError" && WRITE_CODES.includes(event.code ?? "")) {
      this.send({ type: "writeError", sessionId: session.id, code: event.code as "disk_full" | "output_write_failed", detail: event.detail ?? "" });
    } else if (event.kind === "microphoneLost") {
      this.send({ type: "microphoneLost", sessionId: session.id, detail: event.detail ?? "the microphone stopped" });
    } else if (event.kind === "microphoneResumed") {
      this.send({ type: "microphoneResumed", sessionId: session.id, detail: event.detail ?? "the microphone delivered sound again" });
    } else if (event.kind === "microphoneSwitched") {
      this.send({ type: "microphoneSwitched", sessionId: session.id, from: event.from ?? "", to: event.to ?? "" });
    } else if (event.kind === "microphoneSwitchFailed") {
      this.send({ type: "microphoneSwitchFailed", sessionId: session.id, detail: event.detail ?? "the microphone could not be switched" });
    } else if (event.kind === "cameraLost") {
      this.send({ type: "cameraLost", sessionId: session.id, detail: event.detail ?? "the camera stopped" });
    } else if (event.kind === "cameraReady") {
      this.send({ type: "cameraReady", sessionId: session.id, detail: event.detail ?? "the camera delivered its first frame" });
    } else if (event.kind === "cameraNotReady") {
      this.send({ type: "cameraNotReady", sessionId: session.id, detail: event.detail ?? "the camera delivered no first frame" });
    } else if (event.kind === "cameraResumed") {
      this.send({ type: "cameraResumed", sessionId: session.id, detail: event.detail ?? "the camera delivered frames again" });
    } else if (event.kind === "levels" && typeof event.system === "number") {
      // To the Studio's page directly (plan 081): main does not pass them on.
      this.previewPort?.postMessage({ type: "levels", system: event.system,
        ...(typeof event.microphone === "number" ? { microphone: event.microphone } : {}) });
    } else if (event.kind === "captureError") {
      const code = HOST_CODES.includes(event.code ?? "") ? event.code as HostErrorCode : "capture_failed";
      this.fail(session.id, code, event.detail ?? "capture ended");
    }
  }

  private stopSnapshots(): void {
    if (this.snapshots !== undefined) clearInterval(this.snapshots);
    this.snapshots = undefined;
  }

  private fail(sessionId: string, code: HostErrorCode, detail: string): void {
    if (this.lastSessionId === sessionId && this.snapshots !== undefined) this.logDiagnostics(sessionId, "failed");
    this.send({ type: "error", sessionId, code, detail });
  }

  private send(message: HostMessage): void {
    this.port.postMessage(message);
  }
}

// In the utility process: load the engine named by the first argument and serve main.
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (parentPort) {
  const addonPath = process.argv[2];
  try {
    if (!addonPath) throw new Error("no engine path was given");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const engine = require(addonPath) as EngineModule;
    new NativeHost(parentPort, (onEvent) => new engine.NativeCapture(onEvent), undefined, undefined, developmentCapture(process.env), cameraPreviewOn(process.env),
      process.env[DIAGNOSTICS_ENV] === "1", studioStallOf(process.env[STUDIO_STALL_ENV]));
  } catch (cause) {
    // Main hears no `ready` and reports the start failure; the reason goes to its log through stderr.
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`native capture host: the engine could not be loaded from ${addonPath ?? "?"}: ${message}`);
    process.exit(engineLoadExit(process.platform, message));
  }
}
