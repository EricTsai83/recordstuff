/**
 * The Recorder's writer when the native engine writes the file (plan 076, D3, behind D7's development flag). The
 * engine captures, encodes, muxes and writes; main keeps the file's lifecycle. This writer reserves the temporary
 * `.recording.mp4` name by creating it empty and exclusively, as FileWriter's open does, publishes the finished file
 * under its final name exactly as FileWriter does (`publishRecording`), and on a failure keeps whatever the engine
 * wrote. Zero bytes are never published.
 *
 * The engine finishes the file after it reported `stopped`, so a slow volume's save is not part of the stop: `finish`
 * first waits for the engine's outcome for this file (`finished`, or the write error that kept it from being finished).
 */
import fs from "node:fs/promises";
import type { EngineFileReport } from "../../shared/protocol";
import type { RecorderWriter } from "./recorder";
import { FileWriteError, NO_MEDIA_DETAIL, classifyOpenError, nodeFs, publishRecording, type FileWriterFs, type FinishTimings } from "./file-writer";

export interface EngineFileWriterOptions {
  io?: FileWriterFs;
  /** The file's size now; defaults to `fs.stat`. */
  size?: (filePath: string) => Promise<number>;
  /**
   * Settles once the engine has finished this file: with its report, or rejecting with the write error (a
   * `FileWriteError`) or the reason the engine ended before finishing it. Undefined when nothing reports.
   */
  outcome?: (recordingPath: string) => Promise<EngineFileReport | undefined>;
}

export class EngineFileWriter implements RecorderWriter {
  preservationUncertain = false;
  finishTimings: FinishTimings | undefined;
  private _bytesWritten = 0;
  private finished: Promise<string> | undefined;
  private abandoned: Promise<string | undefined> | undefined;

  private constructor(
    readonly recordingPath: string,
    readonly finalPath: string,
    private readonly io: FileWriterFs,
    private readonly size: (filePath: string) => Promise<number>,
    private readonly outcome: (recordingPath: string) => Promise<EngineFileReport | undefined>,
  ) {}

  /** Creates `recordingPath` empty and exclusively; a name collision is a hard failure, as for FileWriter. */
  static async open(recordingPath: string, finalPath: string, options: EngineFileWriterOptions = {}): Promise<EngineFileWriter> {
    const io = options.io ?? nodeFs;
    try {
      const handle = await io.open(recordingPath, "wx");
      await handle.close();
    } catch (cause) {
      throw new FileWriteError(classifyOpenError(cause), recordingPath, cause);
    }
    return new EngineFileWriter(recordingPath, finalPath, io,
      options.size ?? (async (file) => (await fs.stat(file)).size), options.outcome ?? (() => Promise.resolve(undefined)));
  }

  get bytesWritten(): number {
    return this._bytesWritten;
  }

  /** The engine writes the file; media never passes through main. */
  append(): Promise<void> {
    return Promise.reject(new Error("the native engine writes this recording; main appends nothing"));
  }

  /** Publishes what the engine finished, once it has; the engine closed the file before it reported that. */
  finish(): Promise<string> {
    if (this.abandoned) return Promise.reject(new Error("EngineFileWriter was abandoned"));
    this.finished ??= this.finishOnce();
    return this.finished;
  }

  private async finishOnce(): Promise<string> {
    let report: EngineFileReport | undefined;
    try {
      report = await this.outcome(this.recordingPath);
    } catch (cause) {
      // What was written stays, under the temporary name: the recorder abandons the writer after this failure.
      throw cause instanceof FileWriteError ? cause : new FileWriteError("output_write_failed", this.recordingPath, cause);
    }
    const began = performance.now();
    this._bytesWritten = await this.size(this.recordingPath);
    if (this._bytesWritten === 0) {
      await this.io.unlink(this.recordingPath).catch(() => undefined);
      throw new FileWriteError("capture_start_failed", this.recordingPath, NO_MEDIA_DETAIL);
    }
    const checked = performance.now();
    const published = await publishRecording(this.io, this.recordingPath, this.finalPath);
    this.finishTimings = { flushMs: 0, finalizeMs: report?.finalizeMs ?? 0, ...(report?.fragmented ? { fragmented: report.fragmented } : {}),
      closeMs: checked - began, ...published.timings };
    return published.target;
  }

  /** Keeps what the engine wrote under the temporary name; an empty file is removed. Never throws; idempotent. */
  abandon(): Promise<string | undefined> {
    this.abandoned ??= (this.finished ? this.finished.then(() => undefined, () => this.keep()) : this.keep());
    return this.abandoned;
  }

  private async keep(): Promise<string | undefined> {
    let size: number;
    try {
      size = await this.size(this.recordingPath);
    } catch (cause) {
      // Already gone (an empty file a failed finish removed), or unreadable: then whether it was kept is unknown.
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") this.preservationUncertain = true;
      return undefined;
    }
    this._bytesWritten = size;
    if (size > 0) return this.recordingPath;
    await this.io.unlink(this.recordingPath).catch(() => undefined);
    return undefined;
  }
}
