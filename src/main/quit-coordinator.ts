/** Production before-quit wiring, also used by the isolated Electron lifecycle fixture. */
export interface QuitApp {
  on(event: "before-quit", listener: (event: { preventDefault(): void }) => void): unknown;
  quit(): void;
}

export function installQuitCoordinator(app: QuitApp, deps: {
  shutdown(): Promise<boolean>;
  pending(): void;
  error(cause: unknown): void;
  relaunch?(): void;
}): { relaunch(): void } {
  let admitted = false;
  let active = false;
  let relaunchRequested = false;
  app.on("before-quit", (event) => {
    if (admitted) return;
    event.preventDefault();
    if (active) return;
    active = true;
    void (async () => {
      const safe = await deps.shutdown();
      if (safe) {
        if (relaunchRequested) deps.relaunch?.();
        admitted = true;
        app.quit();
      } else { relaunchRequested = false; deps.pending(); }
    })().catch((cause: unknown) => { relaunchRequested = false; deps.error(cause); deps.pending(); }).finally(() => {
      active = false;
    });
  });
  return { relaunch: () => { relaunchRequested = true; app.quit(); } };
}
