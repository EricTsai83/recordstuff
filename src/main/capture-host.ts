/**
 * Supervises the hidden capture-host renderer (docs/system-design/recording.md): creates it on the
 * first start and keeps it alive afterwards, exchanges the MessagePort,
 * validates every inbound message, and detects crashes / hangs
 * (`render-process-gone`, two missed pongs).
 *
 * The heartbeat runs only while a session is in flight. A hang matters when
 * bytes are expected; between sessions it would only cost timers and turn a
 * wedged idle renderer into an error the user cannot act on. Before reuse,
 * `start` probes responsiveness and replaces an unresponsive host. A crash is
 * still reported at any time by `render-process-gone`.
 */
import { BrowserWindow, MessageChannelMain, type WebFrameMain, type MessagePortMain } from "electron";
import { isHostMessage, type HostMessage, type MainMessage } from "../shared/protocol";
import type { QualitySettings } from "../shared/quality";
import type { RecorderHost } from "./recorder";

export interface CaptureHostOptions {
  preloadPath: string;
  /** Dev server URL from electron-vite; when absent, `htmlPath` is loaded. */
  devUrl?: string | undefined;
  htmlPath: string;
  pingIntervalMs?: number;
  readyTimeoutMs?: number;
  log?: (message: string) => void;
}

type FailureCode = "capture_host_crashed" | "capture_host_unresponsive";

export class CaptureHost implements RecorderHost {
  private window: BrowserWindow | undefined;
  private port: MessagePortMain | undefined;
  private ready: Promise<void> | undefined;
  private generation = 0;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  /** The session the heartbeat is watching, if any. */
  private watching: string | undefined;
  private missedPongs = 0;
  private readonly messageListeners = new Set<(message: HostMessage) => void>();
  private readonly failureListeners = new Set<(code: FailureCode, detail: string) => void>();
  private readonly pingIntervalMs: number;
  private readonly readyTimeoutMs: number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: CaptureHostOptions) {
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

  async start(sessionId: string, quality: QualitySettings): Promise<void> {
    if (this.ready && this.window && !this.window.isDestroyed()) {
      const generation = this.generation;
      const responsive = await this.probe();
      if (generation !== this.generation) throw new Error("capture host was destroyed during the readiness probe");
      if (!responsive) this.teardown();
    }
    const ready = this.ensureReady();
    const generation = this.generation;
    await ready;
    if (generation !== this.generation) throw new Error("capture host was invalidated during startup");
    this.watching = sessionId;
    this.missedPongs = 0;
    this.pingTimer ??= setInterval(() => this.ping(), this.pingIntervalMs);
    this.post({ type: "start", sessionId, quality });
  }

  /** The request must originate from this attempt's actual main frame. */
  ownsDisplayRequest(frame: WebFrameMain | null, sessionId: string | undefined): boolean {
    return !!frame && !!sessionId && this.watching === sessionId && !!this.window
      && !this.window.isDestroyed() && this.window.webContents.mainFrame === frame;
  }

  stop(sessionId: string): void {
    if (!this.port) return;
    this.post({ type: "stop", sessionId });
  }

  destroy(): void {
    this.teardown();
  }

  /** One bounded round trip on reuse; no polling or renderer churn while idle. */
  private probe(): Promise<boolean> {
    return new Promise((resolve) => {
      const finish = (responsive: boolean): void => {
        clearTimeout(timer);
        this.messageListeners.delete(listener);
        resolve(responsive);
      };
      const listener = (message: HostMessage): void => {
        if (message.type === "pong") finish(true);
      };
      const timer = setTimeout(() => finish(false), 1000);
      this.messageListeners.add(listener);
      this.post({ type: "ping" });
    });
  }

  private ensureReady(): Promise<void> {
    if (this.ready && this.window && !this.window.isDestroyed()) return this.ready;
    this.teardown();
    this.ready = this.create();
    const generation = this.generation;
    this.ready.catch(() => { if (generation === this.generation) this.teardown(); });
    return this.ready;
  }

  private async create(): Promise<void> {
    const window = new BrowserWindow({
      show: false,
      width: 320,
      height: 200,
      skipTaskbar: true,
      webPreferences: {
        preload: this.options.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    this.window = window;
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("render-process-gone", (_event, details) => {
      this.log(`capture host: render process gone (${details.reason}, exit ${details.exitCode})`);
      this.teardown();
      this.emitFailure("capture_host_crashed", details.reason);
    });
    window.on("closed", () => {
      if (this.window === window) this.teardown();
    });

    const { port1, port2 } = new MessageChannelMain();
    this.port = port1;
    // Local to this `create()` call: a stale create torn down mid-flight must
    // not clear the deadline of a newer one.
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    const readyReceived = new Promise<void>((resolve, reject) => {
      readyTimer = setTimeout(
        () => reject(new Error("capture host did not report ready before the deadline")),
        this.readyTimeoutMs,
      );
      port1.on("message", (event) => {
        const message: unknown = event.data;
        if (!isHostMessage(message)) {
          this.log(`capture host: dropped malformed message ${JSON.stringify(message)}`);
          return;
        }
        if (message.type === "ready") resolve();
        if (message.type === "pong") this.missedPongs = 0;
        // The session is over once the host reports it stopped or failed;
        // nothing is expected from the renderer until the next start.
        if (
          (message.type === "stopped" && message.sessionId === this.watching) ||
          (message.type === "error" && (message.sessionId === undefined || message.sessionId === this.watching))
        ) {
          this.stopHeartbeat();
        }
        for (const listener of this.messageListeners) listener(message);
      });
    });
    // If loading fails below, nobody awaits this promise; keep its later
    // timeout rejection from surfacing as an unhandled rejection.
    readyReceived.catch(() => undefined);
    port1.start();

    try {
      if (this.options.devUrl) await window.loadURL(this.options.devUrl);
      else await window.loadFile(this.options.htmlPath);
      window.webContents.postMessage("capture-host-port", null, [port2]);
      await readyReceived;
    } finally {
      if (readyTimer) clearTimeout(readyTimer);
    }
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
    this.port?.postMessage(message);
  }

  private emitFailure(code: FailureCode, detail: string): void {
    for (const listener of this.failureListeners) listener(code, detail);
  }

  private teardown(): void {
    this.generation += 1;
    this.stopHeartbeat();
    this.port?.close();
    this.port = undefined;
    this.ready = undefined;
    const window = this.window;
    this.window = undefined;
    if (window && !window.isDestroyed()) window.destroy();
  }
}
