import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UtilityProcess } from "electron";
import { DEFAULT_QUALITY } from "../../shared/quality";
import type { HostMessage, MainMessage } from "../../shared/protocol";

vi.mock("electron", () => ({ utilityProcess: { fork: () => { throw new Error("tests pass their own fork"); } } }));

const { NativeCaptureHost } = await import("./native-capture-host");

class Child extends EventEmitter {
  sent: MainMessage[] = [];
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  args: string[] = [];
  postMessage(message: MainMessage): void { this.sent.push(message); }
  kill(): boolean { this.killed = true; return true; }
  /** Deliver a message as if the utility process had sent it. */
  deliver(message: unknown): void { this.emit("message", message); }
}

function setup(display: string | undefined = "69733632") {
  const children: Child[] = [];
  const logs: string[] = [];
  const host = new NativeCaptureHost({
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

describe("NativeCaptureHost", () => {
  it("forks a host with the engine's path and posts start with the display, the file and what to leave out", async () => {
    const ctx = setup();
    const child = await started(ctx);
    expect(child.args).toEqual(["/out/native/recordstuff-capture.node"]);
    expect(child.sent).toEqual([{ type: "start", sessionId: "s1", quality: DEFAULT_QUALITY,
      native: { displayId: 69733632, recordingPath: "/out/a.recording.mp4", ownPids: [100, 101], hideSystemUi: true } }]);
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

  it("keeps the engine's report of the finished file for the writer, once", async () => {
    const ctx = setup();
    const child = await started(ctx);
    child.deliver({ type: "stopped", sessionId: "s1", file: { bytes: 99, finalizeMs: 3 } });
    expect(ctx.host.takeReport("/out/a.recording.mp4")).toEqual({ bytes: 99, finalizeMs: 3 });
    expect(ctx.host.takeReport("/out/a.recording.mp4")).toBeUndefined();
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
