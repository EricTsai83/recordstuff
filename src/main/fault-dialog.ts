import { stackOf } from "./errors";

/**
 * What main does with an uncaught exception. It has no window, so an error would otherwise leave
 * no trace at all. Electron's default for the exception case is a modal error box and the process
 * keeps running; keep that, but write the log line first. The box is modal, so a fault that repeats
 * (a timer, a listener) would stack one box per repetition; later ones only reach the log.
 *
 * `showErrorBox` holds main's timers, I/O and log until it is closed (plan 055). While recording
 * work is pending the box therefore waits until that work settles, and the tray says an error
 * occurred meanwhile (plan 056). A fault that also keeps the work from settling is surfaced by that
 * tray line and the log, never by a box that would hold the recording.
 */
export function createUncaughtExceptionHandler(deps: {
  log(message: string): void;
  /** Synchronous and modal: it returns once the user closes it. */
  showErrorBox(): void;
  mediaPending(): boolean;
  whenMediaSettled(): Promise<void>;
  /** The box is waiting for recording work (true) or is being shown (false). */
  held(waiting: boolean): void;
}): (error: unknown) => void {
  let claimed = false;
  // Nothing here may throw: an exception from this handler would end the process.
  const safely = (label: string, action: () => void): void => {
    try { action(); }
    catch (cause) { deps.log(`uncaught exception: ${label} failed: ${String(cause)}`); }
  };
  /** An unreadable answer counts as settled: the box then shows as it did before plan 056. */
  const pending = (): boolean => {
    try { return deps.mediaPending(); }
    catch (cause) { deps.log(`uncaught exception: media check failed: ${String(cause)}`); return false; }
  };
  const settled = (): Promise<void> => {
    try { return deps.whenMediaSettled(); }
    catch (cause) { return Promise.reject(cause); }
  };
  const present = (): void => {
    // A new session cannot start without input, but the box must still never meet one.
    if (pending()) { wait(); return; }
    safely("tray update", () => deps.held(false));
    deps.log("uncaught exception: showing the error box");
    safely("error box", () => deps.showErrorBox());
  };
  const wait = (): void => {
    void settled().then(present, (cause: unknown) => deps.log(`uncaught exception: waiting for recording work failed: ${String(cause)}`));
  };
  return (error) => {
    deps.log(`uncaught exception: ${stackOf(error)}`);
    if (claimed) return;
    claimed = true;
    if (!pending()) { present(); return; }
    deps.log("uncaught exception: error box held until recording work settles");
    safely("tray update", () => deps.held(true));
    wait();
  };
}
