/**
 * Drives the renderer's session machine with a fake MessagePort, a fake
 * `getDisplayMedia` and a fake `MediaRecorder`; no DOM needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTPUT_MIME_TYPE, type HostMessage, type MainMessage } from "../shared/protocol";
import { CaptureHost, type HostPort } from "./capture-host";

class FakeTrack {
  stopped = false;
  readyState: "live" | "ended" = "live";
  private listeners: (() => void)[] = [];
  constructor(readonly kind: "video" | "audio") {}
  stop(): void {
    this.stopped = true;
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
    options: { mimeType: string },
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

function boot(): FakePort {
  const port = new FakePort();
  new CaptureHost(port);
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
    port.receive({ type: "start", sessionId: "s1" });
    const s = stream();
    pendingStream!.resolve(s);
    await flush();
    expect(port.sent[0]).toEqual({ type: "started", sessionId: "s1", mimeType: OUTPUT_MIME_TYPE });
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
    port.receive({ type: "start", sessionId: "s1" });
    expect(port.sent[0]).toMatchObject({ type: "error", sessionId: "s1", code: "mp4_unsupported" });
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it("refuses a stream without an audio track and releases it", async () => {
    const port = boot();
    port.receive({ type: "start", sessionId: "s1" });
    const s = new FakeStream([new FakeTrack("video")]);
    pendingStream!.resolve(s);
    await flush();
    expect(port.sent[0]).toMatchObject({ type: "error", sessionId: "s1", code: "no_audio_track" });
    expect(s.tracks[0]!.stopped).toBe(true);
  });

  it("refuses an audio track that is already ended (macOS CoreAudio Tap without permission)", async () => {
    const port = boot();
    port.receive({ type: "start", sessionId: "s1" });
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
    port.receive({ type: "start", sessionId: "s1" });
    pendingStream!.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    await flush();
    expect(port.sent[0]).toMatchObject({ type: "error", code: "permission_denied" });
  });

  it("a stop that arrives while getDisplayMedia is pending cancels the session (review finding 1)", async () => {
    const port = boot();
    port.receive({ type: "start", sessionId: "s1" });
    port.receive({ type: "stop", sessionId: "s1" });
    const s = stream();
    pendingStream!.resolve(s);
    await flush();
    expect(s.tracks.every((t) => t.stopped)).toBe(true);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(port.types()).toEqual(["stopped"]);

    // and the host is free for the next session
    port.sent = [];
    port.receive({ type: "start", sessionId: "s2" });
    pendingStream!.resolve(stream());
    await flush();
    expect(port.sent[0]).toMatchObject({ type: "started", sessionId: "s2" });
  });

  it("a cancelled session still waiting on the OS does not block the next start (pass-2 finding 1)", async () => {
    const port = boot();
    port.receive({ type: "start", sessionId: "s1" });
    const first = pendingStream!;
    port.receive({ type: "stop", sessionId: "s1" });
    port.receive({ type: "start", sessionId: "s2" });
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
    port.receive({ type: "start", sessionId: "s1" });
    port.receive({ type: "stop", sessionId: "s1" });
    pendingStream!.reject(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    await flush();
    expect(port.sent).toEqual([]);
  });

  it("a second start while one is pending is refused", () => {
    const port = boot();
    port.receive({ type: "start", sessionId: "s1" });
    port.receive({ type: "start", sessionId: "s2" });
    expect(port.sent[0]).toMatchObject({ type: "error", sessionId: "s2", code: "capture_start_failed" });
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
  });

  it("a track ending on its own reports capture_failed, not stopped", async () => {
    const port = boot();
    port.receive({ type: "start", sessionId: "s1" });
    const s = stream();
    pendingStream!.resolve(s);
    await flush();
    s.tracks[0]!.end();
    await flush();
    await flush();
    expect(port.types()).toEqual(["started", "chunk", "error"]);
    expect(port.sent.at(-1)).toMatchObject({ type: "error", sessionId: "s1", code: "capture_failed" });
  });

  it("ignores stop for an unknown session", () => {
    const port = boot();
    port.receive({ type: "stop", sessionId: "nope" });
    expect(port.sent).toEqual([]);
  });
});
