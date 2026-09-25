/** Production before-quit wiring, also used by the isolated Electron lifecycle fixtures. */
export interface QuitApp {
  on(event: "before-quit", listener: (event: { preventDefault(): void }) => void): unknown;
  quit(): void;
}

/**
 * Media first, metadata second: `history` runs only once capture and all disk
 * work are safe, while capture admission stays closed. It resolves whether
 * exit is admitted; declining it calls `resume` to admit recordings again.
 */
export function installQuitCoordinator(app: QuitApp, deps: {
  shutdown(): Promise<boolean>;
  pending(): void;
  error(cause: unknown): void;
  relaunch?(): void;
  history?(): Promise<boolean>;
  resume?(): void;
  /** A repeated request joined the running attempt. */
  joined?(): void;
}): { relaunch(): void } {
  let admitted = false;
  let active = false;
  let relaunchRequested = false;
  app.on("before-quit", (event) => {
    if (admitted) return;
    event.preventDefault();
    if (active) { deps.joined?.(); return; }
    active = true;
    let mediaSafe = false;
    void (async () => {
      if (!await deps.shutdown()) { relaunchRequested = false; deps.pending(); return; }
      mediaSafe = true;
      if (deps.history && !await deps.history()) { relaunchRequested = false; deps.resume?.(); return; }
      if (relaunchRequested) deps.relaunch?.();
      admitted = true;
      app.quit();
    })().catch((cause: unknown) => {
      relaunchRequested = false;
      deps.error(cause);
      if (mediaSafe) deps.resume?.(); else deps.pending();
    }).finally(() => {
      active = false;
    });
  });
  return { relaunch: () => { relaunchRequested = true; app.quit(); } };
}
