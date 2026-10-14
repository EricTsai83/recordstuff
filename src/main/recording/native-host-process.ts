/**
 * The native engine's capture host (plan 076, behind D7's `RECORDSTUFF_CAPTURE_ENGINE=native`): the entry of the
 * Electron `utilityProcess` main forks for each attempt (native-capture-host.ts). It loads the Rust engine
 * (native/capture), whose path is its first argument, and speaks the hidden renderer host's protocol over the parent
 * port: `start` prepares capture into the file main created and answers `prepared`, `record` answers `started`, `stop`
 * answers `stopped` once the file is finished. The engine writes the file; instead of chunks the host reports
 * `progress` (bytes written while media arrives) and `writeError`. A crash in native code ends this process only;
 * main sees it exit, fails the session and keeps what was written, which is a readable fragmented MP4.
 */
import { OUTPUT_MIME_TYPE, isMainMessage, type HostErrorCode, type HostMessage, type MainMessage, type NativeStart } from "../../shared/protocol";
import { AUDIO_BITS_PER_SECOND, fitWithinCap, videoBitsPerSecond, type CaptureReport, type QualitySettings } from "../../shared/quality";

interface ProbeResult { width: number; height: number }
interface PreparedInfo {
  width: number; height: number; sampleRate: number; channelCount: number; primingFrames: number;
  excludedApps: number; hiddenWindows: number; warnings: string[];
  /** Where the engine's prepare spent its time. */
  timings?: string;
}
interface StopReport {
  bytes: number; fragmented?: string | null; finalizeMs: number; drainMs?: number; drainPaddedFrames?: number;
  frameLeadAvgMs?: number; frameLeadMaxMs?: number;
}
interface EngineEvent { kind: "progress" | "writeError" | "captureError"; bytes?: number; code?: string; detail?: string }
interface NativeCapture {
  probe(displayId: number, displayPoint?: { x: number; y: number }): Promise<ProbeResult>;
  prepare(options: {
    displayId: number; displayPoint?: { x: number; y: number }; width: number; height: number; frameRate: number;
    videoBitrate: number; audioBitrate: number; ownPids: number[]; hideSystemUi: boolean; path: string;
  }): Promise<PreparedInfo>;
  record(): void;
  stop(): Promise<StopReport>;
  cancel(): Promise<void>;
}
interface EngineModule { NativeCapture: new (onEvent: (event: EngineEvent) => void) => NativeCapture }

/** The subset of Electron's `process.parentPort` the host uses; lets tests pass a fake. */
export interface ParentPort {
  on(event: "message", listener: (message: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const HOST_CODES: readonly string[] = ["permission_denied", "no_display", "no_audio_track", "mp4_unsupported", "capture_start_failed", "capture_failed"];
const WRITE_CODES: readonly string[] = ["disk_full", "output_write_failed"];

/** The engine rejects with `code|detail`. */
export function engineFailure(cause: unknown): { code: string; detail: string } {
  const message = cause instanceof Error ? cause.message : String(cause);
  const split = message.indexOf("|");
  return split > 0 ? { code: message.slice(0, split), detail: message.slice(split + 1) } : { code: "capture_start_failed", detail: message };
}

type Phase = "preparing" | "prepared" | "recording" | "stopping";

export class NativeHost {
  private session: { id: string; phase: Phase; recordingPath: string; cancelled: boolean } | undefined;

  constructor(
    private readonly port: ParentPort,
    private readonly engine: NativeCapture | ((onEvent: (event: EngineEvent) => void) => NativeCapture),
    /** A line for main's log: the host's stdout reaches it as `capture host: …`. */
    private readonly log: (line: string) => void = (line) => console.log(line),
    private readonly now: () => number = () => performance.now(),
  ) {
    if (typeof engine === "function") this.engine = engine((event) => this.event(event));
    port.on("message", ({ data }) => this.handle(data));
    this.send({ type: "ready" });
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
    }
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
      const source = await this.capture.probe(native.displayId, native.displayPoint);
      const probed = this.now();
      const size = fitWithinCap(source, quality.resolutionCap);
      const videoBps = videoBitsPerSecond(size, quality.frameRate, quality.videoQuality);
      const prepared = await this.capture.prepare({
        displayId: native.displayId, ...(native.displayPoint ? { displayPoint: native.displayPoint } : {}), width: size.width, height: size.height, frameRate: quality.frameRate,
        videoBitrate: videoBps, audioBitrate: AUDIO_BITS_PER_SECOND,
        ownPids: native.ownPids, hideSystemUi: native.hideSystemUi, path: native.recordingPath,
      });
      this.log(`timing: probe ${Math.round(probed - began)} ms, prepare ${Math.round(this.now() - probed)} ms` +
        `${prepared.timings ? ` (${prepared.timings})` : ""}`);
      capture = {
        width: prepared.width, height: prepared.height, frameRate: quality.frameRate,
        sampleRate: prepared.sampleRate, channelCount: prepared.channelCount,
        videoBitsPerSecond: videoBps, audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
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
    try {
      const began = this.now();
      const report = await this.capture.stop();
      this.log(`timing: stop ${Math.round(this.now() - began)} ms (sound up to the stop ${Math.round(report.drainMs ?? 0)} ms, ` +
        `${report.drainPaddedFrames ?? 0} frame(s) filled with silence; file ${Math.round(report.finalizeMs)} ms; ` +
        `frames stamped ${(report.frameLeadAvgMs ?? 0).toFixed(1)} ms ahead on average, ${(report.frameLeadMaxMs ?? 0).toFixed(1)} ms at most)`);
      this.session = undefined;
      this.send({ type: "stopped", sessionId, tracksStoppedAt: Date.now(),
        file: { bytes: report.bytes, finalizeMs: report.finalizeMs, ...(report.fragmented ? { fragmented: report.fragmented } : {}) } });
    } catch (cause) {
      this.session = undefined;
      const { code, detail } = engineFailure(cause);
      if (WRITE_CODES.includes(code)) this.send({ type: "writeError", sessionId, code: code as "disk_full" | "output_write_failed", detail });
      else this.fail(sessionId, "capture_failed", detail);
    }
  }

  private event(event: EngineEvent): void {
    const session = this.session;
    if (!session) return;
    if (event.kind === "progress") {
      this.send({ type: "progress", sessionId: session.id, bytes: event.bytes ?? 0 });
    } else if (event.kind === "writeError" && WRITE_CODES.includes(event.code ?? "")) {
      this.send({ type: "writeError", sessionId: session.id, code: event.code as "disk_full" | "output_write_failed", detail: event.detail ?? "" });
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
    new NativeHost(parentPort, (onEvent) => new engine.NativeCapture(onEvent));
  } catch (cause) {
    // Main hears no `ready` and reports the start failure; the reason goes to its log through stderr.
    console.error(`native capture host: the engine could not be loaded from ${addonPath ?? "?"}: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(3);
  }
}
