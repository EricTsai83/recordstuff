import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_QUALITY } from "../shared/quality";
import type { HostMessage, MainMessage } from "../shared/protocol";

const mock = vi.hoisted(() => {
  const windows: any[] = [];
  const ports: any[] = [];
  class Port {
    listeners: Array<(event: { data: unknown }) => void> = [];
    sent: unknown[] = [];
    closed = false;
    on = (_name: "message", listener: (event: { data: unknown }) => void) => this.listeners.push(listener);
    start = vi.fn();
    postMessage = (message: unknown) => this.sent.push(message);
    close = vi.fn(() => {
      this.closed = true;
    });
    /** Deliver a message as if the renderer had sent it. */
    emit(data: unknown): void {
      for (const listener of [...this.listeners]) listener({ data });
    }
  }
  class MessageChannelMain {
    port1 = new Port();
    port2 = { id: "port2" };
    constructor() {
      ports.push(this.port1);
    }
  }
  class Window {
    events = new Map<string, (...args: any[]) => void>();
    contentEvents = new Map<string, (...args: any[]) => void>();
    destroyed = false;
    webContents = {
      mainFrame: {},
      setWindowOpenHandler: vi.fn(),
      on: (name: string, listener: (...args: any[]) => void) => this.contentEvents.set(name, listener),
      // Handing over the port is what lets the page answer; the fake page
      // reports ready on the next turn, like the real one.
      postMessage: vi.fn(() => {
        queueMicrotask(() => ports.at(-1)?.emit({ type: "ready" }));
      }),
    };
    loadFile = vi.fn().mockResolvedValue(undefined);
    loadURL = vi.fn().mockResolvedValue(undefined);
    isDestroyed = () => this.destroyed;
    destroy = vi.fn(() => {
      this.destroyed = true;
    });
    on = (name: string, listener: (...args: any[]) => void) => this.events.set(name, listener);
    constructor(public options: any) {
      windows.push(this);
    }
  }
  return { windows, ports, Window, MessageChannelMain };
});
vi.mock("electron", () => ({ BrowserWindow: mock.Window, MessageChannelMain: mock.MessageChannelMain }));
import { CaptureHost } from "./capture-host";

const PING_MS = 5000;
function setup() {
  const failures: Array<{ code: string; detail: string }> = [];
  const messages: HostMessage[] = [];
  const logs: string[] = [];
  const host = new CaptureHost({
    preloadPath: "/preload.js",
    htmlPath: "/index.html",
    pingIntervalMs: PING_MS,
    readyTimeoutMs: 8000,
    log: (message) => logs.push(message),
  });
  host.onFailure((code, detail) => failures.push({ code, detail }));
  host.onMessage((message) => messages.push(message));
  const port = () => mock.ports.at(-1)!;
  return {
    host,
    failures,
    messages,
    logs,
    port,
    window: () => mock.windows.at(-1)!,
    pings: () => port().sent.filter((message: unknown) => (message as MainMessage).type === "ping").length,
    start: async (sessionId = "s1") => {
      const started = host.start(sessionId, DEFAULT_QUALITY);
      await vi.advanceTimersByTimeAsync(0);
      await started;
    },
  };
}

