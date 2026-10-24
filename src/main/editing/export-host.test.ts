import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UtilityProcess } from "electron";
import type { ExportMainMessage, ExportPlan } from "../../shared/editing";

vi.mock("electron", () => ({ utilityProcess: { fork: () => { throw new Error("tests pass their own fork"); } } }));

const { ExportHost, ExportFailure } = await import("./export-host");

class Child extends EventEmitter {
  sent: ExportMainMessage[] = [];
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  postMessage(message: ExportMainMessage): void { this.sent.push(message); }
  kill(): boolean { this.killed = true; this.emit("exit", null); return true; }
  deliver(message: unknown): void { this.emit("message", message); }
  /** The id of the last request of `type` main sent. */
  last(type: "inspect" | "export"): number {
    const message = this.sent.filter((m) => m.type === type).at(-1);
    return message && "id" in message ? message.id : -1;
  }
}

const plan: ExportPlan = {
  timescale: 90_000, duration: 900_000, outputDuration: 600_000, frames: 300, removed: [], dropped: [],
  parts: [{ requested: 0, start: 0, stop: 900_000, outStart: 0, fellBack: false, reencoded: false }], secondDescription: false, hasAudio: true,
};

function setup() {
  const children: Child[] = [];
  const logs: string[] = [];
  const host = new ExportHost({
    entryPath: "/out/main/export-process.js",
    addonPath: "/out/native/recordstuff-capture.node",
    log: (message) => logs.push(message),
    fork: () => {
      const child = new Child();
      children.push(child);
      return child as unknown as UtilityProcess;
    },
  });
  return { host, children, logs };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function ready(ctx: ReturnType<typeof setup>): Promise<Child> {
  await vi.advanceTimersByTimeAsync(0);
  const child = ctx.children.at(-1)!;
  child.deliver({ type: "ready" });
  await vi.advanceTimersByTimeAsync(0);
  return child;
}

describe("the export worker's supervisor", () => {
  it("forks the worker once, on the first request, and answers each by its id", async () => {
    const ctx = setup();
    const first = ctx.host.inspect({ source: "/a.mp4", removed: [] });
    const child = await ready(ctx);
    const second = ctx.host.inspect({ source: "/a.mp4", removed: [{ from: 0, to: 90_000 }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.children).toHaveLength(1);
    const [a, b] = child.sent.filter((m) => m.type === "inspect").map((m) => ("id" in m ? m.id : -1));
    child.deliver({ type: "inspected", id: b, plan: { ...plan, outputDuration: 1 } });
    child.deliver({ type: "inspected", id: a, plan });
    expect(await first).toEqual(plan);
    expect((await second).outputDuration).toBe(1);
  });

  it("drops messages it does not expect, and fails a request the worker names as failed", async () => {
    const ctx = setup();
    const exported = ctx.host.export({ source: "/a.mp4", output: "/.a.part", removed: [] }, () => undefined);
    const child = await ready(ctx);
    child.deliver({ type: "exported", id: child.last("export"), result: { plan, bytes: "lots" } });
    child.deliver({ type: "failed", id: child.last("export"), code: "disk_full", detail: "no space" });
    await expect(exported).rejects.toMatchObject({ code: "disk_full" });
    expect(ctx.logs.some((line) => line.includes("dropped an unexpected message"))).toBe(true);
  });

  it("passes progress on while an export runs", async () => {
    const ctx = setup();
    const progress: number[] = [];
    const exported = ctx.host.export({ source: "/a.mp4", output: "/.a.part", removed: [] }, (fraction) => progress.push(fraction));
    const child = await ready(ctx);
    const id = child.last("export");
    child.deliver({ type: "progress", id, fraction: 0.25 });
    child.deliver({ type: "progress", id, fraction: 0.75 });
    child.deliver({ type: "exported", id, result: { plan, bytes: 10, reencodedFrames: 0, reencodedPackets: 0 } });
    expect((await exported).bytes).toBe(10);
    expect(progress).toEqual([0.25, 0.75]);
  });

  it("fails what is in flight when the worker crashes, and forks a new one for the next request", async () => {
    const ctx = setup();
    const exported = ctx.host.export({ source: "/a.mp4", output: "/.a.part", removed: [] }, () => undefined);
    const child = await ready(ctx);
    child.emit("exit", 139);
    await expect(exported).rejects.toMatchObject({ code: "export_worker_crashed" });
    const next = ctx.host.inspect({ source: "/a.mp4", removed: [] });
    const again = await ready(ctx);
    expect(ctx.children).toHaveLength(2);
    again.deliver({ type: "inspected", id: again.last("inspect"), plan });
    await expect(next).resolves.toEqual(plan);
  });

  it("ends a worker that stops answering pings while it works", async () => {
    const ctx = setup();
    const exported = ctx.host.export({ source: "/a.mp4", output: "/.a.part", removed: [] }, () => undefined);
    exported.catch(() => undefined);
    const child = await ready(ctx);
    await vi.advanceTimersByTimeAsync(2000 * 4);
    await expect(exported).rejects.toMatchObject({ code: "export_worker_unresponsive" });
    expect(child.killed).toBe(true);
  });

  it("keeps a worker that answers its pings", async () => {
    const ctx = setup();
    const exported = ctx.host.export({ source: "/a.mp4", output: "/.a.part", removed: [] }, () => undefined);
    const child = await ready(ctx);
    for (let n = 0; n < 6; n++) {
      await vi.advanceTimersByTimeAsync(2000);
      const ping = child.sent.filter((m) => m.type === "ping").at(-1);
      if (ping && "id" in ping) child.deliver({ type: "pong", id: ping.id });
    }
    expect(child.killed).toBe(false);
    child.deliver({ type: "exported", id: child.last("export"), result: { plan, bytes: 1, reencodedFrames: 0, reencodedPackets: 0 } });
    await expect(exported).resolves.toMatchObject({ bytes: 1 });
  });

  it("asks a cancelled export to stop, and ends the worker if it has not within the bound", async () => {
    const ctx = setup();
    const exported = ctx.host.export({ source: "/a.mp4", output: "/.a.part", removed: [] }, () => undefined);
    exported.catch(() => undefined);
    const child = await ready(ctx);
    ctx.host.cancel();
    expect(child.sent.some((m) => m.type === "cancel")).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(child.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.killed).toBe(true);
    await expect(exported).rejects.toMatchObject({ code: "cancelled" });
  });

  it("does not end a worker whose cancelled export ended in time", async () => {
    const ctx = setup();
    const exported = ctx.host.export({ source: "/a.mp4", output: "/.a.part", removed: [] }, () => undefined);
    const child = await ready(ctx);
    ctx.host.cancel();
    child.deliver({ type: "failed", id: child.last("export"), code: "cancelled", detail: "the export was cancelled" });
    await expect(exported).rejects.toBeInstanceOf(ExportFailure);
    await vi.advanceTimersByTimeAsync(5000);
    expect(child.killed).toBe(false);
  });

  it("ends an idle worker when the edit view closes, but not one that exports", async () => {
    const ctx = setup();
    const exported = ctx.host.export({ source: "/a.mp4", output: "/.a.part", removed: [] }, () => undefined);
    const child = await ready(ctx);
    ctx.host.closeIdle();
    expect(child.killed).toBe(false);
    child.deliver({ type: "exported", id: child.last("export"), result: { plan, bytes: 1, reencodedFrames: 0, reencodedPackets: 0 } });
    await exported;
    ctx.host.closeIdle();
    expect(child.killed).toBe(true);
  });

  it("cancels an export still waiting for its worker, which then never receives it", async () => {
    const ctx = setup();
    const exported = ctx.host.export({ source: "/a.mp4", output: "/.a.part", removed: [] }, () => undefined);
    exported.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.host.exporting).toBe(true);
    ctx.host.cancel();
    await expect(exported).rejects.toMatchObject({ code: "cancelled" });
    const child = await ready(ctx);
    expect(child.sent.filter((m) => m.type === "export")).toEqual([]);
    expect(ctx.host.exporting).toBe(false);
  });

  it("reports an engine that never loads", async () => {
    const ctx = setup();
    const inspected = ctx.host.inspect({ source: "/a.mp4", removed: [] });
    inspected.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    ctx.children[0]!.emit("exit", 3);
    await expect(inspected).rejects.toMatchObject({ code: "export_engine_missing" });
  });
});
