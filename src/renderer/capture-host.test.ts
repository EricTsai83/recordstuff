/**
 * Drives the renderer's session machine with a fake MessagePort, a fake
 * `getDisplayMedia` and a fake `MediaRecorder`; no DOM needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTPUT_MIME_TYPE, type HostMessage, type MainMessage } from "../shared/protocol";
import { DEFAULT_QUALITY, type QualitySettings } from "../shared/quality";
import { CaptureHost, type CaptureHostOptions, type FrameSizeMeasurer, type HostPort } from "./capture-host";

class FakeTrack {
  stopped = false;
  readyState: "live" | "ended" = "live";
  settings: Record<string, number> = {};
  applied: MediaTrackConstraints[] = [];
  applyError: Error | undefined;
  private listeners: (() => void)[] = [];
  constructor(readonly kind: "video" | "audio") {
    this.settings = kind === "video" ? { width: 1920, height: 1080, frameRate: 30 } : { sampleRate: 48_000, channelCount: 2 };
  }
  stop(): void {
    this.stopped = true;
  }
  getSettings(): Record<string, number> {
    return this.settings;
  }
  async applyConstraints(constraints: MediaTrackConstraints): Promise<void> {
    if (this.applyError) throw this.applyError;
    this.applied.push(constraints);
    // Chromium scales the capture to the requested max while keeping the aspect ratio.
    const w = constraints.width as { max: number };
    const h = constraints.height as { max: number };
    this.settings = { ...this.settings, width: w.max, height: h.max };
  }
  addEventListener(_type: "ended", listener: () => void): void {
    this.listeners.push(listener);
  }
  end(): void {
    for (const l of this.listeners) l();
  }
}

class FakeStream {
  constructor(readonly tracks: FakeTrack[]) {}
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "video");
  }
}

class FakeMediaRecorder {
  static supported = true;
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(): boolean {
    return FakeMediaRecorder.supported;
  }
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(
    readonly stream: FakeStream,
    readonly options: { mimeType: string; videoBitsPerSecond?: number; audioBitsPerSecond?: number },
  ) {
    this.mimeType = options.mimeType;
    FakeMediaRecorder.instances.push(this);
  }
  start(): void {
    this.state = "recording";
  }
  stop(): void {
    this.state = "inactive";
    // Chromium flushes the last chunk before firing stop.
    this.ondataavailable?.({ data: new Blob([new Uint8Array([9])]) });
    this.onstop?.();
  }
  emitChunk(bytes: number[]): void {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) });
  }
}

class FakePort implements HostPort {
  sent: HostMessage[] = [];
  private listener: ((event: { data: unknown }) => void) | undefined;
  addEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
    this.listener = listener;
  }
  start(): void {}
  postMessage(message: unknown): void {
    this.sent.push(message as HostMessage);
  }
  receive(message: MainMessage): void {
    this.listener?.({ data: message });
  }
  types(): string[] {
    return this.sent.map((m) => m.type);
  }
}

let getDisplayMedia: ReturnType<typeof vi.fn>;
let pendingStream: { resolve: (s: FakeStream) => void; reject: (e: Error) => void } | undefined;

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.supported = true;
  pendingStream = undefined;
  getDisplayMedia = vi.fn(
    () =>
      new Promise<FakeStream>((resolve, reject) => {
        pendingStream = { resolve, reject };
      }),
  );
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });
});
afterEach(() => vi.unstubAllGlobals());

const flush = () => new Promise((r) => setTimeout(r, 0));
const stream = () => new FakeStream([new FakeTrack("video"), new FakeTrack("audio")]);
const start = (sessionId: string, quality: QualitySettings = DEFAULT_QUALITY): MainMessage => ({ type: "start", sessionId, quality });
/** The `started` report for a 1080p30 source at default quality. */
const DEFAULT_CAPTURE = {
  width: 1920,
  height: 1080,
  frameRate: 30,
  sampleRate: 48_000,
  channelCount: 2,
  videoBitsPerSecond: 8_100_000,
  audioBitsPerSecond: 256_000,
  warnings: [],
};

