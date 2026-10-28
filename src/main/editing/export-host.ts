/**
 * Supervises the export worker (plan 085, export-process.ts) as the capture host is supervised: a `utilityProcess` of
 * its own, forked when the edit view first needs it and ended when the view closes with nothing running, every
 * message it sends checked before use, a crash seen as its exit and a hang as two missed pongs while a request is in
 * flight. A cancelled export that has not ended within `CANCEL_BOUND_MS` is ended with its process, so cancel and quit
 * are bounded however the engine is doing; main then removes the export's unfinished file.
 */
import { utilityProcess, type UtilityProcess } from "electron";
import { isExportHostMessage, type ExportFailureCode, type ExportHostMessage, type ExportMainMessage, type ExportPlan, type ExportRequest, type ExportResult, type ExtractTrack } from "../../shared/editing";
import { pipeLines } from "../lib/pipe-lines";

/** A failed inspection or export: the engine's code, or the worker's own. */
export class ExportFailure extends Error {
  constructor(readonly code: ExportFailureCode, readonly detail: string) {
    super(`${code}: ${detail}`);
  }
}

export interface ExportHostOptions {
  /** The built export-process.js. */
  entryPath: string;
  /** The engine's `.node` file, outside the asar archive. */
  addonPath: string;
  log?: (message: string) => void;
  /** Forks the worker; tests pass a fake. */
  fork?: (entryPath: string, args: string[]) => UtilityProcess;
  readyTimeoutMs?: number;
  pingIntervalMs?: number;
  cancelBoundMs?: number;
}

/** How long a cancelled export may take to end before its process is ended: plan 085's 1 s bound on cancel. */
export const CANCEL_BOUND_MS = 1000;

interface Pending {
  kind: "inspect" | "export" | "extract";
  /** Posted to the worker; until then it waits for the worker to be ready, and a cancel ends it there. */
  sent: boolean;
  resolve: (value: unknown) => void;
  reject: (cause: ExportFailure) => void;
  progress?: (fraction: number) => void;
}

export class ExportHost {
  private child: UtilityProcess | undefined;
  private ready: Promise<UtilityProcess> | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private missedPongs = 0;
  private cancelTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly log: (message: string) => void;

  constructor(private readonly options: ExportHostOptions) {
    this.log = options.log ?? (() => undefined);
  }

  /** Whether an export is in flight. */
  get exporting(): boolean {
    return [...this.pending.values()].some((p) => p.kind === "export");
  }

  /** The engine's plan for an edit, without writing anything. */
  inspect(request: ExportRequest): Promise<ExportPlan> {
    return this.request("inspect", request) as Promise<ExportPlan>;
  }

  /** Copies an editable recording's `track` into `output`, which must not exist, for the edit view's preview (plan 087). */
  extract(request: { source: string; track: ExtractTrack; output: string }): Promise<number> {
    return this.request("extract", request) as Promise<number>;
  }

  /** Exports into `request.output`, which must not exist; `progress` hears the fraction done. */
  export(request: ExportRequest & { output: string }, progress: (fraction: number) => void): Promise<ExportResult> {
    return this.request("export", request, progress) as Promise<ExportResult>;
  }

  /**
   * Asks the running export to stop; it then rejects with `cancelled`. Ended with the process if it has not after
   * `cancelBoundMs`, and rejects with `cancelled` all the same.
   */
  cancel(): void {
    let running = false;
    for (const [id, pending] of [...this.pending]) {
      if (pending.kind !== "export") continue;
      // Still waiting for the worker: it never starts.
      if (!pending.sent) this.settle(id, new ExportFailure("cancelled", "the export was cancelled before it started"));
      else running = true;
    }
    if (!running || !this.child) return;
    this.post({ type: "cancel" });
    if (this.cancelTimer) return;
    const child = this.child;
    this.cancelTimer = setTimeout(() => {
      this.cancelTimer = undefined;
      if (this.child !== child || !this.exporting) return;
      this.log(`export worker: the export did not end ${this.options.cancelBoundMs ?? CANCEL_BOUND_MS} ms after cancel; ending the worker`);
      this.end(new ExportFailure("cancelled", "the export was cancelled"));
    }, this.options.cancelBoundMs ?? CANCEL_BOUND_MS);
  }

  /** Ends the worker when nothing is in flight (the edit view closed); a running export keeps it. */
  closeIdle(): void {
    if (this.pending.size === 0) this.end(undefined);
  }

  /** Ends the worker and fails whatever it was doing (quit after its cancel). */
  close(): void {
    this.end(new ExportFailure("cancelled", "RecordStuff is quitting"));
  }

