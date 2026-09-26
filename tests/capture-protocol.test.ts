import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Recorder, type RecorderEvent } from "../src/main/recorder";
import { FileWriter } from "../src/main/file-writer";
import { CaptureHost, type HostPort } from "../src/renderer/capture-host";
import { DEFAULT_QUALITY } from "../src/shared/quality";
import type { HostMessage, MainMessage } from "../src/shared/protocol";

class FakePort implements HostPort {
  sent: HostMessage[] = [];
  listener?: (event: { data: unknown }) => void;
  addEventListener(_type: "message", listener: (event: { data: unknown }) => void): void { this.listener = listener; }
  start(): void {}
  postMessage(message: unknown): void { this.sent.push(message as HostMessage); }
  receive(message: MainMessage): void { this.listener?.({ data: message }); }
  types(): string[] { return this.sent.map(message => message.type); }
}
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(): boolean { return true; }
  state = "inactive";
  mimeType = "video/mp4";
  ondataavailable?: (event: { data: Blob }) => void;
  onerror?: (event: { error: Error }) => void;
  onstop?: () => void;
  constructor() { FakeMediaRecorder.instances.push(this); }
  start(): void { this.state = "recording"; }
  stop(): void { this.state = "inactive"; this.onstop?.(); }
  emitChunk(bytes: number[]): void { this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) }); }
}
const stream = (): MediaStream => {
  const tracks = ["video", "audio"].map(kind => ({ kind, readyState: "live", stop() {}, addEventListener() {},
    getSettings: () => kind === "video" ? { width: 1920, height: 1080, frameRate: 30 } : { sampleRate: 48000, channelCount: 2 } }));
  return { getTracks: () => tracks, getVideoTracks: () => [tracks[0]], getAudioTracks: () => [tracks[1]] } as unknown as MediaStream;
};
const measureFromSettings = async (): Promise<{ width: number; height: number }> => ({ width: 1920, height: 1080 });
let pendingStream: { resolve(stream: MediaStream): void } | undefined;
beforeEach(() => {
  FakeMediaRecorder.instances = []; pendingStream = undefined;
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: () => new Promise<MediaStream>(resolve => { pendingStream = { resolve }; }) } });
});
afterEach(() => vi.unstubAllGlobals());
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

it("hands the final encoder-error bytes through the real protocol, Recorder and FileWriter", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordstuff-protocol-"));
  const port = new FakePort();
  let deliver!: (message: HostMessage) => void;
  const post = port.postMessage.bind(port);
  port.postMessage = message => { post(message); deliver?.(message as HostMessage); };
  new CaptureHost(port, { measureFrameSize: measureFromSettings });
  const events: RecorderEvent[] = [];
  const main = new Recorder({
    host: { start: async (sessionId, quality) => port.receive({ type: "start", sessionId, quality }),
      record: sessionId => port.receive({ type: "record", sessionId }),
      stop: sessionId => port.receive({ type: "stop", sessionId }),
      onMessage: listener => { deliver = listener; }, onFailure: () => undefined },
    outputDir: () => dir, quality: () => DEFAULT_QUALITY, ensureWritableDir: async () => undefined,
    openWriter: (partial, final) => FileWriter.open(partial, final), newSessionId: () => "integration",
  });
  main.subscribe(event => events.push(event));
  try {
    main.toggle();
    while (!pendingStream) await flush();
    pendingStream.resolve(stream()); await flush();
    const encoder = FakeMediaRecorder.instances[0]!;
    encoder.emitChunk([1, 2]); await flush();
    encoder.state = "inactive";
    encoder.onerror?.({ error: new Error("encoder final flush") });
    let release!: (bytes: ArrayBuffer) => void;
    encoder.ondataavailable?.({ data: { size: 2, arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { release = resolve; }) } as Blob });
    encoder.onstop?.(); await flush();
    main.stop(); // Cannot rewrite the already-latched renderer error.
    release(new Uint8Array([3, 4]).buffer);
    expect(await main.shutdown()).toBe(true);
    const failures = events.filter(event => event.type === "failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: "capture_failed", detail: "Error: encoder final flush" });
    expect([...await fs.readFile(failures[0]!.partialPath!)]).toEqual([1, 2, 3, 4]);
    expect(events.some(event => event.type === "saved")).toBe(false);
    expect(port.types().filter(type => type === "error" || type === "stopped")).toEqual(["error"]);
  } finally { await main.shutdown(); await fs.rm(dir, { recursive: true, force: true }); }
});
