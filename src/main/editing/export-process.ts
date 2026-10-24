/**
 * The export worker (plan 085): the entry of the Electron `utilityProcess` main forks while a recording is being
 * edited (export-host.ts). It loads the native engine, whose path is its first argument, and serves `inspect` (the
 * plan for an edit, without writing), `export` (the remux, or an editable recording's render, into a file main
 * reserved, which must not exist) and `extract` (an editable recording's camera or second sound copied into a file
 * of its own for the edit view's preview, plan 087), one at a time, over the parent port; `cancel` stops a running
 * export at its next fragment. Frame bytes never leave
 * this process: main hears only plans, progress and results. A crash in native code ends this process only; main
 * sees it exit and removes the export's unfinished file. The recording is opened read-only by the engine.
 */
import { EXPORT_BENCH_ENV, isExportMainMessage, isExportFailureCode, type ExportFailureCode, type ExportHostMessage, type ExportMainMessage, type ExportPlan, type ExportRequest, type ExportResult, type PreviewTrack } from "../../shared/editing";

interface NativeExport {
  inspect(request: ExportRequest & { join?: string }): Promise<ExportPlan>;
  run(request: ExportRequest & { join?: string }): Promise<ExportResult>;
  cancel(): void;
  streamCopy?(source: string, output: string): Promise<number>;
  /** Plan 087: an editable recording's track copied into a file of its own, for the edit view's preview. */
  extract(source: string, track: PreviewTrack, output: string): Promise<number>;
}

interface EngineModule {
  NativeExport: new (onProgress: (fraction: number) => void) => NativeExport;
}

/** The subset of Electron's `process.parentPort` the worker uses; lets tests pass a fake. */
export interface ParentPort {
  on(event: "message", listener: (message: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

/** A fixture's forced key-frame joins (plan 085's fallback gate), from the environment; never set by the app. */
export const EXPORT_JOIN_ENV = "RECORDSTUFF_EXPORT_JOIN";

/** The engine's rejection `code|detail`, or a worker failure. */
export function failureOf(cause: unknown): { code: ExportFailureCode; detail: string } {
  const message = cause instanceof Error ? cause.message : String(cause);
  const at = message.indexOf("|");
  const code = at > 0 ? message.slice(0, at) : "";
  return isExportFailureCode(code) ? { code, detail: message.slice(at + 1) } : { code: "encode_failed", detail: message };
}

export class ExportWorker {
  /** One request at a time; a second waits for the first. */
  private queue: Promise<void> = Promise.resolve();
  /** The export whose progress is reported, while one runs. */
  private exporting: number | undefined;

  constructor(private readonly port: ParentPort, private readonly engine: NativeExport, private readonly join?: string, private readonly bench = false) {
    port.on("message", ({ data }) => {
      if (!isExportMainMessage(data)) return;
      this.receive(data);
    });
    this.send({ type: "ready" });
  }

  progress(fraction: number): void {
    if (this.exporting !== undefined) this.send({ type: "progress", id: this.exporting, fraction: Math.min(1, Math.max(0, fraction)) });
  }

  private receive(message: ExportMainMessage): void {
    switch (message.type) {
      case "ping": this.send({ type: "pong", id: message.id }); return;
      case "cancel": this.engine.cancel(); return;
      case "inspect": case "export": {
        const run = this.queue.then(() => this.serve(message));
        this.queue = run.catch(() => undefined);
        return;
      }
      case "extract": {
        const { id, request } = message;
        const run = this.queue.then(async () => {
          try { this.send({ type: "extracted", id, bytes: await this.engine.extract(request.source, request.track, request.output) }); }
          catch (cause) { this.send({ type: "failed", id, ...failureOf(cause) }); }
        });
        this.queue = run.catch(() => undefined);
        return;
      }
      case "copy": {
        if (!this.bench || !this.engine.streamCopy) return;
        const { id, request } = message;
        const copy = this.engine.streamCopy;
        const run = this.queue.then(async () => {
          try { this.send({ type: "copied", id, bytes: await copy.call(this.engine, request.source, request.output) }); }
          catch (cause) { this.send({ type: "failed", id, ...failureOf(cause) }); }
        });
        this.queue = run.catch(() => undefined);
        return;
      }
    }
  }

  private async serve(message: ExportMainMessage & { type: "inspect" | "export" }): Promise<void> {
    const request = { ...message.request, ...(this.join ? { join: this.join } : {}) };
    try {
      if (message.type === "inspect") {
        this.send({ type: "inspected", id: message.id, plan: await this.engine.inspect(request) });
      } else {
        this.exporting = message.id;
        const result = await this.engine.run(request);
        this.send({ type: "exported", id: message.id, result });
      }
    } catch (cause) {
      this.send({ type: "failed", id: message.id, ...failureOf(cause) });
    } finally {
      if (this.exporting === message.id) this.exporting = undefined;
    }
  }

  private send(message: ExportHostMessage): void {
    this.port.postMessage(message);
  }
}

// In the utility process: load the engine named by the first argument and serve main.
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (parentPort) {
  const addonPath = process.argv[2];
  try {
    if (!addonPath) throw new Error("no engine path was given");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require(addonPath) as EngineModule;
    let worker: ExportWorker | undefined;
    const engine = new module.NativeExport((fraction) => worker?.progress(fraction));
    const join = process.env[EXPORT_JOIN_ENV];
    worker = new ExportWorker(parentPort, engine, join === "keyFrame" ? join : undefined, process.env[EXPORT_BENCH_ENV] === "1");
  } catch (cause) {
    // Main hears no `ready` and reports the engine missing; the reason goes to its log through stderr.
    console.error(`export worker: the engine could not be loaded from ${addonPath ?? "?"}: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(3);
  }
}