/** By default the frames are the size `getSettings()` claims; tests override this to model a lying track. */
const measureFromSettings: FrameSizeMeasurer = async (stream) => {
  const settings = (stream as unknown as FakeStream).getVideoTracks()[0]?.getSettings() ?? {};
  return settings["width"] !== undefined && settings["height"] !== undefined ? { width: settings["width"], height: settings["height"] } : undefined;
};

function boot(options: CaptureHostOptions = { measureFrameSize: measureFromSettings }): FakePort {
  const port = new FakePort();
  new CaptureHost(port, options);
  expect(port.types()).toEqual(["ready"]);
  port.sent = [];
  return port;
}

describe("renderer CaptureHost", () => {
  it("answers ping with pong", () => {
    const port = boot();
    port.receive({ type: "ping" });
    expect(port.types()).toEqual(["pong"]);
  });

  it("records: started, ordered chunks, stopped after the final chunk", async () => {
    const port = boot();
    port.receive(start("s1"));
    const s = stream();
    pendingStream!.resolve(s);
    await flush();
    expect(port.sent[0]).toEqual({ type: "started", sessionId: "s1", mimeType: OUTPUT_MIME_TYPE, capture: DEFAULT_CAPTURE });
    expect(FakeMediaRecorder.instances[0]!.options).toEqual({
      mimeType: OUTPUT_MIME_TYPE,
      videoBitsPerSecond: 8_100_000,
      audioBitsPerSecond: 256_000,
    });
    const rec = FakeMediaRecorder.instances[0]!;
    rec.emitChunk([1, 2]);
    rec.emitChunk([3]);
    port.receive({ type: "stop", sessionId: "s1" });
    await flush();
    await flush();
    expect(port.types()).toEqual(["started", "chunk", "chunk", "chunk", "stopped"]);
    const chunks = port.sent.filter((m) => m.type === "chunk");
    expect(chunks.map((c) => (c.type === "chunk" ? c.seq : -1))).toEqual([0, 1, 2]);
    expect(chunks.map((c) => (c.type === "chunk" ? Array.from(new Uint8Array(c.bytes)) : []))).toEqual([[1, 2], [3], [9]]);
    expect(s.tracks.every((t) => t.stopped)).toBe(true);
  });

  it("refuses when MP4 is unsupported and never asks for a stream", () => {
    FakeMediaRecorder.supported = false;
    const port = boot();
    port.receive(start("s1"));
    expect(port.sent[0]).toMatchObject({ type: "error", sessionId: "s1", code: "mp4_unsupported" });
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it("refuses a stream without an audio track and releases it", async () => {
    const port = boot();
    port.receive(start("s1"));
    const s = new FakeStream([new FakeTrack("video")]);
    pendingStream!.resolve(s);
    await flush();
    expect(port.sent[0]).toMatchObject({ type: "error", sessionId: "s1", code: "no_audio_track" });
    expect(s.tracks[0]!.stopped).toBe(true);
  });

  it("refuses an audio track that is already ended (macOS CoreAudio Tap without permission)", async () => {
    const port = boot();
    port.receive(start("s1"));
    const dead = new FakeTrack("audio");
    dead.readyState = "ended";
    const s = new FakeStream([new FakeTrack("video"), dead]);
    pendingStream!.resolve(s);
    await flush();
    expect(port.sent[0]).toMatchObject({ type: "error", sessionId: "s1", code: "no_audio_track" });
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(s.tracks.every((t) => t.stopped)).toBe(true);
  });

  it("maps getDisplayMedia errors to codes", async () => {
    const port = boot();
    port.receive(start("s1"));
    pendingStream!.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    await flush();
    expect(port.sent[0]).toMatchObject({ type: "error", code: "permission_denied" });
  });

  it("a stop that arrives while getDisplayMedia is pending cancels the session (review finding 1)", async () => {
    const port = boot();
    port.receive(start("s1"));
    port.receive({ type: "stop", sessionId: "s1" });
    const s = stream();
    pendingStream!.resolve(s);
    await flush();
    expect(s.tracks.every((t) => t.stopped)).toBe(true);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(port.types()).toEqual(["stopped"]);

    // and the host is free for the next session
    port.sent = [];
    port.receive(start("s2"));
    pendingStream!.resolve(stream());
    await flush();
    expect(port.sent[0]).toMatchObject({ type: "started", sessionId: "s2" });
  });

  it("a cancelled session still waiting on the OS does not block the next start (pass-2 finding 1)", async () => {
    const port = boot();
    port.receive(start("s1"));
    const first = pendingStream!;
    port.receive({ type: "stop", sessionId: "s1" });
    port.receive(start("s2"));
    expect(getDisplayMedia).toHaveBeenCalledTimes(2);
    const s2 = stream();
    pendingStream!.resolve(s2);
    await flush();
    expect(port.sent[0]).toMatchObject({ type: "started", sessionId: "s2" });
    // s1 finally resolves: released, reported stopped, s2 untouched
    const s1 = stream();
    first.resolve(s1);
    await flush();
    expect(s1.tracks.every((t) => t.stopped)).toBe(true);
    expect(s2.tracks.every((t) => !t.stopped)).toBe(true);
    expect(port.sent.at(-1)).toEqual({ type: "stopped", sessionId: "s1" });
  });

  it("a cancelled session whose getDisplayMedia fails stays silent", async () => {
    const port = boot();
    port.receive(start("s1"));
    port.receive({ type: "stop", sessionId: "s1" });
    pendingStream!.reject(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    await flush();
    expect(port.sent).toEqual([]);
  });

  it("a second start while one is pending is refused", () => {
    const port = boot();
    port.receive(start("s1"));
    port.receive(start("s2"));
    expect(port.sent[0]).toMatchObject({ type: "error", sessionId: "s2", code: "capture_start_failed" });
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
  });

  it("a track ending on its own reports capture_failed, not stopped", async () => {
    const port = boot();
    port.receive(start("s1"));
    const s = stream();
    pendingStream!.resolve(s);
    await flush();
    s.tracks[0]!.end();
    await flush();
    await flush();
    expect(port.types()).toEqual(["started", "chunk", "error"]);
    expect(port.sent.at(-1)).toMatchObject({ type: "error", sessionId: "s1", code: "capture_failed" });
  });

  it("passes the requested frame rate and asks for stereo system audio in getDisplayMedia", () => {
    const port = boot();
    port.receive(start("s1", { ...DEFAULT_QUALITY, frameRate: 60 }));
    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: { frameRate: { ideal: 60, max: 60 } },
      // Plan 008: without channelCount the macOS loopback track is mono.
      audio: { restrictOwnAudio: true, channelCount: { ideal: 2 } },
    });
  });

  it("scales a source above the cap, keeps the aspect ratio and encodes for the scaled size", async () => {
    const port = boot();
    port.receive(start("s1", { ...DEFAULT_QUALITY, resolutionCap: "1080p", videoQuality: "high" }));
    const s = stream();
    s.tracks[0]!.settings = { width: 3840, height: 2160, frameRate: 30 };
    pendingStream!.resolve(s);
    await flush();
    expect(s.tracks[0]!.applied).toEqual([
      { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate: { ideal: 30, max: 30 } },
    ]);
    expect(port.sent[0]).toMatchObject({
      type: "started",
      capture: { width: 1920, height: 1080, videoBitsPerSecond: 14_900_000, audioBitsPerSecond: 256_000, warnings: [] },
    });
  });

  it("does not touch a source already within the cap", async () => {
    const port = boot();
    port.receive(start("s1", { ...DEFAULT_QUALITY, resolutionCap: "4k" }));
    const s = stream();
    pendingStream!.resolve(s);
    await flush();
    expect(s.tracks[0]!.applied).toEqual([]);
    expect(port.sent[0]).toMatchObject({ type: "started", capture: DEFAULT_CAPTURE });
  });

  it("a rejected constraint is a warning, not a failure; the source size is encoded", async () => {
    const port = boot();
    port.receive(start("s1", { ...DEFAULT_QUALITY, resolutionCap: "1080p" }));
    const s = stream();
    s.tracks[0]!.settings = { width: 2560, height: 1440, frameRate: 30 };
    s.tracks[0]!.applyError = Object.assign(new Error("nope"), { name: "OverconstrainedError" });
    pendingStream!.resolve(s);
    await flush();
    expect(port.sent[0]).toMatchObject({
      type: "started",
      capture: { width: 2560, height: 1440, videoBitsPerSecond: 14_400_000 },
    });
    const report = port.sent[0]!.type === "started" ? port.sent[0]!.capture : undefined;
    expect(report?.warnings[0]).toMatch(/1080p.*OverconstrainedError/);
  });

  it("sizes the cap from the frames, not from a track that reports the wrong height (plan 008 finding)", async () => {
    // Observed on a 1920x1080 main display next to a portrait monitor: getSettings() says 1920x1920.
    const port = boot({ measureFrameSize: async () => ({ width: 1920, height: 1080 }) });
    port.receive(start("s1", { ...DEFAULT_QUALITY, resolutionCap: "1080p" }));
    const s = stream();
    s.tracks[0]!.settings = { width: 1920, height: 1920, frameRate: 30 };
    pendingStream!.resolve(s);
    await flush();
    // Already within 1080p: no constraint, so no 1080x1080 → 1080x606 squeeze.
    expect(s.tracks[0]!.applied).toEqual([]);
    expect(port.sent[0]).toMatchObject({
      type: "started",
      capture: {
        width: 1920,
        height: 1080,
        videoBitsPerSecond: 8_100_000,
        warnings: ["track.getSettings() 回報 1920x1920，實際影格 1920x1080，以實際影格為準"],
      },
    });
  });

  it("reports the frames measured after the constraint, not the target, when they differ (review R2-F1)", async () => {
    // The display shrank to 1280x720 while the 1080p constraint was being applied.
    const sizes = [{ width: 3840, height: 2160 }, { width: 1280, height: 720 }];
    const expects: (unknown | undefined)[] = [];
    const port = boot({
      measureFrameSize: async (_stream, options) => {
        expects.push(options?.expect);
        return sizes.shift();
      },
    });
    port.receive(start("s1", { ...DEFAULT_QUALITY, resolutionCap: "1080p" }));
    const s = stream();
    s.tracks[0]!.settings = { width: 3840, height: 2160, frameRate: 30 };
    pendingStream!.resolve(s);
    await flush();
    expect(expects).toEqual([undefined, { width: 1920, height: 1080 }]);
    expect(port.sent[0]).toMatchObject({
      type: "started",
      capture: {
        width: 1280,
        height: 720,
        videoBitsPerSecond: 3_600_000,
        warnings: ["套用上限後實際影格 1280x720，與目標 1920x1080 不同"],
      },
    });
  });

  it("reports the target with a warning when the frames cannot be re-measured after the constraint", async () => {
    let calls = 0;
    const port = boot({ measureFrameSize: async () => (calls++ === 0 ? { width: 3840, height: 2160 } : undefined) });
    port.receive(start("s1", { ...DEFAULT_QUALITY, resolutionCap: "1080p" }));
    const s = stream();
    s.tracks[0]!.settings = { width: 3840, height: 2160, frameRate: 30 };
    pendingStream!.resolve(s);
    await flush();
    expect(port.sent[0]).toMatchObject({
      type: "started",
      capture: { width: 1920, height: 1080, videoBitsPerSecond: 8_100_000, warnings: ["套用上限後未能重新量測影格，以目標 1920x1080 回報"] },
    });
  });

  it("falls back to getSettings() with a warning when no frame can be measured", async () => {
    const port = boot({ measureFrameSize: async () => undefined });
    port.receive(start("s1", { ...DEFAULT_QUALITY, resolutionCap: "1080p" }));
    const s = stream();
    s.tracks[0]!.settings = { width: 3840, height: 2160, frameRate: 30 };
    pendingStream!.resolve(s);
    await flush();
    expect(s.tracks[0]!.applied).toHaveLength(1);
    expect(port.sent[0]).toMatchObject({
      type: "started",
      capture: {
        width: 1920,
        height: 1080,
        warnings: ["無法讀取實際影格尺寸，以 track.getSettings() 為準", "套用上限後未能重新量測影格，以目標 1920x1080 回報"],
      },
    });
  });

  it("missing track settings are left out of the report and the encoder assumes 1080p", async () => {
    const port = boot();
    port.receive(start("s1", { ...DEFAULT_QUALITY, videoQuality: "economy" }));
    const s = stream();
    s.tracks[0]!.settings = {};
    s.tracks[1]!.settings = {};
    pendingStream!.resolve(s);
    await flush();
    const message = port.sent[0]!;
    expect(message.type).toBe("started");
    if (message.type !== "started") return;
    expect(message.capture).toEqual({
      videoBitsPerSecond: 4_400_000,
      audioBitsPerSecond: 256_000,
      warnings: ["video track 未回報尺寸，無法套用解析度上限"],
    });
    expect(Object.keys(message.capture)).not.toContain("width");
  });

  it("a stop that lands while the constraint is being applied releases the stream", async () => {
    const port = boot();
    port.receive(start("s1", { ...DEFAULT_QUALITY, resolutionCap: "1080p" }));
    const s = stream();
    s.tracks[0]!.settings = { width: 3840, height: 2160, frameRate: 30 };
    let releaseApply: (() => void) | undefined;
    s.tracks[0]!.applyConstraints = () => new Promise<void>((r) => (releaseApply = r));
    pendingStream!.resolve(s);
    await flush();
    expect(releaseApply).toBeDefined();
    port.receive({ type: "stop", sessionId: "s1" });
    releaseApply!();
    await flush();
    expect(s.tracks.every((t) => t.stopped)).toBe(true);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(port.types()).toEqual(["stopped"]);
  });

  it("repeats the requested frame rate when applying the size cap (review F1)", async () => {
    const port = boot();
    port.receive(start("s1", { ...DEFAULT_QUALITY, resolutionCap: "1080p", frameRate: 60 }));
    const s = stream();
    s.tracks[0]!.settings = { width: 3840, height: 2160, frameRate: 60 };
    pendingStream!.resolve(s);
    await flush();
    expect(s.tracks[0]!.applied[0]).toMatchObject({ frameRate: { ideal: 60, max: 60 } });
  });

  it("an audio track that ends while the constraint is applied fails the start instead of recording silence (review F3)", async () => {
    const port = boot();
    port.receive(start("s1", { ...DEFAULT_QUALITY, resolutionCap: "1080p" }));
    const s = stream();
    s.tracks[0]!.settings = { width: 3840, height: 2160, frameRate: 30 };
    let releaseApply: (() => void) | undefined;
    s.tracks[0]!.applyConstraints = () => new Promise<void>((r) => (releaseApply = r));
    pendingStream!.resolve(s);
    await flush();
    s.tracks[1]!.readyState = "ended";
    releaseApply!();
    await flush();
    expect(port.sent[0]).toMatchObject({ type: "error", sessionId: "s1", code: "capture_start_failed" });
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(s.tracks.every((t) => t.stopped)).toBe(true);
    // and the host is free again
    port.sent = [];
    port.receive(start("s2"));
    pendingStream!.resolve(stream());
    await flush();
    expect(port.sent[0]).toMatchObject({ type: "started", sessionId: "s2" });
  });

  it("ignores stop for an unknown session", () => {
    const port = boot();
    port.receive({ type: "stop", sessionId: "nope" });
    expect(port.sent).toEqual([]);
  });
});
