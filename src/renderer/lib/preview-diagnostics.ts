/**
 * The Studio page's half of the pipeline's figures (plan 083): what became of the preview's chunks after the capture
 * process sent them. Kept only once the capture process asked for them (`RECORDSTUFF_DIAGNOSTICS=1`), so the page
 * does nothing more without the development switch; reported and started again every `STUDIO_DIAGNOSTICS_MS`.
 * Bounded: two histograms and a few counters, whatever the recording's length.
 */
import { Histogram, PIPELINE_SCHEMA } from "../../shared/pipeline-histogram";
import type { StudioPreviewDiagnostics } from "../../shared/studio-port";
import type { PreviewMessage } from "./preview-stream";

export class PreviewDiagnostics {
  private on = false;
  private port = new Histogram();
  private decode = new Histogram();
  private counts = { received: 0, drawn: 0, missed: 0, notDecoded: 0, codec: 0, error: 0 };
  /** The last chunk's number on this port: a number skipped is a chunk sent and never received. */
  private last: number | undefined;

  get keeping(): boolean { return this.on; }

  /** Keeps figures from now on. */
  start(): void { this.on = true; }

  /** Keeps none, and forgets what it had. */
  stop(): void {
    this.on = false;
    this.take();
    this.last = undefined;
  }

  /** A new port: its numbers continue the capture process's, but what came between is not this page's to count. */
  joined(): void { this.last = undefined; }

  received(message: PreviewMessage, now: number): void {
    if (!this.on) return;
    this.counts.received += 1;
    this.port.recordMs(now - message.sent);
    if (this.last !== undefined && message.n > this.last + 1) this.counts.missed += message.n - this.last - 1;
    this.last = message.n;
  }

  /** A chunk the decoder could not take: none configured yet, or one waiting for a key frame. */
  notDecoded(): void { if (this.on) this.counts.notDecoded += 1; }

  /** A frame drawn into the canvas `now`, from a chunk received at `received`. */
  drawn(received: number, now: number): void {
    if (!this.on) return;
    this.counts.drawn += 1;
    this.decode.recordMs(now - received);
  }

  /** The decoder started again: for a new stream's codec (the first one included) or after an error. */
  restarted(cause: "codec" | "error"): void { if (this.on) this.counts[cause] += 1; }

  /** The figures since the last report, and a fresh start. */
  take(): StudioPreviewDiagnostics {
    const { received, drawn, missed, notDecoded, codec, error } = this.counts;
    this.counts = { received: 0, drawn: 0, missed: 0, notDecoded: 0, codec: 0, error: 0 };
    return { type: "previewDiagnostics", schema: PIPELINE_SCHEMA, received, drawn, missed, notDecoded, restarts: { codec, error },
      port: this.port.take(), decode: this.decode.take() };
  }
}
