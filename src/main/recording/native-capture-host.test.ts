import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UtilityProcess } from "electron";
import { DEFAULT_QUALITY } from "../../shared/quality";
import type { HostMessage, MainMessage } from "../../shared/protocol";

vi.mock("electron", () => ({ utilityProcess: { fork: () => { throw new Error("tests pass their own fork"); } } }));

const { NativeCaptureHost, cameraChoice } = await import("./native-capture-host");

class Child extends EventEmitter {
  sent: MainMessage[] = [];
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  args: string[] = [];
  transferred: unknown[][] = [];
  postMessage(message: MainMessage, ports?: unknown[]): void { this.sent.push(message); if (ports) this.transferred.push(ports); }
  kill(): boolean { this.killed = true; return true; }
  /** Deliver a message as if the utility process had sent it. */
  deliver(message: unknown): void { this.emit("message", message); }
}

function setup(display: string | undefined = "69733632", windows: Partial<ConstructorParameters<typeof NativeCaptureHost>[0]> = {}) {
  const children: Child[] = [];
  const logs: string[] = [];
  const host = new NativeCaptureHost({
    ...windows,
    entryPath: "/out/main/native-host-process.js",
    addonPath: "/out/native/recordstuff-capture.node",
    resolveDisplay: async () => display,
    ownPids: () => [100, 101],
    hideSystemUi: () => true,
    log: (message) => logs.push(message),
    fork: (_entry, args) => {
      const child = new Child();
      child.args = args;
      children.push(child);
      return child as unknown as UtilityProcess;
    },
  });
  const messages: HostMessage[] = [];
  const failures: string[] = [];
  host.onMessage((message) => messages.push(message));
  host.onFailure((code) => failures.push(code));
  return { host, children, logs, messages, failures };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function started(ctx: ReturnType<typeof setup>): Promise<Child> {
  const start = ctx.host.start("s1", DEFAULT_QUALITY, "/out/a.recording.mp4");
  await vi.advanceTimersByTimeAsync(0);
  const child = ctx.children.at(-1)!;
  child.deliver({ type: "ready" });
  await start;
  return child;
}

describe("cameraChoice (plan 075)", () => {
  const layout = { width: 0.3, height: 0.2, rounding: 0.5, mirror: true,
    positions: [{ display: "primary", x: 0.1, y: 0.2 }, { display: "69733632", x: 0.9, y: 0.8 }] };

  it("takes the bubble's position on the recorded display, else the primary display's, else the default", () => {
    expect(cameraChoice({ deviceId: "cam", layout }, "69733632")).toEqual({ deviceId: "cam", width: 0.3, height: 0.2, rounding: 0.5, x: 0.9, y: 0.8, mirror: true });
    expect(cameraChoice({ layout }, "1")).toEqual({ width: 0.3, height: 0.2, rounding: 0.5, x: 0.1, y: 0.2, mirror: true });
    expect(cameraChoice({ layout: { ...layout, positions: [] } }, "1")).toMatchObject({ x: 0.97, y: 0.95 });
  });

  it("posts start with the camera for the display granted", async () => {
    const ctx = setup();
    const start = ctx.host.start("s1", DEFAULT_QUALITY, "/out/a.recording.mp4", { camera: { layout } });
    await vi.advanceTimersByTimeAsync(0);
    ctx.children.at(-1)!.deliver({ type: "ready" });
    await start;
    expect(ctx.children.at(-1)!.sent.at(-1)).toMatchObject({ type: "start", native: { displayId: 69733632, camera: { x: 0.9, y: 0.8, mirror: true } } });
  });

  it("sends the session's camera changes with the position on its display, and none for another session", async () => {
    const ctx = setup();
    const start = ctx.host.start("s1", DEFAULT_QUALITY, "/out/a.recording.mp4", { camera: { layout } });
    await vi.advanceTimersByTimeAsync(0);
    const child = ctx.children.at(-1)!;
    child.deliver({ type: "ready" });
    await start;
    ctx.host.setCamera("s1", { layout: { ...layout, mirror: false } }, true);
    ctx.host.setCamera("other", { layout }, false);
    expect(child.sent.filter((m) => m.type === "cameraLayout")).toEqual([{ type: "cameraLayout", sessionId: "s1",
      camera: { width: 0.3, height: 0.2, rounding: 0.5, x: 0.9, y: 0.8, mirror: false }, hidden: true }]);
  });

  it("hands Settings' port to the session's process and says whether its preview is watched (step 7)", async () => {
    const ctx = setup();
    const port = { close: () => undefined } as unknown as Electron.MessagePortMain;
    expect(ctx.host.watchPreview("s1", true, port), "no process yet").toBe(false);
    const start = ctx.host.start("s1", DEFAULT_QUALITY, "/out/a.recording.mp4", { camera: { layout } });
    await vi.advanceTimersByTimeAsync(0);
    const child = ctx.children.at(-1)!;
    child.deliver({ type: "ready" });
    await start;
    expect(ctx.host.watchPreview("other", true, port)).toBe(false);
    expect(ctx.host.watchPreview("s1", true, port)).toBe(true);
    expect(ctx.host.watchPreview("s1", false)).toBe(true);
    expect(child.transferred).toEqual([[port]]);
    expect(child.sent.filter((m) => m.type === "cameraPreview" || (m as { type: string }).type === "cameraPreviewPort")).toEqual([
      { type: "cameraPreviewPort" }, { type: "cameraPreview", sessionId: "s1", watching: true }, { type: "cameraPreview", sessionId: "s1", watching: false }]);
  });
});

describe("NativeCaptureHost", () => {
  it("hands each recording attempt's process to onLaunch, and never the microphone list's (plan 075's prototype)", async () => {
    const launched: unknown[] = [];
    const ctx = setup(undefined, { onLaunch: (child) => launched.push(child) });
    const child = await started(ctx);
    expect(launched).toEqual([child]);
  });

  it("forks a host with the engine's path and posts start with the display, the file and what to leave out", async () => {
    const ctx = setup();
    const child = await started(ctx);
    expect(child.args).toEqual(["/out/native/recordstuff-capture.node"]);
    expect(child.sent).toEqual([{ type: "start", sessionId: "s1", quality: DEFAULT_QUALITY,
      native: { displayId: 69733632, recordingPath: "/out/a.recording.mp4", ownPids: [100, 101], hideSystemUi: true } }]);
  });

  it("posts the session's microphone choice with start, and none when the recorder gave none (plan 074)", async () => {
    const ctx = setup();
    const start = ctx.host.start("s1", DEFAULT_QUALITY, "/out/a.recording.mp4", { microphone: { enabled: true, deviceId: "usb-mic" } });
    await vi.advanceTimersByTimeAsync(0);
    ctx.children.at(-1)!.deliver({ type: "ready" });
    await start;
    expect(ctx.children.at(-1)!.sent[0]).toMatchObject({ native: { microphone: { enabled: true, deviceId: "usb-mic" } } });
    const other = setup();
    expect((await started(other)).sent[0]).not.toHaveProperty("native.microphone");
  });

  it("asks for the microphone before start only when it is on, and posts start after the answer (plan 074)", async () => {
    let answer: () => void = () => undefined;
    const prepareMicrophone = vi.fn(() => new Promise<void>((resolve) => { answer = resolve; }));
    const ctx = setup(undefined, { prepareMicrophone });
    const start = ctx.host.start("s1", DEFAULT_QUALITY, "/out/a.recording.mp4", { microphone: { enabled: true } });
    await vi.advanceTimersByTimeAsync(0);
    ctx.children.at(-1)!.deliver({ type: "ready" });
    await vi.advanceTimersByTimeAsync(0);
    expect(prepareMicrophone).toHaveBeenCalledOnce();
    expect(ctx.children.at(-1)!.sent).toEqual([]);
    answer();
    await start;
    expect(ctx.children.at(-1)!.sent[0]).toMatchObject({ type: "start" });
    const off = setup(undefined, { prepareMicrophone });
    await started(off);
    expect(prepareMicrophone).toHaveBeenCalledOnce();
  });

  it("lists the audio inputs from a process of its own and ends it, whatever it answers (plan 074)", async () => {
    const ctx = setup();
    const listed = ctx.host.listMicrophones();
    const child = ctx.children.at(-1)!;
    child.deliver({ type: "ready" });
    expect(child.sent).toEqual([{ type: "listMicrophones" }]);
    child.deliver({ type: "microphones", devices: [{ id: "mic", name: "MacBook Pro Microphone", default: true }] });
    await expect(listed).resolves.toEqual([{ id: "mic", name: "MacBook Pro Microphone", default: true }]);
    expect(child.killed).toBe(true);

    const refused = ctx.host.listMicrophones();
    ctx.children.at(-1)!.deliver({ type: "ready" });
    ctx.children.at(-1)!.deliver({ type: "microphones", error: "no audio media type" });
    await expect(refused).rejects.toThrow("no audio media type");

    const silent = ctx.host.listMicrophones();
    const rejected = expect(silent).rejects.toThrow("not listed within");
    await vi.advanceTimersByTimeAsync(8000);
    await rejected;
    expect(ctx.children.at(-1)!.killed).toBe(true);

    const crashed = ctx.host.listMicrophones();
    ctx.children.at(-1)!.emit("exit", 3);
    await expect(crashed).rejects.toThrow("exited with 3");
  });

  it("lists the cameras the same way, one listing at a time (plan 075)", async () => {
    const ctx = setup();
    const listed = ctx.host.listCameras();
    const child = ctx.children.at(-1)!;
    child.deliver({ type: "ready" });
    expect(child.sent).toEqual([{ type: "listCameras" }]);
    // A microphones answer is not the cameras'.
    child.deliver({ type: "microphones", devices: [{ id: "mic", name: "Mic", default: true }] });
    child.deliver({ type: "cameras", devices: [{ id: "iphone", name: "iPhone Camera", default: false }] });
    await expect(listed).resolves.toEqual([{ id: "iphone", name: "iPhone Camera", default: false }]);
    expect(child.killed).toBe(true);

    const refused = ctx.host.listCameras();
    ctx.children.at(-1)!.deliver({ type: "ready" });
    ctx.children.at(-1)!.deliver({ type: "cameras", error: "no video media type" });
    await expect(refused).rejects.toThrow("no video media type");
  });

  it("never lists while a session runs: a start or cancelListing ends the listing, and a ready process asks again first (plan 074)", async () => {
    const ctx = setup();
    const pending = ctx.host.listMicrophones();
    const lister = ctx.children.at(-1)!;
    const cancelled = expect(pending).rejects.toThrow("a recording started");
    const start = ctx.host.start("s1", DEFAULT_QUALITY, "/out/a.recording.mp4");
    await cancelled;
    expect(lister.killed).toBe(true);
    expect(lister.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    ctx.children.at(-1)!.deliver({ type: "ready" });
    await start;

    let idle = true;
    const late = ctx.host.listMicrophones(() => idle);
    idle = false;
    const child = ctx.children.at(-1)!;
    child.deliver({ type: "ready" });
    await expect(late).rejects.toThrow("a recording started");
    expect(child.sent).toEqual([]);
    expect(child.killed).toBe(true);

    const direct = ctx.host.listMicrophones();
    ctx.host.cancelListing();
    await expect(direct).rejects.toThrow("a recording started");
  });

  it("on Windows passes a point on the display and keeps its own windows out of capture until torn down", async () => {
    const excluded: boolean[] = [];
    const ctx = setup("2779098405", {
      displayPoint: (id) => (id === "2779098405" ? { x: 960, y: 540 } : undefined),
      excludeOwnWindows: (on) => excluded.push(on),
    });
    const child = await started(ctx);
    expect(child.sent[0]).toMatchObject({ native: { displayId: 2779098405, displayPoint: { x: 960, y: 540 } } });
    expect(excluded).toEqual([true]);
    ctx.host.destroy();
    ctx.host.destroy();
    // Still excluded until the process has ended, since it may still be capturing.
    expect([excluded, child.killed]).toEqual([[true], true]);
    child.emit("exit", 0);
    expect(excluded).toEqual([true, false]);
  });

  it("rejects a start whose engine could not load for missing Windows media components with that code (plan 078)", async () => {
    const ctx = setup();
    const start = ctx.host.start("s1", DEFAULT_QUALITY, "/out/a.recording.mp4");
    await vi.advanceTimersByTimeAsync(0);
    ctx.children.at(-1)!.emit("exit", 4);
    await expect(start).rejects.toMatchObject({ name: "HostStartError", code: "media_components_missing" });
  });

  it("lets main make its window before the engine reads what it may capture (macOS lists only apps owning one)", async () => {
    const order: string[] = [];
    const ctx = setup("7", { beforeCapture: () => order.push(`before; ${ctx.children.at(-1)?.sent.length ?? 0} sent`) });
    const child = await started(ctx);
    expect(order).toEqual(["before; 0 sent"]);
    expect(child.sent[0]).toMatchObject({ type: "start" });
  });

  it("lets its windows back in after a bound when the process never reports its exit, unless a newer attempt excluded them", async () => {
    const excluded: boolean[] = [];
    const ctx = setup("7", { excludeOwnWindows: (on) => excluded.push(on) });
    await started(ctx);
    ctx.host.destroy();
    await vi.advanceTimersByTimeAsync(5000);
    expect(excluded).toEqual([true, false]);

    const first = await started(ctx);
    ctx.host.destroy();
    await started(ctx);
    first.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(excluded).toEqual([true, false, true, true]);
  });

  it("drops an earlier attempt's late release even after a later attempt was torn down", async () => {
    const excluded: boolean[] = [];
    const ctx = setup("7", { excludeOwnWindows: (on) => excluded.push(on) });
    const first = await started(ctx);
    ctx.host.destroy();
    const second = await started(ctx);
    ctx.host.destroy();
    // The first attempt's process ends while the second may still be capturing: windows stay out.
    first.emit("exit", 0);
    expect(excluded).toEqual([true, true]);
    second.emit("exit", 0);
    expect(excluded).toEqual([true, true, false]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(excluded).toEqual([true, true, false]);
  });

  it("lets its windows back in when the process exits during a session", async () => {
    const excluded: boolean[] = [];
    const ctx = setup("7", { excludeOwnWindows: (on) => excluded.push(on) });
    const child = await started(ctx);
    child.emit("exit", 1);
    expect(excluded).toEqual([true, false]);
    expect(ctx.failures).toEqual(["capture_host_crashed"]);
  });

  it("chooses the display while the process starts, and logs how long each took", async () => {
    let chosen = false;
    const children: Child[] = [];
    const logs: string[] = [];
    const host = new NativeCaptureHost({
      entryPath: "/e.js", addonPath: "/a.node", ownPids: () => [1], hideSystemUi: () => false, log: (line) => logs.push(line),
      resolveDisplay: async () => { chosen = true; return "7"; },
      fork: () => { const child = new Child(); children.push(child); return child as unknown as UtilityProcess; },
    });
    const start = host.start("s1", DEFAULT_QUALITY, "/out/a.recording.mp4");
    await vi.advanceTimersByTimeAsync(0);
    // Not ready yet, and the display is already chosen.
    expect(chosen).toBe(true);
    expect(children[0]!.sent).toEqual([]);
    children[0]!.deliver({ type: "ready" });
    await start;
    expect(children[0]!.sent[0]).toMatchObject({ type: "start", native: { displayId: 7 } });
    expect(logs.some((line) => /^capture host: timing: process ready \d+ ms, display chosen \d+ ms$/.test(line))).toBe(true);
  });

  it("rejects the start when choosing the display fails, after the process is ready", async () => {
    const children: Child[] = [];
    const host = new NativeCaptureHost({
      entryPath: "/e.js", addonPath: "/a.node", ownPids: () => [1], hideSystemUi: () => false,
      resolveDisplay: async () => { throw new Error("no answer"); },
      fork: () => { const child = new Child(); children.push(child); return child as unknown as UtilityProcess; },
    });
    const start = host.start("s1", DEFAULT_QUALITY, "/out/a.recording.mp4").catch((cause: Error) => cause);
    await vi.advanceTimersByTimeAsync(0);
    children[0]!.deliver({ type: "ready" });
    expect(await start).toMatchObject({ message: "no answer" });
  });

  it("reports a refused display as a start error the recorder's mapping explains", async () => {
    const ctx = setup("");
    const child = await started(ctx);
    expect(child.sent).toEqual([]);
    expect(ctx.messages.at(-1)).toMatchObject({ type: "error", sessionId: "s1", code: "capture_start_failed" });
  });

  it("rejects a start whose host never reports ready, and ends it", async () => {
    const ctx = setup();
    const start = ctx.host.start("s1", DEFAULT_QUALITY, "/out/a.recording.mp4").catch((cause: Error) => cause);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await start).toBeInstanceOf(Error);
    expect(ctx.children[0]!.killed).toBe(true);
  });

  it("drops malformed messages and passes valid ones on", async () => {
    const ctx = setup();
    const child = await started(ctx);
    child.deliver({ type: "progress", sessionId: "s1", bytes: -1 });
    child.deliver({ type: "progress", sessionId: "s1", bytes: 512 });
    expect(ctx.messages.filter((m) => m.type === "progress")).toEqual([{ type: "progress", sessionId: "s1", bytes: 512 }]);
    expect(ctx.logs.some((line) => line.includes("dropped malformed message"))).toBe(true);
  });

  it("keeps a stopped process until it finished the file, and hands the writer its report once", async () => {
    const excluded: boolean[] = [];
    const ctx = setup("7", { excludeOwnWindows: (on) => excluded.push(on) });
    const child = await started(ctx);
    const outcome = ctx.host.fileOutcome("/out/a.recording.mp4");
    child.deliver({ type: "stopped", sessionId: "s1" });
    // The recorder goes idle at `stopped` and tears the attempt down; capture has ended, so windows come back at once.
    ctx.host.destroy();
    expect([child.killed, excluded]).toEqual([false, [true, false]]);
    child.deliver({ type: "finished", sessionId: "s1", file: { bytes: 99, finalizeMs: 3 } });
    await expect(outcome).resolves.toEqual({ bytes: 99, finalizeMs: 3 });
    expect(child.killed).toBe(true);
    expect(ctx.logs).toContain("capture host: engine finished 99 bytes 3 ms after the stop, plain MP4");
    await expect(ctx.host.fileOutcome("/out/a.recording.mp4")).rejects.toThrow("never stopped a recording into this file");
  });

  it("gives the writer the engine's write error when the file could not be finished", async () => {
    const ctx = setup();
    const child = await started(ctx);
    child.deliver({ type: "stopped", sessionId: "s1" });
    ctx.host.destroy();
    child.deliver({ type: "writeError", sessionId: "s1", code: "disk_full", detail: "No space left" });
    await expect(ctx.host.fileOutcome("/out/a.recording.mp4")).rejects.toMatchObject({ name: "FileWriteError", code: "disk_full", filePath: "/out/a.recording.mp4" });
    expect(child.killed).toBe(true);
    // The recorder heard the stop already; the file's outcome is the writer's alone.
    expect(ctx.messages.map((m) => m.type)).toEqual(["ready", "stopped"]);
  });

  it("fails the file, not the session, when the process exits while finishing it", async () => {
    const ctx = setup();
    const child = await started(ctx);
    child.deliver({ type: "stopped", sessionId: "s1" });
    ctx.host.destroy();
    child.emit("exit", 11);
    await expect(ctx.host.fileOutcome("/out/a.recording.mp4")).rejects.toThrow("capture process exited with 11 before the file was finished");
    expect(ctx.failures).toEqual([]);
  });

  it("ends a process that never reports the file, after a bound past the engine's own", async () => {
    const ctx = setup();
    const child = await started(ctx);
    child.deliver({ type: "stopped", sessionId: "s1" });
    ctx.host.destroy();
    const outcome = expect(ctx.host.fileOutcome("/out/a.recording.mp4")).rejects.toThrow("did not finish the file within 150000 ms");
    await vi.advanceTimersByTimeAsync(149_000);
    expect(child.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;
    expect(child.killed).toBe(true);
  });

  it("starts the next recording while the last one's file is still being finished", async () => {
    const ctx = setup();
    const first = await started(ctx);
    first.deliver({ type: "stopped", sessionId: "s1" });
    ctx.host.destroy();
    const start = ctx.host.start("s2", DEFAULT_QUALITY, "/out/b.recording.mp4");
    await vi.advanceTimersByTimeAsync(0);
    const second = ctx.children.at(-1)!;
    second.deliver({ type: "ready" });
    await start;
    expect([first.killed, second === first]).toEqual([false, false]);
    first.deliver({ type: "finished", sessionId: "s1", file: { bytes: 5, finalizeMs: 1 } });
    await expect(ctx.host.fileOutcome("/out/a.recording.mp4")).resolves.toMatchObject({ bytes: 5 });
    expect([first.killed, second.killed]).toEqual([true, false]);
  });

  it("has no file to hand over for an attempt torn down before it stopped", async () => {
    const ctx = setup();
    const child = await started(ctx);
    ctx.host.destroy();
    expect(child.killed).toBe(true);
    await expect(ctx.host.fileOutcome("/out/a.recording.mp4")).rejects.toThrow("never stopped a recording into this file");
  });

  it("reports a crash when the process exits during a session, and not after it ended", async () => {
    const ctx = setup();
    let child = await started(ctx);
    child.emit("exit", 9);
    expect(ctx.failures).toEqual(["capture_host_crashed"]);

    child = await started(ctx);
    child.deliver({ type: "stopped", sessionId: "s1" });
    child.emit("exit", 0);
    expect(ctx.failures).toEqual(["capture_host_crashed"]);
  });

  it("reports a host that stops answering pings while a session runs", async () => {
    const ctx = setup();
    const child = await started(ctx);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(child.sent.filter((m) => m.type === "ping")).toHaveLength(2);
    expect(ctx.failures).toEqual(["capture_host_unresponsive"]);
    expect(child.killed).toBe(true);
  });

  it("ends the process on destroy and refuses record afterwards", async () => {
    const ctx = setup();
    const child = await started(ctx);
    ctx.host.record("s1");
    expect(child.sent.at(-1)).toEqual({ type: "record", sessionId: "s1" });
    ctx.host.destroy();
    expect(child.killed).toBe(true);
    expect(() => ctx.host.record("s1")).toThrow();
  });

  it("logs the host's own output", async () => {
    const ctx = setup();
    const child = await started(ctx);
    child.stderr.emit("data", Buffer.from("engine could not be loaded\n"));
    expect(ctx.logs).toContain("capture host: engine could not be loaded");
  });
});
