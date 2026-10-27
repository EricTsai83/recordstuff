import { describe, expect, it, vi } from "vitest";
import type { HostMessage, MicrophoneDevice, NativeStart } from "../../shared/protocol";
import { DEFAULT_QUALITY } from "../../shared/quality";
import { NativeHost, PREVIEW_PORT_MESSAGE, cameraPreviewOn, cameraPrototypeOn, developmentCapture, engineFailure, engineLoadExit, type ParentPort, type PreviewFrame, type PreviewPort } from "./native-host-process";

class Port implements ParentPort {
  sent: HostMessage[] = [];
  private listener: ((message: { data: unknown; ports?: PreviewPort[] }) => void) | undefined;
  on(_event: "message", listener: (message: { data: unknown; ports?: PreviewPort[] }) => void): void { this.listener = listener; }
  postMessage(message: unknown): void { this.sent.push(message as HostMessage); }
  deliver(data: unknown, ports?: PreviewPort[]): void { this.listener?.({ data, ...(ports ? { ports } : {}) }); }
}

type Event = { kind: "progress" | "writeError" | "captureError" | "microphoneLost" | "microphoneResumed"; bytes?: number; code?: string; detail?: string };

function fakeEngine() {
  let emit: (event: Event) => void = () => undefined;
  const engine = {
    probe: vi.fn(async () => ({ width: 3456, height: 2234 })),
    prepare: vi.fn(async (options: { width: number; height: number }) => ({
      width: options.width, height: options.height, sampleRate: 48_000, channelCount: 2, primingFrames: 2112,
      excludedApps: 2, hiddenWindows: 0, warnings: [], timings: "content 0 ms, first frame 12 ms; total 40 ms",
    })),
    record: vi.fn(),
    stop: vi.fn(async () => ({ drainMs: 31, drainPaddedFrames: 0, frameLeadAvgMs: 4.2, frameLeadMaxMs: 9 })),
    finish: vi.fn(async (): Promise<{ bytes: number; finalizeMs: number; fragmented?: string | null }> => ({ bytes: 1234, finalizeMs: 4, fragmented: null })),
    cancel: vi.fn(async () => undefined),
    microphones: vi.fn(async (): Promise<MicrophoneDevice[]> => [{ id: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", default: true }]),
  };
  return { engine, factory: (onEvent: (event: Event) => void) => { emit = onEvent; return engine; }, emit: (event: Event) => emit(event) };
}

const native: NativeStart = { displayId: 1, recordingPath: "/out/a.recording.mp4", ownPids: [10, 11], hideSystemUi: false };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function prepared() {
  const port = new Port();
  const fake = fakeEngine();
  const logs: string[] = [];
  new NativeHost(port, fake.factory, (line) => logs.push(line));
  port.deliver({ type: "start", sessionId: "s1", quality: { ...DEFAULT_QUALITY, resolutionCap: "1080p" }, native });
  await flush();
  return { port, logs, ...fake };
}

describe("engineLoadExit", () => {
  it("tells a Windows missing a library the engine links (its media components) from any other failure to load", () => {
    expect(engineLoadExit("win32", "\\?\\C:\\x\\recordstuff-capture.node: The specified module could not be found.")).toBe(4);
    expect(engineLoadExit("win32", "Cannot find module 'C:\\x\\recordstuff-capture.node'")).toBe(3);
    expect(engineLoadExit("darwin", "The specified module could not be found.")).toBe(3);
  });
});

describe("engineFailure", () => {
  it("splits the engine's code from its detail, and treats anything else as a start failure", () => {
    expect(engineFailure(new Error("permission_denied|declined (-3801)"))).toEqual({ code: "permission_denied", detail: "declined (-3801)" });
    expect(engineFailure("boom")).toEqual({ code: "capture_start_failed", detail: "boom" });
  });
});

describe("cameraPrototypeOn", () => {
  it("is on for any value the engine reads as on", () => {
    expect(cameraPrototypeOn({})).toBe(false);
    for (const value of ["", " ", "0", "off", "OFF"]) expect(cameraPrototypeOn({ RECORDSTUFF_CAMERA_PROTOTYPE: value })).toBe(false);
    for (const value of ["1", "on", "width=0.3,mirror=1"]) expect(cameraPrototypeOn({ RECORDSTUFF_CAMERA_PROTOTYPE: value })).toBe(true);
  });

  it("asks for preview frames unless preview=0", () => {
    expect(cameraPreviewOn({})).toBe(false);
    expect(cameraPreviewOn({ RECORDSTUFF_CAMERA_PROTOTYPE: "1" })).toBe(true);
    expect(cameraPreviewOn({ RECORDSTUFF_CAMERA_PROTOTYPE: "width=0.3, preview=1" })).toBe(true);
    expect(cameraPreviewOn({ RECORDSTUFF_CAMERA_PROTOTYPE: "width=0.3, preview = 0" })).toBe(false);
  });
});

describe("the camera (plan 075)", () => {
  const camera = { deviceId: "cam", width: 0.2, height: 0.2, rounding: 1, x: 0.97, y: 0.95, mirror: true };

  it("passes the camera to the engine, with whether this process makes preview frames", async () => {
    for (const preview of [false, true]) {
      const port = new Port();
      const fake = fakeEngine();
      new NativeHost(port, fake.factory, () => undefined, undefined, {}, preview);
      port.deliver({ type: "start", sessionId: "s1", quality: DEFAULT_QUALITY, native: { ...native, camera } });
      await flush();
      expect(fake.engine.prepare).toHaveBeenCalledWith(expect.objectContaining({ camera: { ...camera, preview } }));
    }
    const port = new Port();
    const fake = fakeEngine();
    new NativeHost(port, fake.factory, () => undefined);
    port.deliver({ type: "start", sessionId: "s1", quality: DEFAULT_QUALITY, native });
    await flush();
    expect(fake.engine.prepare.mock.calls[0]![0]).not.toHaveProperty("camera");
  });

  it("hands the session's camera changes to the engine without the device, logs them and ignores another session's", async () => {
    const logs: string[] = [];
    const port = new Port();
    const fake = fakeEngine();
    const setCameraLayout = vi.fn(() => true);
    new NativeHost(port, (onEvent) => ({ ...fake.factory(onEvent), setCameraLayout }), (line) => logs.push(line));
    port.deliver({ type: "start", sessionId: "s1", quality: DEFAULT_QUALITY, native: { ...native, camera } });
    await flush();
    port.deliver({ type: "cameraLayout", sessionId: "s1", camera: { ...camera, x: 0 }, hidden: true });
    port.deliver({ type: "cameraLayout", sessionId: "other", camera, hidden: false });
    const { deviceId: _device, ...layout } = camera;
    expect(setCameraLayout.mock.calls).toEqual([[{ ...layout, x: 0 }, true]]);
    expect(logs).toContainEqual(expect.stringMatching(/^camera layout: .*"x":0.*, hidden$/));
  });

  it("lists the cameras, never while a session holds the engine", async () => {
    const port = new Port();
    const fake = fakeEngine();
    const cameras = vi.fn(async () => [{ id: "iphone", name: "iPhone Camera", default: false, extra: 1 }]);
    new NativeHost(port, (onEvent) => ({ ...fake.factory(onEvent), cameras }));
    port.deliver({ type: "listCameras" });
    await flush();
    expect(port.sent.at(-1)).toEqual({ type: "cameras", devices: [{ id: "iphone", name: "iPhone Camera", default: false }] });
    port.deliver({ type: "start", sessionId: "s1", quality: DEFAULT_QUALITY, native });
    await flush();
    port.deliver({ type: "listCameras" });
    await flush();
    expect(port.sent.at(-1)).toEqual({ type: "cameras", error: "a recording is in progress" });
  });

  it("passes the session's level watching and mutes to the engine, and its levels to the Studio's port, not main (D19, plan 081)", async () => {
    const { port, emit, engine, logs } = await prepared();
    const studio = { posted: [] as unknown[], postMessage(m: unknown) { this.posted.push(m); }, close() {} };
    const watchLevels = vi.fn(() => true), setMuted = vi.fn(() => true), setGains = vi.fn(() => true);
    Object.assign(engine, { watchLevels, setMuted, setGains });
    port.deliver({ type: "levels", sessionId: "s1", watching: true });
    port.deliver({ type: "levels", sessionId: "other", watching: false });
    port.deliver({ type: "mute", sessionId: "s1", system: false, microphone: true });
    expect(watchLevels.mock.calls).toEqual([[true]]);
    expect(setMuted.mock.calls).toEqual([[false, true]]);
    expect(logs).toContainEqual("audio: system on, microphone muted");
    port.deliver({ type: "gain", sessionId: "s1", system: -6, microphone: 12 });
    port.deliver({ type: "gain", sessionId: "other", system: 0, microphone: 0 });
    expect(setGains.mock.calls).toEqual([[-6, 12]]);
    expect(logs).toContainEqual("audio: system -6.0 dB, microphone 12.0 dB");
    const toMain = port.sent.length;
    // Before the page is joined they have nowhere to go.
    emit({ kind: "levels", system: 0.1, microphone: null } as never);
    port.deliver({ type: PREVIEW_PORT_MESSAGE }, [studio]);
    emit({ kind: "levels", system: 0.5, microphone: null } as never);
    emit({ kind: "levels", system: 0.25, microphone: 0.75 } as never);
    expect(studio.posted).toEqual([{ type: "levels", system: 0.5 }, { type: "levels", system: 0.25, microphone: 0.75 }]);
    expect(port.sent.length).toBe(toMain);
  });

  it("passes the page's rate and view on the Studio's port to the engine, from the port given last only (plan 092)", () => {
    const port = new Port();
    const fake = fakeEngine();
    const setPreviewRate = vi.fn(() => true);
    const setPreviewView = vi.fn(() => true);
    new NativeHost(port, { ...fake.engine, setPreviewRate, setPreviewView }, () => undefined);
    const studioPort = () => {
      let listener: ((message: { data: unknown }) => void) | undefined;
      return { started: false, postMessage() {}, close() {}, start() { this.started = true; },
        on(event: string, next: (message: { data: unknown }) => void) { if (event === "message") listener = next; },
        say(data: unknown) { listener?.({ data }); } };
    };
    const first = studioPort(), second = studioPort();
    port.deliver({ type: PREVIEW_PORT_MESSAGE }, [first]);
    expect(first.started).toBe(true);
    first.say({ type: "rate", fps: 5 });
    first.say({ type: "rate", fps: 7 });
    first.say({ type: "rate", fps: 15 });
    first.say("rate");
    first.say({ type: "view", view: "screen" });
    first.say({ type: "view", view: "camera" });
    first.say({ type: "view", view: "selfie" });
    port.deliver({ type: PREVIEW_PORT_MESSAGE }, [second]);
    first.say({ type: "rate", fps: 10 });
    first.say({ type: "view", view: "composed" });
    second.say({ type: "rate", fps: 10 });
    second.say({ type: "view", view: "composed" });
    expect(setPreviewRate.mock.calls).toEqual([[5], [15], [10]]);
    // Screen only was a view until plan 097: refused as any other unknown view.
    expect(setPreviewView.mock.calls).toEqual([["camera"], ["composed"]]);
  });

  it("forwards the engine's camera loss and return for the session", async () => {
    const { port, emit } = await prepared();
    emit({ kind: "cameraLost", detail: "the camera delivered no frame for 2 s" } as never);
    emit({ kind: "cameraResumed", detail: "the camera delivered frames again after 3.0 s" } as never);
    expect(port.sent.slice(-2)).toEqual([
      { type: "cameraLost", sessionId: "s1", detail: "the camera delivered no frame for 2 s" },
      { type: "cameraResumed", sessionId: "s1", detail: "the camera delivered frames again after 3.0 s" }]);
  });

  it("forwards the engine's camera not ready and its first frame for the session (plan 090)", async () => {
    const { port, emit } = await prepared();
    emit({ kind: "cameraReady", detail: "the camera delivered its first frame 0.7 s after it was opened" } as never);
    expect(port.sent.at(-1)).toEqual({ type: "cameraReady", sessionId: "s1", detail: "the camera delivered its first frame 0.7 s after it was opened" });
    emit({ kind: "cameraNotReady", detail: "the camera delivered no frame in the 10 s after it was opened" } as never);
    expect(port.sent.at(-1)).toEqual({ type: "cameraNotReady", sessionId: "s1", detail: "the camera delivered no frame in the 10 s after it was opened" });
  });
});

describe("the camera's preview (plan 075)", () => {
  const frame: PreviewFrame = { width: 640, height: 360, data: new Uint8Array(12), key: true, timestamp: 1_000_000, description: new Uint8Array([1, 100, 0, 30]) };
  const withPreview = () => {
    let send: (frame: PreviewFrame) => void = () => undefined;
    const fake = fakeEngine();
    const engine = { ...fake.engine, onPreview: vi.fn((onFrame: (frame: PreviewFrame) => void) => { send = onFrame; }) };
    return { engine, send: (f: PreviewFrame) => send(f) };
  };

  it("forwards frames to the port main handed over, and drops them before it or after a newer one", () => {
    const port = new Port();
    const { engine, send } = withPreview();
    new NativeHost(port, engine, () => undefined, undefined, {}, true);
    expect(engine.onPreview).toHaveBeenCalledTimes(1);
    send(frame);
    const first = { posted: [] as unknown[], closed: false, postMessage(m: unknown) { this.posted.push(m); }, close() { this.closed = true; } };
    const second = { posted: [] as unknown[], closed: false, postMessage(m: unknown) { this.posted.push(m); }, close() { this.closed = true; } };
    port.deliver({ type: PREVIEW_PORT_MESSAGE }, [first]);
    send(frame);
    port.deliver({ type: PREVIEW_PORT_MESSAGE }, [second]);
    send(frame);
    expect(first.posted).toEqual([expect.objectContaining({ width: 640, height: 360, data: frame.data, key: true, timestamp: 1_000_000, description: frame.description, n: 1 })]);
    expect(first.closed).toBe(true);
    expect(second.posted).toEqual([expect.objectContaining({ n: 2 })]);
    send({ ...frame, key: false, description: null });
    expect(second.posted[1]).not.toHaveProperty("description");
    // The port's message is not the capture protocol's: nothing answers it.
    expect(port.sent.filter((m) => m.type !== "ready")).toEqual([]);
  });

  /** A Studio port the page answers on, and whose page can go. */
  const answeringPort = () => {
    const listeners: Record<string, ((message: { data: unknown }) => void) | undefined> = {};
    return { posted: [] as { n?: number; key?: boolean; type?: string }[], postMessage(m: unknown) { this.posted.push(m as never); }, close() {}, start() {},
      on(event: string, next: (message: { data: unknown }) => void) { listeners[event] = next; },
      say(data: unknown) { listeners["message"]?.({ data }); }, gone() { listeners["close"]?.({ data: undefined }); },
      chunks() { return this.posted.filter((m) => m.n !== undefined).map((m) => `${m.n}${m.key ? "k" : ""}`); } };
  };
  const delta: PreviewFrame = { ...frame, key: false, description: null };

  it("posts at most three chunks the page has not drawn, then holds deltas until a key frame it asks for once the page catches up (plan 084)", () => {
    const port = new Port();
    const { engine, send } = withPreview();
    const requestPreviewKey = vi.fn(() => true);
    new NativeHost(port, { ...engine, requestPreviewKey }, () => undefined);
    const studio = answeringPort();
    port.deliver({ type: PREVIEW_PORT_MESSAGE }, [studio]);
    // A new port's page starts at a key frame: deltas before it are not posted.
    send(delta);
    send(frame);
    send(delta);
    send(delta);
    // Three outstanding: the page stalled.
    send(delta);
    send(frame);
    expect(studio.chunks()).toEqual(["1k", "2", "3"]);
    expect(requestPreviewKey).not.toHaveBeenCalled();
    // The page drew the first: below the limit, but the stream has a gap, so a key frame is asked for, once.
    studio.say({ type: "drawn", through: 1 });
    studio.say({ type: "drawn", through: 1 });
    expect(requestPreviewKey).toHaveBeenCalledTimes(1);
    send(delta);
    send(frame);
    // Two still outstanding and the key frame make three again: the delta after it is held.
    send(delta);
    expect(studio.chunks()).toEqual(["1k", "2", "3", "4k"]);
    studio.say({ type: "drawn", through: 4 });
    expect(requestPreviewKey).toHaveBeenCalledTimes(2);
    send(frame);
    send(delta);
    expect(studio.chunks()).toEqual(["1k", "2", "3", "4k", "5k", "6"]);
    // Malformed acknowledgements are refused.
    studio.say({ type: "drawn", through: -1 });
    studio.say({ type: "drawn", through: "6" });
    send(delta);
    expect(studio.chunks()).toHaveLength(7);
    expect(requestPreviewKey).toHaveBeenCalledTimes(2);
  });

  it("holds beyond 512 KiB outstanding, but posts a single larger chunk when none is (plan 084)", () => {
    const port = new Port();
    const { engine, send } = withPreview();
    new NativeHost(port, { ...engine, requestPreviewKey: () => true }, () => undefined);
    const studio = answeringPort();
    port.deliver({ type: PREVIEW_PORT_MESSAGE }, [studio]);
    send({ ...frame, data: new Uint8Array(600 * 1024) });
    send(delta);
    expect(studio.chunks()).toEqual(["1k"]);
    studio.say({ type: "drawn", through: 1 });
    send({ ...frame, data: new Uint8Array(300 * 1024) });
    // 600 KiB would be outstanding: held, and the stream waits for a key frame.
    send({ ...delta, data: new Uint8Array(300 * 1024) });
    send(delta);
    expect(studio.chunks()).toEqual(["1k", "2k"]);
    studio.say({ type: "drawn", through: 2 });
    send({ ...frame, data: new Uint8Array(200 * 1024) });
    send({ ...delta, data: new Uint8Array(200 * 1024) });
    send({ ...delta, data: new Uint8Array(111 * 1024) });
    expect(studio.chunks()).toEqual(["1k", "2k", "3k", "4", "5"]);
  });

  it("asks for a key frame at once when the page dropped its decoder, and again every two frame times until one is posted (plan 084)", () => {
    vi.useFakeTimers();
    try {
      const port = new Port();
      const { engine, send } = withPreview();
      const requestPreviewKey = vi.fn(() => true);
      new NativeHost(port, { ...engine, requestPreviewKey }, () => undefined);
      const studio = answeringPort();
      port.deliver({ type: PREVIEW_PORT_MESSAGE }, [studio]);
      studio.say({ type: "rate", fps: 15 });
      send(frame);
      send(delta);
      // A decoding error: the page is done with both and waits for a key frame; the deltas after are not posted.
      studio.say({ type: "drawn", through: 2, key: true });
      expect(requestPreviewKey).toHaveBeenCalledTimes(1);
      send(delta);
      expect(studio.chunks()).toEqual(["1k", "2"]);
      // napi's gate dropped the key frame asked for: asked again two frame times later, and again.
      vi.advanceTimersByTime(132);
      expect(requestPreviewKey).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2);
      expect(requestPreviewKey).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(134);
      expect(requestPreviewKey).toHaveBeenCalledTimes(3);
      send(frame);
      vi.advanceTimersByTime(10_000);
      expect(requestPreviewKey).toHaveBeenCalledTimes(3);
      expect(studio.chunks()).toEqual(["1k", "2", "3k"]);
      // A malformed flag is refused whole.
      studio.say({ type: "drawn", through: 3, key: false });
      expect(requestPreviewKey).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops asking for a key frame once the preview is not watched, which the engine answers false (plan 084)", () => {
    vi.useFakeTimers();
    try {
      const port = new Port();
      const { engine, send } = withPreview();
      let watched = true;
      const requestPreviewKey = vi.fn(() => watched);
      new NativeHost(port, { ...engine, requestPreviewKey }, () => undefined);
      const studio = answeringPort();
      port.deliver({ type: PREVIEW_PORT_MESSAGE }, [studio]);
      send(frame);
      studio.say({ type: "drawn", through: 1, key: true });
      expect(requestPreviewKey).toHaveBeenCalledTimes(1);
      // The Studio's preview turned Off while the meters keep the port.
      watched = false;
      vi.advanceTimersByTime(200);
      expect(requestPreviewKey).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(60_000);
      expect(requestPreviewKey).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("posts nothing more once the page's end closed, and starts afresh on a new port (plan 084)", () => {
    const port = new Port();
    const { engine, send } = withPreview();
    new NativeHost(port, { ...engine, requestPreviewKey: () => true }, () => undefined);
    const first = answeringPort(), second = answeringPort();
    port.deliver({ type: PREVIEW_PORT_MESSAGE }, [first]);
    send(frame);
    send(delta);
    first.gone();
    send(frame);
    expect(first.chunks()).toEqual(["1k", "2"]);
    port.deliver({ type: PREVIEW_PORT_MESSAGE }, [second]);
    // Nothing is outstanding on the new port, whatever the old page left undrawn.
    for (const f of [frame, delta, delta]) send(f);
    expect(second.chunks()).toEqual(["3k", "4", "5"]);
    // An older page's close is not the new one's.
    first.gone();
    send(delta);
    expect(second.chunks()).toHaveLength(3);
  });

  it("takes the engine's preview frames in any case, which the engine makes only while main says they are watched (step 7)", async () => {
    const { engine } = withPreview();
    const setCameraPreview = vi.fn(() => true);
    const port = new Port();
    const logs: string[] = [];
    new NativeHost(port, { ...engine, setCameraPreview }, (line) => logs.push(line));
    expect(engine.onPreview).toHaveBeenCalledTimes(1);
    port.deliver({ type: "start", sessionId: "s1", quality: DEFAULT_QUALITY, native: { ...native, camera: { width: 0.2, height: 0.2, rounding: 1, x: 0.97, y: 0.95, mirror: false } } });
    await flush();
    expect(engine.prepare).toHaveBeenCalledWith(expect.objectContaining({ camera: expect.objectContaining({ preview: false }) }));
    port.deliver({ type: "cameraPreview", sessionId: "s1", watching: true });
    port.deliver({ type: "cameraPreview", sessionId: "other", watching: false });
    port.deliver({ type: "cameraPreview", sessionId: "s1", watching: false });
    expect(setCameraPreview.mock.calls).toEqual([[true], [false]]);
    expect(logs).toContainEqual("camera preview: watched");
  });
});

describe("developmentCapture", () => {
  it("reads a window, an area or apps, and whose sound, and ignores anything else", () => {
    expect(developmentCapture({})).toEqual({});
    expect(developmentCapture({ RECORDSTUFF_CAPTURE_SOURCE: "window:1234" })).toEqual({ source: { kind: "window", windowId: 1234 } });
    expect(developmentCapture({ RECORDSTUFF_CAPTURE_SOURCE: "area:10,20,640,360" })).toEqual({ source: { kind: "area", area: { x: 10, y: 20, width: 640, height: 360 } } });
    expect(developmentCapture({ RECORDSTUFF_CAPTURE_SOURCE: "apps:5,6", RECORDSTUFF_CAPTURE_AUDIO: "apps:5" })).toEqual({
      source: { kind: "apps", pids: [5, 6] }, audio: { system: "apps", pids: [5], microphone: false },
    });
    expect(developmentCapture({ RECORDSTUFF_CAPTURE_AUDIO: "off" })).toEqual({ audio: { system: "off", microphone: false } });
    // Editable recordings are a setting now (plan 087), carried by `start`: the former switch is no switch.
    expect(developmentCapture({ RECORDSTUFF_CAPTURE_EDITABLE: "1" })).toEqual({});
    for (const value of ["window:", "area:1,2,3", "apps:x", "display", "window:-1"]) {
      expect(developmentCapture({ RECORDSTUFF_CAPTURE_SOURCE: value })).toEqual({});
    }
  });
});

describe("NativeHost", () => {
  it("asks the engine for an editable recording only when main's start says so, and logs it (plan 087)", async () => {
    const today = await prepared();
    expect(Object.keys(today.engine.prepare.mock.calls[0]![0])).not.toContain("editable");

    const port = new Port();
    const fake = fakeEngine();
    const logs: string[] = [];
    new NativeHost(port, fake.factory, (line) => logs.push(line));
    port.deliver({ type: "start", sessionId: "s1", quality: DEFAULT_QUALITY, native: { ...native, editable: true } });
    await flush();
    expect(fake.engine.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ editable: true }));
    expect(logs.some((line) => line.startsWith("editable recording (plan 087)"))).toBe(true);
  });

  describe("the microphone (plan 074)", () => {
    const start = (port: Port, microphone?: NativeStart["microphone"]) =>
      port.deliver({ type: "start", sessionId: "s1", quality: DEFAULT_QUALITY, native: { ...native, ...(microphone ? { microphone } : {}) } });

    it("leaves the engine's sound as it was when the microphone is off or absent", async () => {
      for (const microphone of [undefined, { enabled: false, deviceId: "mic" }]) {
        const port = new Port();
        const fake = fakeEngine();
        new NativeHost(port, fake.factory, () => undefined);
        start(port, microphone);
        await flush();
        expect(Object.keys(fake.engine.prepare.mock.calls[0]![0])).not.toContain("audio");
      }
    });

    it("mixes the default input, or the chosen one, into the system's sound and keeps a development switch's", async () => {
      const port = new Port();
      const fake = fakeEngine();
      new NativeHost(port, fake.factory, () => undefined);
      start(port, { enabled: true });
      await flush();
      expect(fake.engine.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ audio: { system: "all", microphone: true } }));

      const chosen = new Port();
      const other = fakeEngine();
      new NativeHost(chosen, other.factory, () => undefined, undefined, { audio: { system: "off", microphone: false } });
      start(chosen, { enabled: true, deviceId: "usb-mic" });
      await flush();
      expect(other.engine.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ audio: { system: "off", microphone: true, microphoneId: "usb-mic" } }));
    });

    it("reports the microphone the engine opened in the capture report, and none without one", async () => {
      const port = new Port();
      const fake = fakeEngine();
      fake.engine.prepare.mockImplementationOnce(async (options) => ({ width: options.width, height: options.height, sampleRate: 48_000, channelCount: 2,
        primingFrames: 2112, excludedApps: 0, hiddenWindows: 0, timings: "", microphone: "MacBook Pro Microphone",
        warnings: ["microphone: usb-mic is not connected; the default input is used"] }) as never);
      new NativeHost(port, fake.factory, () => undefined);
      start(port, { enabled: true, deviceId: "usb-mic" });
      await flush();
      expect(port.sent.at(-1)).toMatchObject({ type: "prepared", capture: { microphone: "MacBook Pro Microphone",
        warnings: expect.arrayContaining(["microphone: usb-mic is not connected; the default input is used"]) } });
      const { port: plain } = await prepared();
      expect(plain.sent.at(-1)).toMatchObject({ type: "prepared" });
      expect((plain.sent.at(-1) as { capture: object }).capture).not.toHaveProperty("microphone");
    });

    it("refuses before prepared when the engine cannot open the microphone", async () => {
      const port = new Port();
      const fake = fakeEngine();
      fake.engine.prepare.mockRejectedValueOnce(new Error("microphone_unavailable|microphone: device usb-mic is not connected"));
      new NativeHost(port, fake.factory, () => undefined);
      start(port, { enabled: true, deviceId: "usb-mic" });
      await flush();
      expect(port.sent.at(-1)).toEqual({ type: "error", sessionId: "s1", code: "microphone_unavailable", detail: "microphone: device usb-mic is not connected" });
      fake.engine.prepare.mockRejectedValueOnce(new Error("camera_unavailable|camera: access is not allowed (status 2)"));
      port.deliver({ type: "start", sessionId: "s2", quality: DEFAULT_QUALITY, native });
      await flush();
      expect(port.sent.at(-1)).toEqual({ type: "error", sessionId: "s2", code: "camera_unavailable", detail: "camera: access is not allowed (status 2)" });
      expect(port.sent.some((message) => message.type === "prepared")).toBe(false);
    });

    it("answers a cancel while the microphone opens with stopped, and releases what was prepared", async () => {
      const port = new Port();
      const fake = fakeEngine();
      let opened: () => void = () => undefined;
      fake.engine.prepare.mockImplementationOnce((options) => new Promise((resolve) => {
        opened = () => resolve({ width: options.width, height: options.height, sampleRate: 48_000, channelCount: 2, primingFrames: 2112, excludedApps: 0, hiddenWindows: 0, warnings: [], timings: "" });
      }));
      new NativeHost(port, fake.factory, () => undefined);
      start(port, { enabled: true });
      await flush();
      port.deliver({ type: "stop", sessionId: "s1" });
      opened();
      await flush();
      expect(fake.engine.cancel).toHaveBeenCalledTimes(1);
      expect(port.sent.at(-1)).toMatchObject({ type: "stopped", sessionId: "s1" });
      expect(port.sent.some((message) => message.type === "prepared")).toBe(false);
    });

    it("tells main the microphone was lost and keeps recording", async () => {
      const { port, engine, emit } = await prepared();
      port.deliver({ type: "record", sessionId: "s1" });
      emit({ kind: "microphoneLost", detail: "the microphone delivered no sound for 2 s" });
      expect(port.sent.at(-1)).toEqual({ type: "microphoneLost", sessionId: "s1", detail: "the microphone delivered no sound for 2 s" });
      emit({ kind: "microphoneResumed", detail: "the microphone delivered sound again after 2.4 s" });
      expect(port.sent.at(-1)).toEqual({ type: "microphoneResumed", sessionId: "s1", detail: "the microphone delivered sound again after 2.4 s" });
      expect(engine.stop).not.toHaveBeenCalled();
      expect(port.sent.some((message) => message.type === "error")).toBe(false);
    });

    it("lists the inputs when idle and refuses while a session holds the engine", async () => {
      const port = new Port();
      const fake = fakeEngine();
      new NativeHost(port, fake.factory, () => undefined);
      port.deliver({ type: "listMicrophones" });
      await flush();
      expect(port.sent.at(-1)).toEqual({ type: "microphones", devices: [{ id: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", default: true }] });
      // The engine marks a built-in input with the lid closed (plan 089, D2); the mark goes on to main.
      fake.engine.microphones.mockResolvedValueOnce([{ id: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", default: true, lidClosed: true }]);
      port.deliver({ type: "listMicrophones" });
      await flush();
      expect(port.sent.at(-1)).toEqual({ type: "microphones", devices: [{ id: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", default: true, lidClosed: true }] });
      fake.engine.microphones.mockRejectedValueOnce(new Error("capture_start_failed|AVFoundation has no audio media type"));
      port.deliver({ type: "listMicrophones" });
      await flush();
      expect(port.sent.at(-1)).toEqual({ type: "microphones", error: "AVFoundation has no audio media type" });
      start(port);
      await flush();
      port.deliver({ type: "listMicrophones" });
      await flush();
      expect(port.sent.at(-1)).toEqual({ type: "microphones", error: "a recording is in progress" });
    });
  });

  it("probes and prepares the development source and sound when they are set, and logs them", async () => {
    const port = new Port();
    const fake = fakeEngine();
    const logs: string[] = [];
    const source = { kind: "area" as const, area: { x: 0, y: 0, width: 800, height: 450 } };
    new NativeHost(port, fake.factory, (line) => logs.push(line), undefined, { source, audio: { system: "off", microphone: false } });
    port.deliver({ type: "start", sessionId: "s1", quality: DEFAULT_QUALITY, native });
    await flush();
    expect(fake.engine.probe).toHaveBeenCalledWith(1, undefined, source);
    expect(fake.engine.prepare).toHaveBeenCalledWith(expect.objectContaining({ source, audio: { system: "off", microphone: false } }));
    expect(logs[0]).toContain("development capture: source");
  });

  it("logs audio that arrived too late to mix", async () => {
    const { port, engine, logs } = await prepared();
    engine.stop.mockResolvedValueOnce({ drainMs: 1, drainPaddedFrames: 0, frameLeadAvgMs: 0, frameLeadMaxMs: 0, lateAudioFrames: [0, 480] } as never);
    port.deliver({ type: "record", sessionId: "s1" });
    port.deliver({ type: "stop", sessionId: "s1" });
    await flush();
    expect(logs.find((line) => line.startsWith("timing: stop"))).toContain("audio frames too late to mix, by input: 0, 480");
  });

  it("logs the audio kept on the clock and the samples the limiter changed, and nothing when there were none", async () => {
    const { port, engine, logs } = await prepared();
    engine.stop.mockResolvedValueOnce({ drainMs: 1, drainPaddedFrames: 0, frameLeadAvgMs: 0, frameLeadMaxMs: 0,
      insertedAudioFrames: [0, 31], droppedAudioFrames: [0, 2], limitedAudioSamples: 96 } as never);
    port.deliver({ type: "record", sessionId: "s1" });
    port.deliver({ type: "stop", sessionId: "s1" });
    await flush();
    const line = logs.find((entry) => entry.startsWith("timing: stop"));
    expect(line).toContain("audio kept on the clock, by input: 0, 31 frame(s) of silence inserted, 0, 2 dropped");
    expect(line).toContain("96 sample(s) of two inputs limited below full scale");
    expect(logs.filter((entry) => entry.startsWith("timing: stop")).length).toBe(1);
  });

  it("logs a sound encoder's failure at the stop, and still finishes the file", async () => {
    const { port, engine, logs } = await prepared();
    engine.stop.mockResolvedValueOnce({ drainMs: 1, drainPaddedFrames: 0, frameLeadAvgMs: 0, frameLeadMaxMs: 0, audioFailure: "encode failed (-50)" } as never);
    port.deliver({ type: "record", sessionId: "s1" });
    port.deliver({ type: "stop", sessionId: "s1" });
    await flush();
    expect(logs).toContain("recording: the sound's encoder failed at the stop, so the sound ends early: encode failed (-50)");
    expect(port.sent.some((message) => (message as { type: string }).type === "stopped")).toBe(true);
  });

  it("prepares within the cap the setting names, at the setting's bit rate, and reports the capture", async () => {
    const { port, engine } = await prepared();
    expect(port.sent[0]).toEqual({ type: "ready" });
    // A 3456x2234 display capped at 1080p keeps its aspect ratio.
    expect(engine.prepare).toHaveBeenCalledWith(expect.objectContaining({
      displayId: 1, width: 1670, height: 1080, frameRate: 30, audioBitrate: 256_000,
      ownPids: [10, 11], hideSystemUi: false, path: "/out/a.recording.mp4",
    }));
    expect(port.sent[1]).toMatchObject({ type: "prepared", sessionId: "s1", mimeType: expect.stringContaining("video/mp4"),
      capture: { width: 1670, height: 1080, frameRate: 30, sampleRate: 48_000, channelCount: 2, audioBitsPerSecond: 256_000 } });
  });

  it("leaves the display point out when main gave none: the engine refuses null for it", async () => {
    const { engine } = await prepared();
    expect(engine.probe).toHaveBeenCalledWith(1, undefined);
    expect(Object.keys(engine.prepare.mock.calls[0]![0])).not.toContain("displayPoint");
  });

  it("logs where preparing, record and stop spent their time", async () => {
    const { port, logs } = await prepared();
    port.deliver({ type: "record", sessionId: "s1" });
    port.deliver({ type: "stop", sessionId: "s1" });
    await flush();
    expect(logs[0]).toMatch(/^timing: probe \d+ ms, prepare \d+ ms \(content 0 ms, first frame 12 ms; total 40 ms\)$/);
    expect(logs[1]).toMatch(/^timing: record \d+\.\d ms$/);
    expect(logs[2]).toMatch(/^timing: stop \d+ ms \(sound up to the stop 31 ms, 0 frame\(s\) filled with silence; frames stamped 4\.2 ms ahead on average, 9\.0 ms at most\)$/);
    expect(logs[3]).toBe("timing: file finished 4 ms after the stop");
  });

  it("records only the prepared session, then reports the stop before the finished file", async () => {
    const { port, engine } = await prepared();
    port.deliver({ type: "record", sessionId: "other" });
    expect(port.sent.at(-1)).toMatchObject({ type: "error", sessionId: "other", code: "capture_start_failed" });
    port.deliver({ type: "record", sessionId: "s1" });
    expect(engine.record).toHaveBeenCalledTimes(1);
    expect(port.sent.at(-1)).toEqual({ type: "started", sessionId: "s1" });
    let finished: (file: { bytes: number; finalizeMs: number; fragmented?: string | null }) => void = () => undefined;
    engine.finish.mockImplementationOnce(() => new Promise((resolve) => { finished = resolve; }));
    port.deliver({ type: "stop", sessionId: "s1" });
    await flush();
    // Capture has ended; the file is still being finished.
    expect(port.sent.at(-1)).toMatchObject({ type: "stopped", sessionId: "s1" });
    expect(port.sent.at(-1)).not.toHaveProperty("file");
    finished({ bytes: 1234, finalizeMs: 4, fragmented: null });
    await flush();
    expect(port.sent.at(-1)).toEqual({ type: "finished", sessionId: "s1", file: { bytes: 1234, finalizeMs: 4 } });
  });

  it("reports why the file stayed fragmented", async () => {
    const { port, engine } = await prepared();
    engine.finish.mockResolvedValueOnce({ bytes: 9, finalizeMs: 2, fragmented: "index not written: EIO" });
    port.deliver({ type: "record", sessionId: "s1" });
    port.deliver({ type: "stop", sessionId: "s1" });
    await flush();
    expect(port.sent.at(-1)).toEqual({ type: "finished", sessionId: "s1", file: { bytes: 9, finalizeMs: 2, fragmented: "index not written: EIO" } });
  });

  it("ignores engine events once stopped: the file's outcome is what finish answers", async () => {
    const { port, engine, emit } = await prepared();
    engine.finish.mockImplementationOnce(() => new Promise(() => undefined));
    port.deliver({ type: "record", sessionId: "s1" });
    port.deliver({ type: "stop", sessionId: "s1" });
    await flush();
    const sent = port.sent.length;
    emit({ kind: "writeError", code: "disk_full", detail: "No space left" });
    expect(port.sent).toHaveLength(sent);
  });

  it("turns engine events into progress, write errors and capture errors of the current session", async () => {
    const { port, emit } = await prepared();
    port.deliver({ type: "record", sessionId: "s1" });
    emit({ kind: "progress", bytes: 2048 });
    emit({ kind: "writeError", code: "disk_full", detail: "No space left" });
    emit({ kind: "captureError", code: "capture_failed", detail: "display gone" });
    expect(port.sent.slice(-3)).toEqual([
      { type: "progress", sessionId: "s1", bytes: 2048 },
      { type: "writeError", sessionId: "s1", code: "disk_full", detail: "No space left" },
      { type: "error", sessionId: "s1", code: "capture_failed", detail: "display gone" },
    ]);
  });

  it("reports a failed finish after the stop as a write error, with the engine's code", async () => {
    const { port, engine } = await prepared();
    engine.finish.mockRejectedValueOnce(new Error("disk_full|finish failed: No space left"));
    port.deliver({ type: "record", sessionId: "s1" });
    port.deliver({ type: "stop", sessionId: "s1" });
    await flush();
    expect(port.sent.slice(-2)).toEqual([
      expect.objectContaining({ type: "stopped", sessionId: "s1" }),
      { type: "writeError", sessionId: "s1", code: "disk_full", detail: "finish failed: No space left" },
    ]);
  });

  it("reports a stop the engine refused as a capture failure", async () => {
    const { port, engine } = await prepared();
    engine.stop.mockRejectedValueOnce(new Error("capture_failed|gone"));
    port.deliver({ type: "record", sessionId: "s1" });
    port.deliver({ type: "stop", sessionId: "s1" });
    await flush();
    expect(port.sent.at(-1)).toEqual({ type: "error", sessionId: "s1", code: "capture_failed", detail: "gone" });
    expect(engine.finish).not.toHaveBeenCalled();
  });

  it("cancels a prepared session at stop without recording", async () => {
    const { port, engine } = await prepared();
    port.deliver({ type: "stop", sessionId: "s1" });
    await flush();
    expect(engine.cancel).toHaveBeenCalledTimes(1);
    expect(engine.stop).not.toHaveBeenCalled();
    expect(port.sent.at(-1)).toMatchObject({ type: "stopped", sessionId: "s1" });
  });

  it("releases capture that finished preparing after main gave up, and never reports it prepared", async () => {
    const port = new Port();
    const fake = fakeEngine();
    let finish: () => void = () => undefined;
    fake.engine.prepare.mockImplementationOnce(async (options) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { width: options.width, height: options.height, sampleRate: 48_000, channelCount: 2, primingFrames: 0, excludedApps: 1, hiddenWindows: 0, warnings: [], timings: "" };
    });
    new NativeHost(port, fake.factory, () => undefined);
    port.deliver({ type: "start", sessionId: "s1", quality: DEFAULT_QUALITY, native });
    await flush();
    port.deliver({ type: "stop", sessionId: "s1" });
    finish();
    await flush();
    expect(fake.engine.cancel).toHaveBeenCalledTimes(1);
    expect(port.sent.map((m) => m.type)).toEqual(["ready", "stopped"]);
  });

  it("answers whether macOS lets the engine capture, by its probe, and not while a session holds the engine (plan 089, D1)", async () => {
    const port = new Port();
    const fake = fakeEngine();
    new NativeHost(port, fake.factory, () => undefined);
    port.deliver({ type: "checkScreenAccess", displayId: 3 });
    await flush();
    expect(fake.engine.probe).toHaveBeenCalledWith(3);
    expect(port.sent.at(-1)).toEqual({ type: "screenAccess", answer: "granted" });
    fake.engine.probe.mockRejectedValueOnce(new Error("permission_denied|The user declined TCCs (-3801)"));
    port.deliver({ type: "checkScreenAccess", displayId: 3 });
    await flush();
    expect(port.sent.at(-1)).toEqual({ type: "screenAccess", answer: "denied", detail: "The user declined TCCs (-3801)" });
    fake.engine.probe.mockRejectedValueOnce(new Error("no_display|display 9 is not available for capture"));
    port.deliver({ type: "checkScreenAccess", displayId: 9 });
    await flush();
    expect(port.sent.at(-1)).toEqual({ type: "screenAccess", answer: "unknown", detail: "display 9 is not available for capture" });
    port.deliver({ type: "start", sessionId: "s1", quality: DEFAULT_QUALITY, native });
    await flush();
    const probes = fake.engine.probe.mock.calls.length;
    port.deliver({ type: "checkScreenAccess", displayId: 3 });
    await flush();
    expect(fake.engine.probe).toHaveBeenCalledTimes(probes);
    expect(port.sent.at(-1)).toEqual({ type: "screenAccess", answer: "unknown", detail: "a recording is in progress" });
  });

  it("probes for a start only after the access check in flight, so prepare never takes the check's content (plan 089)", async () => {
    const port = new Port();
    const fake = fakeEngine();
    const order: string[] = [];
    let answer!: () => void;
    fake.engine.probe.mockImplementationOnce(() => new Promise((resolve) => { answer = () => { order.push("access probe done"); resolve({ width: 1, height: 1 }); }; }));
    fake.engine.probe.mockImplementation(async () => { order.push("start probe"); return { width: 3456, height: 2234 }; });
    fake.engine.prepare.mockImplementation(async (options) => { order.push("prepare"); return { width: options.width, height: options.height, sampleRate: 48_000, channelCount: 2, primingFrames: 2112, excludedApps: 2, hiddenWindows: 0, warnings: [], timings: "" }; });
    new NativeHost(port, fake.factory, () => undefined);
    port.deliver({ type: "checkScreenAccess", displayId: 1 });
    port.deliver({ type: "start", sessionId: "s1", quality: DEFAULT_QUALITY, native });
    await flush();
    expect(order).toEqual([]);
    answer();
    await flush();
    expect(order).toEqual(["access probe done", "start probe", "prepare"]);
    expect(port.sent.map((m) => m.type)).toEqual(["ready", "screenAccess", "prepared"]);
  });

  it("maps a refused prepare to its host error code", async () => {
    const port = new Port();
    const fake = fakeEngine();
    fake.engine.probe.mockRejectedValueOnce(new Error("permission_denied|The user declined TCCs (-3801)"));
    new NativeHost(port, fake.factory, () => undefined);
    port.deliver({ type: "start", sessionId: "s1", quality: DEFAULT_QUALITY, native });
    await flush();
    expect(port.sent.at(-1)).toEqual({ type: "error", sessionId: "s1", code: "permission_denied", detail: "The user declined TCCs (-3801)" });
  });

  it("answers pings, and refuses a start without the native options or while busy", async () => {
    const { port } = await prepared();
    port.deliver({ type: "ping" });
    expect(port.sent.at(-1)).toEqual({ type: "pong" });
    port.deliver({ type: "start", sessionId: "s2", quality: DEFAULT_QUALITY, native });
    await flush();
    expect(port.sent.at(-1)).toMatchObject({ type: "error", sessionId: "s2", detail: "a recording is already in progress" });
    port.deliver({ type: "start", sessionId: "s3", quality: DEFAULT_QUALITY });
    expect(port.sent.at(-1)).toMatchObject({ type: "error", sessionId: "s3", code: "capture_start_failed" });
  });
});

describe("Settings' microphone monitor and switching while recording (plan 079)", () => {
  type MonitorEvent = { kind: string; peak?: number; rms?: number; detail?: string; from?: string; to?: string };

  function monitor() {
    const port = new Port();
    let emit: (event: MonitorEvent) => void = () => undefined;
    let resolveStart: ((name: string) => void) | undefined;
    const engine = {
      ...fakeEngine().engine,
      watchDevices: vi.fn(),
      startMeter: vi.fn((_device?: string) => new Promise<string>((resolve) => { resolveStart = resolve; })),
      stopMeter: vi.fn(),
      setMicrophone: vi.fn((_device?: string) => true),
    };
    const logs: string[] = [];
    new NativeHost(port, (onEvent) => { emit = onEvent as (event: MonitorEvent) => void; return engine; }, (line) => logs.push(line));
    return { port, engine, logs, emit: (event: MonitorEvent) => emit(event), started: (name: string) => resolveStart?.(name) };
  }

  it("follows the device list and lists the inputs once a burst of changes settles", async () => {
    vi.useFakeTimers();
    try {
      const { port, engine, emit } = monitor();
      port.deliver({ type: "watchDevices", watching: true });
      expect(engine.watchDevices).toHaveBeenCalledWith(true);
      // What is connected when the watch begins.
      await vi.advanceTimersByTimeAsync(300);
      expect(engine.microphones).toHaveBeenCalledTimes(1);
      engine.microphones.mockClear();
      emit({ kind: "devices" });
      emit({ kind: "devices" });
      await vi.advanceTimersByTimeAsync(299);
      expect(engine.microphones).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(engine.microphones).toHaveBeenCalledTimes(1);
      expect(port.sent.at(-1)).toEqual({ type: "microphones", devices: [{ id: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", default: true }] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the meter on the device asked for, passes its levels, and stops it", async () => {
    const { port, engine, emit, started } = monitor();
    port.deliver({ type: "meter", watching: true, deviceId: "usb" });
    await flush();
    expect(engine.startMeter).toHaveBeenCalledWith("usb");
    // Levels before the meter answers are not this meter's.
    emit({ kind: "meter", peak: 0.5, rms: 0.3 });
    started("USB Microphone");
    await flush();
    emit({ kind: "meter", peak: 0.5, rms: 0.3 });
    expect(port.sent).toEqual([{ type: "ready" }, { type: "meterStarted", device: "USB Microphone" }, { type: "meterLevel", peak: 0.5, rms: 0.3 }]);
    port.deliver({ type: "meter", watching: false });
    await flush();
    expect(engine.stopMeter).toHaveBeenCalledTimes(1);
  });

  it("stops a meter that a stop overtook while it opened", async () => {
    const { port, engine, started } = monitor();
    port.deliver({ type: "meter", watching: true });
    await flush();
    port.deliver({ type: "meter", watching: false });
    started("MacBook Pro Microphone");
    await flush();
    await flush();
    expect(engine.stopMeter).toHaveBeenCalledTimes(1);
    expect(port.sent.some((message) => message.type === "meterStarted")).toBe(false);
  });

  it("tells main a meter that could not start or lost its device", async () => {
    const { port, engine, emit } = monitor();
    engine.startMeter.mockRejectedValueOnce(new Error("microphone_unavailable|microphone: access is not allowed"));
    port.deliver({ type: "meter", watching: true });
    await flush();
    await flush();
    expect(port.sent.at(-1)).toEqual({ type: "meterStopped", error: "microphone: access is not allowed" });
    emit({ kind: "meterLost", detail: "FreeClip 2 stopped being read (the device is gone)" });
    expect(port.sent.at(-1)).toEqual({ type: "meterStopped", error: "FreeClip 2 stopped being read (the device is gone)" });
  });

  it("switches the recording's microphone and reports the engine's outcome for the session", async () => {
    const { port, engine, emit } = monitor();
    port.deliver({ type: "start", sessionId: "s1", quality: DEFAULT_QUALITY, native: { ...native, microphone: { enabled: true } } });
    await flush();
    port.deliver({ type: "microphone", sessionId: "other", deviceId: "usb" });
    expect(engine.setMicrophone).not.toHaveBeenCalled();
    port.deliver({ type: "microphone", sessionId: "s1", deviceId: "usb" });
    expect(engine.setMicrophone).toHaveBeenCalledWith("usb");
    emit({ kind: "microphoneSwitched", from: "MacBook Pro Microphone", to: "USB Microphone" });
    emit({ kind: "microphoneSwitchFailed", detail: "microphone: usb is not connected; USB Microphone goes on being recorded" });
    expect(port.sent.slice(-2)).toEqual([
      { type: "microphoneSwitched", sessionId: "s1", from: "MacBook Pro Microphone", to: "USB Microphone" },
      { type: "microphoneSwitchFailed", sessionId: "s1", detail: "microphone: usb is not connected; USB Microphone goes on being recorded" },
    ]);
    // A session without a microphone says so rather than staying silent.
    engine.setMicrophone.mockReturnValueOnce(false);
    port.deliver({ type: "microphone", sessionId: "s1" });
    expect(port.sent.at(-1)).toEqual({ type: "microphoneSwitchFailed", sessionId: "s1", detail: "this recording records no microphone" });
  });
});

describe("the pipeline's figures (plan 083)", () => {
  const engineFigures = `{"schema":1,"stages":{"write":{"n":2,"sum":40,"max":30,"b":{"16":1,"19":1}}},"counts":{"frames_submitted":2}}`;
  const studioPort = () => {
    let listener: ((message: { data: unknown }) => void) | undefined;
    return { posted: [] as unknown[], postMessage(m: unknown) { this.posted.push(m); }, close() {}, start() {},
      on(event: string, next: (message: { data: unknown }) => void) { if (event === "message") listener = next; },
      say(data: unknown) { listener?.({ data }); } };
  };
  const page = { type: "previewDiagnostics", schema: 1, received: 9, drawn: 8, missed: 1, notDecoded: 1, pendingHigh: 2, decodingHigh: 1, heapHigh: 9, restarts: { codec: 1, error: 0 },
    port: { n: 9, sum: 9000, max: 2000, b: { 39: 9 } }, decode: { n: 8, sum: 16_000, max: 3000, b: { 44: 8 } }, recover: { n: 0, sum: 0, max: 0, b: {} } };

  it("logs nothing and asks the page for nothing without the development switch", async () => {
    const port = new Port();
    const fake = fakeEngine();
    const diagnostics = vi.fn(() => engineFigures);
    const logs: string[] = [];
    new NativeHost(port, (onEvent) => ({ ...fake.factory(onEvent), diagnostics }), (line) => logs.push(line));
    const studio = studioPort();
    port.deliver({ type: PREVIEW_PORT_MESSAGE }, [studio]);
    studio.say(page);
    port.deliver({ type: "start", sessionId: "s1", quality: DEFAULT_QUALITY, native });
    await flush();
    port.deliver({ type: "record", sessionId: "s1" });
    port.deliver({ type: "stop", sessionId: "s1" });
    await flush();
    await flush();
    expect(studio.posted).toEqual([]);
    expect(diagnostics).not.toHaveBeenCalled();
    expect(logs.filter((line) => line.startsWith("diagnostics:"))).toEqual([]);
  });

  it("with it, asks the page every 5 s and logs the engine's figures once the file is finished and the page's as they come", async () => {
    const port = new Port();
    const fake = fakeEngine();
    let previewTo: (frame: PreviewFrame) => void = () => undefined;
    const engine = { ...fake.engine, diagnostics: vi.fn(() => engineFigures), onPreview: (onFrame: (frame: PreviewFrame) => void) => { previewTo = onFrame; } };
    const logs: string[] = [];
    new NativeHost(port, engine, (line) => logs.push(line), undefined, {}, false, true);
    const frame: PreviewFrame = { width: 640, height: 360, data: new Uint8Array(1), key: true, timestamp: 1 };
    // Before the session: not its figures.
    previewTo(frame);
    port.deliver({ type: "start", sessionId: "s1", quality: DEFAULT_QUALITY, native });
    await flush();
    previewTo(frame);
    const studio = studioPort();
    port.deliver({ type: PREVIEW_PORT_MESSAGE }, [studio]);
    expect(studio.posted).toEqual([{ type: "diagnostics", everyMs: 5000 }]);
    previewTo(frame);
    previewTo(frame);
    port.deliver({ type: "record", sessionId: "s1" });
    studio.say(page);
    studio.say({ ...page, schema: 2 });
    port.deliver({ type: "stop", sessionId: "s1" });
    await flush();
    await flush();
    // The page's last report comes after the session ended, as its port is let go: it is the last session's.
    studio.say({ ...page, received: 1 });
    const lines = logs.filter((line) => line.startsWith("diagnostics: ")).map((line) => JSON.parse(line.slice("diagnostics: ".length)) as Record<string, unknown>);
    expect(lines).toEqual([
      { kind: "page", session: "s1", schema: 1, received: 9, drawn: 8, missed: 1, notDecoded: 1, pendingHigh: 2, decodingHigh: 1, heapHigh: 9, restarts: { codec: 1, error: 0 }, port: page.port, decode: page.decode, recover: page.recover },
      { kind: "engine", schema: 1, session: "s1", outcome: "finished", host: { previewForwarded: 2, previewWithoutPort: 1, previewForwardedBytes: 2,
        previewHeld: 0, previewKeyRequests: 0, previewOutstandingHigh: 2, previewOutstandingBytesHigh: 2 }, engine: JSON.parse(engineFigures) },
      expect.objectContaining({ kind: "page", session: "s1", received: 1 }),
    ]);
  });

  it("logs a cancelled session's figures, and says so when the engine's cannot be read", async () => {
    const port = new Port();
    const fake = fakeEngine();
    const logs: string[] = [];
    new NativeHost(port, { ...fake.engine, diagnostics: () => "{not json" }, (line) => logs.push(line), undefined, {}, false, true);
    port.deliver({ type: "start", sessionId: "s2", quality: DEFAULT_QUALITY, native });
    await flush();
    port.deliver({ type: "stop", sessionId: "s2" });
    await flush();
    expect(fake.engine.cancel).toHaveBeenCalled();
    expect(logs.some((line) => line.startsWith("diagnostics: the engine's figures could not be read"))).toBe(true);
    expect(logs).toContainEqual(expect.stringContaining(`"kind":"engine","schema":1,"session":"s2","outcome":"cancelled"`));
  });

  it("logs a running session's figures every 5 s, since main ends a Live preview by ending the process, and stops at its end", async () => {
    vi.useFakeTimers();
    try {
      const port = new Port();
      const fake = fakeEngine();
      const logs: string[] = [];
      new NativeHost(port, { ...fake.engine, diagnostics: () => engineFigures }, (line) => logs.push(line), undefined, {}, false, true);
      port.deliver({ type: "start", sessionId: "p1", quality: DEFAULT_QUALITY, native });
      await vi.advanceTimersByTimeAsync(0);
      const outcomes = () => logs.filter((line) => line.includes(`"kind":"engine"`)).map((line) => /"outcome":"(\w+)"/.exec(line)?.[1]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(outcomes()).toEqual(["running", "running"]);
      port.deliver({ type: "stop", sessionId: "p1" });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(outcomes()).toEqual(["running", "running", "cancelled"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the Studio's stall switch (plan 084)", () => {
  const studioPort = () => ({ posted: [] as unknown[], postMessage(m: unknown) { this.posted.push(m); }, close() {}, start() {}, on() {} });

  it("asks each port's page to stall once, at the time the switch says, and never a port that was replaced", () => {
    vi.useFakeTimers();
    try {
      const port = new Port();
      const logs: string[] = [];
      new NativeHost(port, fakeEngine().engine, (line) => logs.push(line), undefined, {}, false, false, { atMs: 15_000, forMs: 30_000 });
      const first = studioPort(), second = studioPort();
      port.deliver({ type: PREVIEW_PORT_MESSAGE }, [first]);
      vi.advanceTimersByTime(10_000);
      port.deliver({ type: PREVIEW_PORT_MESSAGE }, [second]);
      vi.advanceTimersByTime(14_999);
      expect([first.posted, second.posted]).toEqual([[], []]);
      vi.advanceTimersByTime(1);
      expect([first.posted, second.posted]).toEqual([[], [{ type: "stall", ms: 30_000 }]]);
      vi.advanceTimersByTime(60_000);
      expect(second.posted).toHaveLength(1);
      expect(logs).toContainEqual(expect.stringContaining("studio: the page asked to stall for 30000 ms"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks nothing without the switch", () => {
    vi.useFakeTimers();
    try {
      const port = new Port();
      new NativeHost(port, fakeEngine().engine, () => undefined);
      const studio = studioPort();
      port.deliver({ type: PREVIEW_PORT_MESSAGE }, [studio]);
      vi.advanceTimersByTime(600_000);
      expect(studio.posted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
