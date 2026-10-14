/**
 * Supervises the native engine's capture host (plan 076, behind D7's development flag), as capture-host.ts does the
 * hidden renderer: every `start` forks a fresh `utilityProcess` for that attempt (native-host-process.ts), validates
 * every inbound message, and detects a crash (the process exits) or a hang (two missed pongs while a session is in
 * flight). The owner calls `destroy` when the attempt settles, which ends the process, so nothing idles between
 * recordings.
 *
 * Before posting `start` it resolves the display through the same `DisplayMedia` request the renderer host's
 * display-media handler answers, so display choice, its diagnostics and the countdown's display are unchanged. The
 * display is chosen while the process starts, so neither waits for the other.
 */
import { utilityProcess, type UtilityProcess } from "electron";
import { isHostMessage, type EngineFileReport, type HostMessage, type MainMessage } from "../../shared/protocol";
import type { QualitySettings } from "../../shared/quality";
import type { RecorderHost } from "./recorder";

export interface NativeCaptureHostOptions {
  /** The built native-host-process.js. */
  entryPath: string;
  /** The engine's `.node` file, outside the asar archive. */
  addonPath: string;
  /** The display this attempt records (a CGDirectDisplayID), or undefined when main refused one. */
  resolveDisplay: (sessionId: string) => Promise<string | undefined>;
  /** RecordStuff's processes, main first, whose windows and sound the recording leaves out. */
  ownPids: () => number[];
  hideSystemUi: () => boolean;
  pingIntervalMs?: number;
  readyTimeoutMs?: number;
  log?: (message: string) => void;
  /** Forks the host; tests pass a fake. */
  fork?: (entryPath: string, args: string[]) => UtilityProcess;
  now?: () => number;
}

type FailureCode = "capture_host_crashed" | "capture_host_unresponsive";

export class NativeCaptureHost implements RecorderHost {
  private child: UtilityProcess | undefined;
  private generation = 0;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private watching: string | undefined;
  private missedPongs = 0;
  private abandonReady: ((cause: Error) => void) | undefined;
  /** What the engine reported for each file it finished, by temporary path; read once by EngineFileWriter. */
  private readonly reports = new Map<string, EngineFileReport>();
  private recordingPath: string | undefined;
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

  /** The engine's report for `recordingPath`, once; undefined before it stopped or when it did not report. */
  takeReport(recordingPath: string): EngineFileReport | undefined {
    const report = this.reports.get(recordingPath);
    this.reports.delete(recordingPath);
    return report;
  }

  async start(sessionId: string, quality: QualitySettings, recordingPath?: string): Promise<void> {
    this.teardown();
    const generation = this.generation;
    if (!recordingPath) throw new Error("the native engine needs the recording file's path");
    const now = this.options.now ?? (() => performance.now());
    const began = now();
    let chosenAt = began;
    const choice = this.options.resolveDisplay(sessionId).then(
      (display) => { chosenAt = now(); return { display }; },
      (cause: unknown) => ({ cause }),
    );
    try {
      await this.create();
    } catch (cause) {
      if (generation === this.generation) this.teardown();
      throw cause;
    }
    const readyAt = now();
    if (generation !== this.generation) throw new Error("capture host was invalidated during startup");
    this.watching = sessionId;
    this.recordingPath = recordingPath;
    this.missedPongs = 0;
    this.pingTimer ??= setInterval(() => this.ping(), this.pingIntervalMs);
    const chosen = await choice;
    if ("cause" in chosen) throw chosen.cause;
    const display = chosen.display;
    this.log(`capture host: timing: process ready ${Math.round(readyAt - began)} ms, display chosen ${Math.round(chosenAt - began)} ms`);
    if (generation !== this.generation) throw new Error("capture host was invalidated while the display was chosen");
    if (!display || !/^\d+$/.test(display)) {
      // Main refused a display (the recorder's `mapHostError` names why) or has none to offer.
      this.emit({ type: "error", sessionId, code: "capture_start_failed", detail: "no display was granted for this recording" });
      return;
    }
    this.post({ type: "start", sessionId, quality, native: {
      displayId: Number(display), recordingPath, ownPids: this.options.ownPids(), hideSystemUi: this.options.hideSystemUi(),
    } });
  }

  record(sessionId: string): void {
    if (!this.child || this.watching !== sessionId) throw new Error("capture host is not running this session");
    this.post({ type: "record", sessionId });
  }

  stop(sessionId: string): void {
    if (!this.child) return;
    this.post({ type: "stop", sessionId });
  }

  destroy(): void {
    this.teardown();
  }

  private async create(): Promise<void> {
    const fork = this.options.fork ?? ((entry, args) => utilityProcess.fork(entry, args, { serviceName: "RecordStuff Capture", stdio: "pipe" }));
    const child = fork(this.options.entryPath, [this.options.addonPath]);
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) this.log(`capture host: ${line.trim()}`);
      });
    }
    child.on("exit", (code) => {
      if (this.child !== child) return;
      const lost = this.watching !== undefined;
      this.teardown();
      this.log(`capture host: process exited (${code})${lost ? " during a session" : ""}`);
      if (lost) this.emitFailure("capture_host_crashed", `capture process exited with ${code}`);
    });

    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    let abandon: ((cause: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      abandon = reject;
      this.abandonReady = reject;
      readyTimer = setTimeout(() => reject(new Error("capture host did not report ready before the deadline")), this.readyTimeoutMs);
      child.on("message", (data: unknown) => {
        if (this.child !== child) return;
        if (!isHostMessage(data)) {
          this.log(`capture host: dropped malformed message of type ${typeof data === "object" && data ? String((data as { type?: unknown }).type) : typeof data}`);
          return;
        }
        if (data.type === "ready") resolve();
        if (data.type === "pong") this.missedPongs = 0;
        this.emit(data);
      });
    });
    ready.catch(() => undefined);
    try {
      await ready;
    } finally {
      if (readyTimer) clearTimeout(readyTimer);
      if (this.abandonReady === abandon) this.abandonReady = undefined;
    }
  }

  private emit(message: HostMessage): void {
    if (message.type === "stopped" && message.file && this.recordingPath && message.sessionId === this.watching) {
      this.reports.set(this.recordingPath, message.file);
      this.log(`capture host: engine finished ${message.file.bytes} bytes in ${Math.round(message.file.finalizeMs)} ms` +
        `${message.file.fragmented ? `, left fragmented: ${message.file.fragmented}` : ", plain MP4"}`);
    }
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
    this.recordingPath = undefined;
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }
}
