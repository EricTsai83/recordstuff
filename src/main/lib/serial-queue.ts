import { drainQueue } from "./drain-queue";

/**
 * Runs tasks one after another, in the order they were given: a store's writes to its file (settings, window size,
 * edit records, the export journal, a recording session's interruption sentinel), a worker's requests, the folder
 * changes of the Recordings tab. A task that fails rejects its own caller only; the next still runs.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** `task`, once every task given before it has settled. */
  run<T>(task: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Settles once every task given so far, and every one given while waiting, has settled (a store before quitting). */
  drain(): Promise<void> {
    return drainQueue(() => this.tail);
  }
}
