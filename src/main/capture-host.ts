/**
 * Supervises the hidden capture-host renderer (docs/system-design/recording.md): every `start`
 * creates a fresh window for that attempt, exchanges the MessagePort,
 * validates every inbound message, and detects crashes / hangs
 * (`render-process-gone`, two missed pongs). The owner calls `destroy` when
 * the attempt settles, so no renderer idles between recordings and a late
 * display-media request can only name a frame that no longer exists.
 *
 * The heartbeat runs only while a session is in flight: a hang matters when
 * bytes are expected. A crash is still reported at any time by
 * `render-process-gone`.
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
    this.teardown();
    const generation = this.generation;
    try {
      await this.create();
    } catch (cause) {
      if (generation === this.generation) this.teardown();
      throw cause;
    }
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

  /** Called when an attempt settles and on quit; the next `start` builds a new window. */
  destroy(): void {
    this.teardown();
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
          this.log(`capture host: dropped malformed message ${describeMalformed(message)}`);
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
    const window = this.window;
    this.window = undefined;
    if (window && !window.isDestroyed()) window.destroy();
  }
}

/**
 * Field names and value kinds only: a malformed message may carry a media
 * payload (a typed array serializes to megabytes of JSON) or a value that
 * JSON cannot serialize at all (BigInt, cycles).
 */
function describeMalformed(message: unknown): string {
  if (typeof message !== "object" || message === null) return String(message).slice(0, 80);
  const fields = Object.entries(message).slice(0, 12).map(([key, value]) => `${key}: ${kindOf(value)}`);
  return `{ ${fields.join(", ")} }`;
}

function kindOf(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.slice(0, 40));
  if (value === null || typeof value !== "object") return typeof value;
  if (value instanceof ArrayBuffer) return `ArrayBuffer(${value.byteLength})`;
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}(${value.byteLength})`;
  return Array.isArray(value) ? "array" : "object";
}
