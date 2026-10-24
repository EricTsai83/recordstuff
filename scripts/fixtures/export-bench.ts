/**
 * `pnpm bench:export`'s Electron main (plan 085's speed, memory and cancel gates): forks the production export worker
 * (out/main/export-process.js, the engine it loads from out/native) as the app does, with the benchmark switch that
 * lets it serve a plain streaming copy, and for each source measures that copy, a remux with cuts on key frames (the
 * pure copy path), a remux with joins inside groups of pictures (two re-encoded runs), the worker's memory from
 * Electron's process metrics, and how long a cancelled export takes to end. One JSON line per result on stdout.
 */
import { app, utilityProcess } from "electron";
import fs from "node:fs";
import path from "node:path";

interface Source { size: string; path: string; seconds: number }
interface Config { worker: string; addon: string; outDir: string; sources: Source[]; repeat: number; cancels: number }

const config = JSON.parse(fs.readFileSync(process.argv.at(-1)!, "utf8")) as Config;
const emit = (record: Record<string, unknown>): void => { process.stdout.write(`${JSON.stringify(record)}\n`); };
const TICKS = 90_000;

interface Worker {
  ask(message: Record<string, unknown>): { answer: Promise<Record<string, unknown>> };
  cancel(): void;
  /** The worker's working set now, and the highest sampled since `reset`, in KiB. */
  memory(): { now: number; peak: number };
  reset(): void;
  end(): void;
}

/** Forks the production worker as the app does, with the benchmark switch, and waits for it to load the engine. */
async function fork(): Promise<Worker> {
  const child = utilityProcess.fork(config.worker, [config.addon], {
    serviceName: "RecordStuff Export Bench",
    stdio: "inherit",
    env: { ...process.env, RECORDSTUFF_EXPORT_BENCH: "1" },
  });
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  child.on("message", (message: Record<string, unknown>) => {
    if (message["type"] === "ready") ready();
    const id = message["id"];
    if (typeof id === "number" && message["type"] !== "progress") waiting.get(id)?.(message);
  });
  const crashed = (code: number): void => { emit({ kind: "fatal", detail: `the worker exited with ${code}` }); app.exit(1); };
  child.on("exit", crashed);
  await started;
  const metric = (): number => app.getAppMetrics().find((m) => m.pid === child.pid)?.memory.workingSetSize ?? 0;
  let peak = 0;
  const sampler = setInterval(() => { peak = Math.max(peak, metric()); }, 20);
  let next = 1;
  return {
    ask: (message) => {
      const id = next++;
      const answer = new Promise<Record<string, unknown>>((resolve) => waiting.set(id, resolve));
      child.postMessage({ ...message, id });
      return { answer };
    },
    cancel: () => child.postMessage({ type: "cancel" }),
    memory: () => ({ now: metric(), peak: Math.max(peak, metric()) }),
    reset: () => { peak = metric(); },
    end: () => { clearInterval(sampler); child.off("exit", crashed); child.kill(); },
  };
}

app.whenReady().then(async () => {
  const output = path.join(config.outDir, "bench-output.mp4");
  const clear = (): void => fs.rmSync(output, { force: true });
  const range = (from: number, to: number) => ({ from: Math.round(from * TICKS), to: Math.round(to * TICKS) });
  /** One request in a worker of its own, so its peak is its own: the worker settles a second first, as at rest. */
  const measure = async (message: Record<string, unknown>) => {
    const worker = await fork();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    clear();
    const rest = worker.memory().now;
    worker.reset();
    const began = performance.now();
    const answer = await worker.ask(message).answer;
    const ms = performance.now() - began;
    const peak = worker.memory().peak;
    worker.end();
    return { ms, restKb: rest, peakKb: peak, answer };
  };

  const remuxMs = new Map<string, number>();
  for (const source of config.sources) {
    const bytes = fs.statSync(source.path).size;
    // Cuts a sixth of the way in, a sixth of its length long: on whole seconds (key frames) or half a second in.
    const at = Math.floor(source.seconds / 6), length = Math.max(1, Math.floor(source.seconds / 6));
    const aligned = [range(at, at + length)];
    const inside = [range(at + 0.5, at + length + 0.5), range(at * 3 + 0.5, at * 3 + 1.25)];
    for (let round = 1; round <= config.repeat; round++) {
      for (const [kind, message] of [
        ["copy", { type: "copy", request: { source: source.path, output } }],
        ["remux", { type: "export", request: { source: source.path, output, removed: aligned } }],
        ["joins", { type: "export", request: { source: source.path, output, removed: inside } }],
      ] as const) {
        const { ms, restKb, peakKb, answer } = await measure(message);
        if (kind === "remux") remuxMs.set(source.size, ms);
        const written = answer["type"] === "copied" ? answer["bytes"] : (answer["result"] as { bytes?: number } | undefined)?.bytes;
        const result = answer["result"] as { reencodedFrames?: number; reencodedPackets?: number } | undefined;
        emit({ kind, size: source.size, round, sourceBytes: bytes, bytes: written ?? null, ms, restKb, peakKb,
          ...(answer["type"] === "failed" ? { error: `${answer["code"]}: ${answer["detail"]}` } : {}),
          ...(result ? { reencodedFrames: result.reencodedFrames, reencodedPackets: result.reencodedPackets } : {}) });
      }
    }
  }
  // Cancel: the largest source's remux, cancelled at a random moment within its run, as long as it took above.
  const largest = config.sources.reduce((a, b) => (fs.statSync(a.path).size >= fs.statSync(b.path).size ? a : b));
  const runMs = Math.max(50, (remuxMs.get(largest.size) ?? 500) * 0.8);
  const worker = await fork();
  for (let round = 1; round <= config.cancels; round++) {
    clear();
    const at = Math.floor(largest.seconds / 6);
    const { answer } = worker.ask({ type: "export", request: { source: largest.path, output, removed: [range(at, at + 1)] } });
    await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * runMs));
    const began = performance.now();
    worker.cancel();
    const ended = await answer;
    emit({ kind: "cancel", size: largest.size, round, ms: performance.now() - began, outcome: ended["type"] === "failed" ? ended["code"] : ended["type"] });
  }
  worker.end();
  clear();
  emit({ kind: "done" });
  app.exit(0);
});
