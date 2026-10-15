/**
 * Fault points of the controlled acceptance build (plan 035), free of Electron so they
 * can be tested against the production FileWriter, Recorder and failure history. Only
 * a throwaway source copy made by acceptance:controlled imports this; no production
 * module does. Every fault is off until the runner arms it.
 */
import { FileWriteError, FileWriter, nodeFs, type FileWriterFs, type WritableHandle } from "../../src/main/recording/file-writer";
import { EngineFileWriter } from "../../src/main/recording/engine-file-writer";
import type { EngineFileReport } from "../../src/shared/protocol";
import type { RecorderHost } from "../../src/main/recording/recorder";
import type { ResultStorage } from "../../src/main/recording/recording-result-store";
import type { RecordingFailure, RecordingResult } from "../../src/shared/recording-result";
import { FAULT_MODES, isFaultMode, type FaultName, type Faults, type HoldTarget } from "./controlled-modes";

function fault(code: "EIO" | "ENOSPC", syscall: string, file: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: controlled acceptance fault on ${syscall} ${file}`), { code, syscall, path: file });
}

export class ControlledFaults {
  private readonly current: Faults = { cleanup: "off", write: "off", close: "off", "history-save": "off", prepare: "off" };
  private readonly held: Record<HoldTarget, Array<() => void>> = { cleanup: [], "history-save": [], "history-load": [], prepare: [] };

  constructor(
    private readonly note: (event: string, detail?: object) => void = () => undefined,
    /** Holds the first history load, which happens once per process at launch. */
    private holdLoad = false,
  ) {}

  get faults(): Faults { return { ...this.current }; }

  get heldCounts(): Record<HoldTarget, number> {
    return { cleanup: this.held.cleanup.length, "history-save": this.held["history-save"].length,
      "history-load": this.held["history-load"].length, prepare: this.held.prepare.length };
  }

  set(name: FaultName, mode: string): void {
    if (!isFaultMode(name, mode)) throw new Error(`${name} has no mode ${JSON.stringify(mode)}; choose ${FAULT_MODES[name].join(", ")}`);
    (this.current as Record<FaultName, string>)[name] = mode;
    this.note("fault set", { name, mode });
  }

  /** Lets every operation currently held on `target` continue; later ones hold again while armed. */
  release(target: HoldTarget): number {
    const waiting = this.held[target].splice(0);
    for (const resume of waiting) resume();
    this.note("released", { target, count: waiting.length });
    return waiting.length;
  }

  private hold(target: HoldTarget, detail: object): Promise<void> {
    this.note("holding", { target, ...detail });
    return new Promise(resolve => this.held[target].push(resolve));
  }

  /** The production FileWriter's file system, with the write and close faults in its handle. */
  readonly io: FileWriterFs = { ...nodeFs, open: async (file, flags) => this.handle(await nodeFs.open(file, flags), file) };

  readonly openWriter = (recordingPath: string, finalPath: string): Promise<FileWriter> =>
    FileWriter.open(recordingPath, finalPath, { io: this.io });

  /**
   * The native engine's writer (plan 076). The engine writes and closes the file itself, so the close fault comes
   * where its outcome does: once the engine really finished the file, the outcome fails as a failed close would,
   * and the file stays under its temporary name. The write fault is the host's (`host`).
   */
  readonly openEngineWriter = (recordingPath: string, finalPath: string,
    outcome: (recordingPath: string) => Promise<EngineFileReport | undefined>): Promise<EngineFileWriter> =>
    EngineFileWriter.open(recordingPath, finalPath, { outcome: async file => {
      const report = await outcome(file);
      if (this.current.close === "fail") {
        this.current.close = "off";
        this.note("close failed", { file });
        throw new FileWriteError("output_write_failed", file, fault("EIO", "close", file));
      }
      return report;
    } });

  private handle(inner: WritableHandle, file: string): WritableHandle {
    let written = 0;
    return {
      write: async data => {
        // Only a file that already holds data fails, so the failure keeps a partial.
        const mode = this.current.write;
        if (written > 0 && mode !== "off") {
          this.current.write = "off";
          this.note("write failed", { file, mode, bytesBefore: written });
          throw fault(mode === "enospc" ? "ENOSPC" : "EIO", "write", file);
        }
        const result = await inner.write(data);
        written += result.bytesWritten;
        return result;
      },
      // Making the saved file a plain MP4 goes through unchanged, as in the app.
      ...(inner.writeAt ? { writeAt: (data: Uint8Array, position: number) => inner.writeAt!(data, position) } : {}),
      ...(inner.truncate ? { truncate: (length: number) => inner.truncate!(length) } : {}),
      sync: () => inner.sync(),
      close: async () => {
        // The descriptor is released first; only the confirmation fails.
        await inner.close();
        if (this.current.close === "fail") {
          this.current.close = "off";
          this.note("close failed", { file });
          throw fault("EIO", "close", file);
        }
      },
    };
  }

  /**
   * The production capture host with its `prepared` reply held in main while `prepare` is
   * armed (plan 065): the host has its stream and waits for `record`, the Recorder still reads
   * starting, so a long start lasts until `release prepare`. A reply released after the
   * attempt was cancelled reaches the Recorder as a stale session's, which stops it again.
   */
  host(inner: RecorderHost): RecorderHost {
    return {
      start: (sessionId, quality, recordingPath) => inner.start(sessionId, quality, recordingPath),
      record: sessionId => inner.record(sessionId),
      stop: sessionId => inner.stop(sessionId),
      onFailure: listener => inner.onFailure(listener),
      onMessage: listener => inner.onMessage(message => {
        // The native engine's write fault (plan 076): after media arrived, the engine says it could not write, as it
        // does for a full or failing volume, so the recording fails with its partial kept.
        const write = this.current.write;
        if (message.type === "progress" && message.bytes > 0 && write !== "off") {
          this.current.write = "off";
          listener(message);
          this.note("write failed", { session: message.sessionId, mode: write, bytesBefore: message.bytes });
          listener({ type: "writeError", sessionId: message.sessionId, code: write === "enospc" ? "disk_full" : "output_write_failed",
            detail: `${write === "enospc" ? "ENOSPC" : "EIO"}: controlled acceptance fault on the engine's write` });
          return;
        }
        if (message.type !== "prepared" || this.current.prepare !== "hold") { listener(message); return; }
        void this.hold("prepare", { sessionId: message.sessionId }).then(() => listener(message));
      }),
    };
  }

  /**
   * Runs before a failure result reaches the history. While cleanup is held, a
   * settled result waits, so the pending result (processing, Got it disabled)
   * stays on screen; the file work behind it has already finished.
   */
  async beforePublish(result: RecordingFailure): Promise<void> {
    if (result.outcome !== "pending" && this.current.cleanup === "hold") {
      await this.hold("cleanup", { id: result.id, code: result.code, outcome: result.outcome });
    }
  }

  /** The production history store behind a boundary that can delay its load and hold or reject saves. */
  storage(inner: ResultStorage): ResultStorage {
    const faults = this;
    return {
      async load(): Promise<RecordingResult[]> {
        if (faults.holdLoad) {
          faults.holdLoad = false;
          await faults.hold("history-load", {});
        }
        return inner.load();
      },
      async save(results: readonly RecordingResult[]): Promise<void> {
        if (faults.current["history-save"] === "hold") await faults.hold("history-save", { records: results.length });
        if (faults.current["history-save"] === "fail") {
          faults.note("history save failed", { records: results.length });
          throw fault("EIO", "write", "recording-history.json");
        }
        await inner.save(results);
      },
    };
  }
}