  /** A request is pending from now on, while the worker starts too, so cancel and quit reach it there. */
  private request(kind: Pending["kind"], request: ExportRequest | { source: string; track: ExtractTrack; output: string }, progress?: (fraction: number) => void): Promise<unknown> {
    const id = this.nextId++;
    const settled = new Promise((resolve, reject) => {
      this.pending.set(id, { kind, sent: false, resolve, reject, ...(progress ? { progress } : {}) });
    });
    void this.start().then(
      (child) => {
        const pending = this.pending.get(id);
        // Cancelled, or failed with the worker, while it started.
        if (!pending) return;
        if (this.child !== child) {
          this.settle(id, new ExportFailure("export_worker_crashed", "the export worker ended before the request was sent"));
          return;
        }
        pending.sent = true;
        this.missedPongs = 0;
        this.pingTimer ??= setInterval(() => this.ping(), this.options.pingIntervalMs ?? 2000);
        this.post({ type: kind, id, request } as ExportMainMessage);
      },
      (cause: unknown) => this.settle(id, cause instanceof ExportFailure ? cause : new ExportFailure("export_engine_missing", String(cause))),
    );
    return settled;
  }

  private start(): Promise<UtilityProcess> {
    if (this.ready) return this.ready;
    const fork = this.options.fork ?? ((entry, args) => utilityProcess.fork(entry, args, { serviceName: "RecordStuff Export", stdio: "pipe" }));
    const child = fork(this.options.entryPath, [this.options.addonPath]);
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) if (stream) pipeLines(stream, (line) => this.log(`export worker: ${line}`));
    const ready = new Promise<UtilityProcess>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ExportFailure("export_engine_missing", "the export worker did not report ready"));
        if (this.child === child) this.end(undefined);
      }, this.options.readyTimeoutMs ?? 8000);
      child.on("message", (message: unknown) => {
        if (!isExportHostMessage(message)) {
          this.log(`export worker: dropped an unexpected message ${JSON.stringify(message)?.slice(0, 200)}`);
          return;
        }
        if (message.type === "ready") {
          clearTimeout(timer);
          resolve(child);
          return;
        }
        if (this.child === child) this.receive(message);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new ExportFailure("export_engine_missing", `the export worker exited with ${code} before it was ready`));
        if (this.child !== child) return;
        this.log(`export worker: exited (${code})${this.pending.size ? " with work in flight" : ""}`);
        this.child = undefined;
        this.ready = undefined;
        // What it had been sent; what was still waiting for it fails with its start.
        this.failAll(new ExportFailure("export_worker_crashed", `the export worker exited with ${code}`), true);
      });
    });
    this.ready = ready;
    ready.catch(() => { if (this.ready === ready) this.ready = undefined; });
    return ready;
  }

  private receive(message: ExportHostMessage): void {
    switch (message.type) {
      case "ready": return;
      case "pong": this.missedPongs = 0; return;
      case "progress": this.pending.get(message.id)?.progress?.(message.fraction); return;
      case "inspected": this.settle(message.id, undefined, message.plan); return;
      case "exported": this.settle(message.id, undefined, message.result); return;
      case "extracted": this.settle(message.id, undefined, message.bytes); return;
      case "failed": this.settle(message.id, new ExportFailure(message.code, message.detail)); return;
    }
  }

  private settle(id: number, failure: ExportFailure | undefined, value?: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (failure) pending.reject(failure);
    else pending.resolve(value);
    if (!this.exporting && this.cancelTimer) {
      clearTimeout(this.cancelTimer);
      this.cancelTimer = undefined;
    }
    if (![...this.pending.values()].some((pending) => pending.sent) && this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private ping(): void {
    if (![...this.pending.values()].some((pending) => pending.sent) || !this.child) return;
    // Two intervals without an answer while work is in flight: the worker's JavaScript thread is stuck.
    if (++this.missedPongs > 2) {
      this.log("export worker: no answer to two pings; ending it");
      this.end(new ExportFailure("export_worker_unresponsive", "the export worker stopped answering"));
      return;
    }
    this.post({ type: "ping", id: this.nextId++ });
  }

  private failAll(failure: ExportFailure, sentOnly = false): void {
    for (const [id, pending] of [...this.pending]) if (!sentOnly || pending.sent) this.settle(id, failure);
  }

  private end(failure: ExportFailure | undefined): void {
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.cancelTimer = undefined;
    if (failure) this.failAll(failure);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    child?.kill();
  }

  private post(message: ExportMainMessage): void {
    this.child?.postMessage(message);
  }
}
