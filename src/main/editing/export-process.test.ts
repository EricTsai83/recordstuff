import { describe, expect, it } from "vitest";
import type { ExportHostMessage, ExportPlan, ExportRequest, ExportResult } from "../../shared/editing";
import { ExportWorker, failureOf } from "./export-process";

const plan: ExportPlan = {
  timescale: 90_000, duration: 90_000, outputDuration: 90_000, frames: 30, removed: [], dropped: [],
  parts: [{ requested: 0, start: 0, stop: 90_000, outStart: 0, fellBack: false, reencoded: false }], secondDescription: false, hasAudio: false,
};

function setup(engine: Partial<{ inspect(r: ExportRequest): Promise<ExportPlan>; run(r: ExportRequest): Promise<ExportResult> }> = {}, join?: string) {
  const sent: ExportHostMessage[] = [];
  let listener: ((message: { data: unknown }) => void) | undefined;
  const requests: Array<ExportRequest & { join?: string }> = [];
  let cancelled = 0;
  const extracts: string[] = [];
  const worker = new ExportWorker(
    { on: (_event, handler) => { listener = handler; }, postMessage: (message) => sent.push(message as ExportHostMessage) },
    {
      inspect: async (request) => { requests.push(request); return engine.inspect ? engine.inspect(request) : plan; },
      run: async (request) => { requests.push(request); return engine.run ? engine.run(request) : { plan, bytes: 1, reencodedFrames: 0, reencodedPackets: 0 }; },
      cancel: () => { cancelled++; },
      extract: async (source, track, output) => { extracts.push(`${source}:${track}>${output}`); if (track === "camera" && source === "/broken.mp4") throw new Error("unsupported|the recording has no camera track"); return 7; },
    },
    join,
  );
  const post = (data: unknown): void => listener!({ data });
  const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  return { worker, sent, post, requests, settled, cancels: () => cancelled, extracts };
}

describe("the export worker", () => {
  it("says it is ready, answers pings, and serves an inspection and an export by id", async () => {
    const ctx = setup();
    expect(ctx.sent).toEqual([{ type: "ready" }]);
    ctx.post({ type: "ping", id: 9 });
    ctx.post({ type: "inspect", id: 1, request: { source: "/a.mp4", removed: [] } });
    ctx.post({ type: "export", id: 2, request: { source: "/a.mp4", output: "/.a.part", removed: [{ from: 0, to: 9 }] } });
    await ctx.settled();
    expect(ctx.sent).toContainEqual({ type: "pong", id: 9 });
    expect(ctx.sent).toContainEqual({ type: "inspected", id: 1, plan });
    expect(ctx.sent).toContainEqual({ type: "exported", id: 2, result: { plan, bytes: 1, reencodedFrames: 0, reencodedPackets: 0 } });
  });

  it("ignores what main never sends", async () => {
    const ctx = setup();
    ctx.post({ type: "export", id: 2, request: { source: "/a.mp4", output: 7, removed: [] } });
    ctx.post("rm -rf");
    await ctx.settled();
    expect(ctx.requests).toEqual([]);
    expect(ctx.sent).toEqual([{ type: "ready" }]);
  });

  it("reports the engine's failure by its code, and passes cancel on", async () => {
    const ctx = setup({ run: async () => { throw new Error("disk_full|writing the export: No space left on device"); } });
    ctx.post({ type: "export", id: 3, request: { source: "/a.mp4", output: "/.a.part", removed: [] } });
    ctx.post({ type: "cancel" });
    await ctx.settled();
    expect(ctx.sent).toContainEqual({ type: "failed", id: 3, code: "disk_full", detail: "writing the export: No space left on device" });
    expect(ctx.cancels()).toBe(1);
  });

  it("reports progress for the running export only", async () => {
    let finish!: () => void;
    const ctx = setup({ run: () => new Promise((resolve) => { finish = () => resolve({ plan, bytes: 1, reencodedFrames: 0, reencodedPackets: 0 }); }) });
    ctx.worker.progress(0.1);
    ctx.post({ type: "export", id: 4, request: { source: "/a.mp4", output: "/.a.part", removed: [] } });
    await ctx.settled();
    ctx.worker.progress(0.5);
    finish();
    await ctx.settled();
    ctx.worker.progress(0.9);
    expect(ctx.sent.filter((m) => m.type === "progress")).toEqual([{ type: "progress", id: 4, fraction: 0.5 }]);
  });

  it("forces key-frame joins only when its fixture asks", async () => {
    const ctx = setup({}, "keyFrame");
    ctx.post({ type: "inspect", id: 1, request: { source: "/a.mp4", removed: [] } });
    await ctx.settled();
    expect(ctx.requests[0]!.join).toBe("keyFrame");
  });
});

describe("a preview track's extraction (plan 087)", () => {
  it("is served in turn, and its failure is the engine's", async () => {
    const { post, sent, settled, extracts } = setup();
    post({ type: "extract", id: 3, request: { source: "/a.mp4", track: "sound1", output: "/p/a-sound.mp4" } });
    post({ type: "extract", id: 4, request: { source: "/broken.mp4", track: "camera", output: "/p/b-camera.mp4" } });
    post({ type: "extract", id: 5, request: { source: "/a.mp4", track: "speaker", output: "/p/x.mp4" } });
    await settled();
    await settled();
    expect(extracts).toEqual(["/a.mp4:sound1>/p/a-sound.mp4", "/broken.mp4:camera>/p/b-camera.mp4"]);
    expect(sent).toContainEqual({ type: "extracted", id: 3, bytes: 7 });
    expect(sent).toContainEqual({ type: "failed", id: 4, code: "unsupported", detail: "the recording has no camera track" });
    expect(sent.some((m) => "id" in m && m.id === 5)).toBe(false);
  });
});

describe("the speed reference's copy", () => {
  it("is served only when the benchmark switch is on", async () => {
    const copies: string[] = [];
    const serve = (bench: boolean) => {
      const sent: ExportHostMessage[] = [];
      let listener: ((message: { data: unknown }) => void) | undefined;
      new ExportWorker(
        { on: (_event, handler) => { listener = handler; }, postMessage: (message) => sent.push(message as ExportHostMessage) },
        { inspect: async () => plan, run: async () => ({ plan, bytes: 1, reencodedFrames: 0, reencodedPackets: 0 }), cancel: () => undefined,
          streamCopy: async (source, output) => { copies.push(`${source}>${output}`); return 42; }, extract: async () => 0 },
        undefined,
        bench,
      );
      listener!({ data: { type: "copy", id: 5, request: { source: "/a.mp4", output: "/b.mp4" } } });
      return sent;
    };
    const off = serve(false);
    const on = serve(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(off).toEqual([{ type: "ready" }]);
    expect(on).toContainEqual({ type: "copied", id: 5, bytes: 42 });
    expect(copies).toEqual(["/a.mp4>/b.mp4"]);
  });
});

describe("a failure's code", () => {
  it("is the engine's, or encode_failed for anything else", () => {
    expect(failureOf(new Error("unsupported|not an MP4 file"))).toEqual({ code: "unsupported", detail: "not an MP4 file" });
    expect(failureOf(new Error("boom"))).toEqual({ code: "encode_failed", detail: "boom" });
    expect(failureOf(new Error("delete_everything|x"))).toEqual({ code: "encode_failed", detail: "delete_everything|x" });
  });
});