beforeEach(() => {
  mock.windows.length = 0;
  mock.ports.length = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("capture host supervision", () => {
  it("creates a fresh hidden, sandboxed window for every start", async () => {
    const s = setup();
    await s.start("s1");
    expect(mock.windows).toHaveLength(1);
    expect(s.window().options).toMatchObject({ show: false, skipTaskbar: true });
    expect(s.window().options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    });
    expect(s.port().sent[0]).toEqual({ type: "start", sessionId: "s1", quality: DEFAULT_QUALITY });
    s.port().emit({ type: "stopped", sessionId: "s1" });
    const [firstWindow, firstPort] = [s.window(), s.port()];
    await s.start("s2");
    expect(mock.windows).toHaveLength(2);
    expect(firstWindow.destroy).toHaveBeenCalledOnce();
    expect(firstPort.closed).toBe(true);
    expect(s.port().sent).toEqual([{ type: "start", sessionId: "s2", quality: DEFAULT_QUALITY }]);
  });

  it("drops malformed messages and forwards valid ones", async () => {
    const s = setup();
    await s.start();
    s.port().emit({ type: "nonsense" });
    s.port().emit({
      type: "started",
      sessionId: "s1",
      mimeType: "video/mp4",
      capture: { videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 256_000, warnings: [] },
    });
    expect(s.messages.map((message) => message.type)).toEqual(["ready", "started"]);
    expect(s.logs.join()).toContain("dropped malformed message");
  });

  it("logs a bounded summary of a malformed message, never its payload", async () => {
    const s = setup();
    await s.start();
    const malformed = { type: "chunk", sessionId: "s1", seq: 0, bytes: new Uint8Array(1_000_000), extra: 1n };
    expect(() => s.port().emit(malformed)).not.toThrow();
    const line = s.logs.find((entry) => entry.includes("dropped malformed message"))!;
    expect(line).toContain('type: "chunk"');
    expect(line).toContain("bytes: Uint8Array(1000000)");
    expect(line.length).toBeLessThan(200);
  });

  it("tears down an attempt whose page never reports ready", async () => {
    const s = setup();
    const start = s.host.start("s1", DEFAULT_QUALITY);
    s.window().webContents.postMessage = vi.fn();
    const rejected = expect(start).rejects.toThrow("did not report ready");
    await vi.advanceTimersByTimeAsync(8000);
    await rejected;
    expect(s.window().destroy).toHaveBeenCalledOnce();
    expect(s.port().closed).toBe(true);
  });

  it("reports a crashed renderer at any time", async () => {
    const s = setup();
    await s.start();
    s.window().contentEvents.get("render-process-gone")!({}, { reason: "crashed", exitCode: 9 });
    expect(s.failures).toEqual([{ code: "capture_host_crashed", detail: "crashed" }]);
    expect(s.window().destroy).toHaveBeenCalled();
  });
});

describe("the heartbeat runs only while a session is in flight", () => {
  it("pings during a session and stops when the host reports it stopped", async () => {
    const s = setup();
    await s.start("s1");
    await vi.advanceTimersByTimeAsync(PING_MS);
    expect(s.pings()).toBe(1);
    s.port().emit({ type: "pong" });
    await vi.advanceTimersByTimeAsync(PING_MS);
    expect(s.pings()).toBe(2);
    s.port().emit({ type: "pong" });
    s.port().emit({ type: "stopped", sessionId: "s1" });
    await vi.advanceTimersByTimeAsync(PING_MS * 10);
    expect(s.pings()).toBe(2);
    expect(s.failures).toEqual([]);
  });

  it("creates nothing and pings nothing before the first recording", async () => {
    setup();
    await vi.advanceTimersByTimeAsync(PING_MS * 10);
    expect(mock.windows).toHaveLength(0);
    expect(mock.ports).toHaveLength(0);
  });

  it("stops after a failed session too, and resumes on the next start", async () => {
    const s = setup();
    await s.start("s1");
    s.port().emit({ type: "error", sessionId: "s1", code: "capture_failed", detail: "gone" });
    await vi.advanceTimersByTimeAsync(PING_MS * 10);
    expect(s.pings()).toBe(0);
    await s.start("s2");
    await vi.advanceTimersByTimeAsync(PING_MS);
    expect(s.pings()).toBe(1);
  });

  it("ignores a stale session's terminal message", async () => {
    const s = setup();
    await s.start("s2");
    s.port().emit({ type: "stopped", sessionId: "s1" });
    await vi.advanceTimersByTimeAsync(PING_MS);
    expect(s.pings()).toBe(1);
  });

  it("two unanswered pings fail the session and tear the host down", async () => {
    const s = setup();
    await s.start("s1");
    await vi.advanceTimersByTimeAsync(PING_MS * 3);
    expect(s.failures).toEqual([
      { code: "capture_host_unresponsive", detail: "two consecutive pings received no response" },
    ]);
    expect(s.window().destroy).toHaveBeenCalled();
    expect(s.port().closed).toBe(true);
    const before = s.pings();
    await vi.advanceTimersByTimeAsync(PING_MS * 5);
    expect(s.pings()).toBe(before);
  });

  it("destroy() stops the heartbeat and the window", async () => {
    const s = setup();
    await s.start("s1");
    s.host.destroy();
    await vi.advanceTimersByTimeAsync(PING_MS * 5);
    expect(s.pings()).toBe(0);
    expect(s.window().destroy).toHaveBeenCalled();
  });
});

it("rejects old handler arrival after cancellation and a new host start", async () => {
  const s = setup(); await s.start("old");
  const oldFrame = s.window().webContents.mainFrame;
  expect(s.host.ownsDisplayRequest(oldFrame, "old")).toBe(true);
  s.host.destroy();
  expect(s.host.ownsDisplayRequest(oldFrame, "old")).toBe(false);
  await s.start("new");
  expect(s.host.ownsDisplayRequest(oldFrame, "new")).toBe(false);
  expect(s.host.ownsDisplayRequest(s.window().webContents.mainFrame, "new")).toBe(true);
  expect(s.host.ownsDisplayRequest(s.window().webContents.mainFrame, "old")).toBe(false);
  s.host.destroy();
});

it("cannot post a start after its host was invalidated during readiness", async () => {
  const s = setup();
  const pending = s.host.start("old", DEFAULT_QUALITY);
  const rejected = expect(pending).rejects.toThrow();
  s.host.destroy();
  await vi.advanceTimersByTimeAsync(8000);
  await rejected;
  expect(mock.ports.flatMap((p) => p.sent).filter((m: MainMessage) => m.type === "start")).toEqual([]);
});
