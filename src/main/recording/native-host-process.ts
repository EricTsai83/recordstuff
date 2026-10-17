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
import { cameraPreviewOn } from "../../shared/camera-preview";
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
interface EngineEvent { kind: "progress" | "writeError" | "captureError" | "microphoneLost" | "microphoneResumed" | "cameraLost" | "cameraResumed"; bytes?: number; code?: string; detail?: string }
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
    source?: CaptureSource; audio?: AudioOptions; camera?: CameraOptions;
  }): Promise<PreparedInfo>;
  record(): void;
  stop(): Promise<StopReport>;
  finish(): Promise<FinishReport>;
  cancel(): Promise<void>;
  microphones(): Promise<MicrophoneDevice[]>;
  /** Plan 075: the camera's bubble and whether it is shown, from the next frame on; false without a camera. */
  setCameraLayout?(options: CameraOptions, hidden: boolean): boolean;
  /** Plan 075's prototype: preview chunks while a session composes the camera. */
  onPreview?(onFrame: (frame: PreviewFrame) => void): void;
}
interface EngineModule { NativeCapture: new (onEvent: (event: EngineEvent) => void) => NativeCapture }

/** Where preview frames go: a `MessagePortMain` main hands over to a preview page (plan 075's prototype). */
export interface PreviewPort {
  postMessage(message: unknown): void;
  close(): void;
}

/** The subset of Electron's `process.parentPort` the host uses; lets tests pass a fake. */
export interface ParentPort {
  on(event: "message", listener: (message: { data: unknown; ports?: PreviewPort[] }) => void): void;
  postMessage(message: unknown): void;
}

/** Main's message that hands this process the preview page's port; not part of the capture protocol. */
export const PREVIEW_PORT_MESSAGE = "cameraPreviewPort";
export { cameraPreviewOn, cameraPrototypeOn } from "../../shared/camera-preview";

const HOST_CODES: readonly string[] = ["permission_denied", "no_display", "no_audio_track", "microphone_unavailable", "camera_unavailable", "media_components_missing", "capture_start_failed", "capture_failed"];
const WRITE_CODES: readonly string[] = ["disk_full", "output_write_failed"];

const NUMBER_LIST = /^\d+(,\d+)*$/;
const numbers = (text: string): number[] => text.split(",").map(Number);

/**
 * Step 4's development switches, until a later plan's pickers choose: `RECORDSTUFF_CAPTURE_SOURCE` is `window:<id>`,
 * `area:<x>,<y>,<width>,<height>` (the display's pixels) or `apps:<pid>,…`, and `RECORDSTUFF_CAPTURE_AUDIO` is `off`
 * or `apps:<pid>,…`. Anything else, or nothing, records as today. The microphone is the user's setting (plan 074), which
 * `start` carries and these switches keep.
 */
export function developmentCapture(env: Record<string, string | undefined>): { source?: CaptureSource; audio?: AudioOptions } {
  const result: { source?: CaptureSource; audio?: AudioOptions } = {};
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

export class NativeHost {
  private session: { id: string; phase: Phase; recordingPath: string; cancelled: boolean } | undefined;
  private previewPort: PreviewPort | undefined;
  private previewFrames = 0;

  constructor(
    private readonly port: ParentPort,
    private readonly engine: NativeCapture | ((onEvent: (event: EngineEvent) => void) => NativeCapture),
    /** A line for main's log: the host's stdout reaches it as `capture host: …`. */
    private readonly log: (line: string) => void = (line) => console.log(line),
    private readonly now: () => number = () => performance.now(),
    private readonly development: { source?: CaptureSource; audio?: AudioOptions } = {},
    private readonly cameraPreview = false,
  ) {
    if (typeof engine === "function") this.engine = engine((event) => this.event(event));
    if (cameraPreview) this.capture.onPreview?.((frame) => this.preview(frame));
    port.on("message", ({ data, ports }) => {
      if (typeof data === "object" && data !== null && (data as { type?: unknown }).type === PREVIEW_PORT_MESSAGE) {
        this.previewPort?.close();
        this.previewPort = ports?.[0];
        return;
      }
      this.handle(data);
    });
    this.send({ type: "ready" });
  }

  /** Forwards a preview chunk to the preview page, when main gave one; dropped otherwise. */
  private preview(frame: PreviewFrame): void {
    if (!this.previewPort) return;
    this.previewFrames += 1;
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
      case "listMicrophones":
        void this.listMicrophones();
        return;
      case "cameraLayout":
        this.cameraLayout(message.sessionId, message.camera, message.hidden);
        return;
    }
  }

  /** A new bubble or hiding for the session's camera (plan 075), logged with the session. */
  private cameraLayout(sessionId: string, camera: CameraChoice, hidden: boolean): void {
    if (this.session?.id !== sessionId) return;
    const { deviceId: _device, ...layout } = camera;
    const applied = this.capture.setCameraLayout?.(layout, hidden) ?? false;
    this.log(`camera layout: ${JSON.stringify(layout)}, ${hidden ? "hidden" : "shown"}${applied ? "" : " (no camera in this session)"}`);
  }

  /** The audio inputs, for the Settings device menu (plan 074). Never while a session holds the engine. */
  private async listMicrophones(): Promise<void> {
    if (this.session) {
      this.send({ type: "microphones", error: "a recording is in progress" });
      return;
    }
    try {
      const devices = await this.capture.microphones();
      this.send({ type: "microphones", devices: devices.map(({ id, name, default: isDefault }) => ({ id, name, default: isDefault })) });
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
    let capture: CaptureReport;
    try {
      const began = this.now();
      // napi-rs reads an absent optional object as None and refuses null, so the point is left out on macOS.
      const chosen = this.development.source;
      const audio = this.audio(native);
      if (chosen || this.development.audio) this.log(`development capture: source ${JSON.stringify(chosen ?? "display")}, audio ${JSON.stringify(audio ?? "all")}`);
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
      this.session = undefined;
      this.send({ type: "stopped", sessionId, tracksStoppedAt: Date.now() });
      return;
    }
    session.phase = "prepared";
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
      this.send({ type: "finished", sessionId,
        file: { bytes: file.bytes, finalizeMs: file.finalizeMs, ...(file.fragmented ? { fragmented: file.fragmented } : {}) } });
    } catch (cause) {
      const { code, detail } = engineFailure(cause);
      this.send({ type: "writeError", sessionId, code: WRITE_CODES.includes(code) ? code as "disk_full" | "output_write_failed" : "output_write_failed", detail });
    }
  }

  private event(event: EngineEvent): void {
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
    } else if (event.kind === "cameraLost") {
      this.send({ type: "cameraLost", sessionId: session.id, detail: event.detail ?? "the camera stopped" });
    } else if (event.kind === "cameraResumed") {
      this.send({ type: "cameraResumed", sessionId: session.id, detail: event.detail ?? "the camera delivered frames again" });
    } else if (event.kind === "captureError") {
      const code = HOST_CODES.includes(event.code ?? "") ? event.code as HostErrorCode : "capture_failed";
      this.fail(session.id, code, event.detail ?? "capture ended");
    }
  }

  private fail(sessionId: string, code: HostErrorCode, detail: string): void {
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
    new NativeHost(parentPort, (onEvent) => new engine.NativeCapture(onEvent), undefined, undefined, developmentCapture(process.env), cameraPreviewOn(process.env));
  } catch (cause) {
    // Main hears no `ready` and reports the start failure; the reason goes to its log through stderr.
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`native capture host: the engine could not be loaded from ${addonPath ?? "?"}: ${message}`);
    process.exit(engineLoadExit(process.platform, message));
  }
}
