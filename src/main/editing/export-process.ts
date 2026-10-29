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
import { EXPORT_BENCH_ENV, isExportMainMessage, isExportFailureCode, type CopyTrack, type ExportFailureCode, type ExportHostMessage, type ExportMainMessage, type ExportPlan, type ExportRequest, type ExportResult, type ExtractTrack } from "../../shared/editing";
import { SerialQueue } from "../lib/serial-queue";
import { engineRejection } from "../lib/engine-module";

interface NativeExport {
  inspect(request: ExportRequest & { join?: string }): Promise<ExportPlan>;
  run(request: ExportRequest & { join?: string }): Promise<ExportResult>;
  cancel(): void;
  streamCopy?(source: string, output: string): Promise<number>;
  /** Plan 087: an editable recording's track copied into a file of its own, for the edit view's preview. */
  extract(source: string, track: ExtractTrack, output: string): Promise<number>;
  /** Plan 100: tracks copied as they are into one file, with progress; `cancel` stops it. */
  copyTracks?(source: string, tracks: CopyTrack[], output: string): Promise<number>;
  /** Plan 100: Darwin's background policy for this process, on or off; false where there is none. */
  setBackground?(background: boolean): boolean;
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
  const { code, detail } = engineRejection(cause);
  return code !== undefined && isExportFailureCode(code) ? { code, detail } : { code: "encode_failed", detail: cause instanceof Error ? cause.message : String(cause) };
}

export class ExportWorker {
  /** One request at a time; a second waits for the first. */
  private readonly queue = new SerialQueue();
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
        void this.queue.run(() => this.serve(message));
        return;
      }
      case "extract": {
        const { id, request } = message;
        void this.queue.run(async () => {
          try { this.send({ type: "extracted", id, bytes: await this.engine.extract(request.source, request.track, request.output) }); }
          catch (cause) { this.send({ type: "failed", id, ...failureOf(cause) }); }
        });
        return;
      }
      case "tracks": {
        const { id, request } = message;
        void this.queue.run(() => this.background(request.background, async () => {
          const copy = this.engine.copyTracks;
          if (!copy) throw new Error("unsupported|this engine cannot copy tracks");
          this.exporting = id;
          try { this.send({ type: "extracted", id, bytes: await copy.call(this.engine, request.source, request.tracks, request.output) }); }
          finally { if (this.exporting === id) this.exporting = undefined; }
        }).catch((cause: unknown) => this.send({ type: "failed", id, ...failureOf(cause) })));
        return;
      }
      case "copy": {
        if (!this.bench || !this.engine.streamCopy) return;
        const { id, request } = message;
        const copy = this.engine.streamCopy;
        void this.queue.run(async () => {
          try { this.send({ type: "copied", id, bytes: await copy.call(this.engine, request.source, request.output) }); }
          catch (cause) { this.send({ type: "failed", id, ...failureOf(cause) }); }
        });
        return;
      }
    }
  }

  /**
   * Runs `work` under the background policy when it is a version prepared ahead (plan 100), and at the normal priority
   * again afterwards, so what the person asks for next is never throttled.
   */
  private async background<T>(background: true | undefined, work: () => Promise<T>): Promise<T> {
    if (!background) return work();
    this.engine.setBackground?.(true);
    try { return await work(); } finally { this.engine.setBackground?.(false); }
  }

  private async serve(message: ExportMainMessage & { type: "inspect" | "export" }): Promise<void> {
    const { background, ...asked } = message.request;
    const request = { ...asked, ...(this.join ? { join: this.join } : {}) };
    try {
      if (message.type === "inspect") {
        this.send({ type: "inspected", id: message.id, plan: await this.engine.inspect(request) });
      } else {
        this.exporting = message.id;
        const result = await this.background(background, () => this.engine.run(request));
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
