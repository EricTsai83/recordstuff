/**
 * Windows ends a session (shutdown, restart, sign-out) without `before-quit` or `will-quit`, so the quit coordinator
 * never runs and a recording in progress is left as its temporary `.recording.mp4`. Windows first asks every window
 * (`query-session-end`): while recording work is pending the end is held, which Windows shows as RecordStuff
 * preventing shutdown, and the normal quit stops and saves the recording, then exits, which lets Windows go on.
 * With nothing pending the session ends as the user chose (Electron: hold it only when ending would lose data).
 * macOS joins its log out to the normal quit and needs none of this. The capture host's window exists whenever a
 * session does; cleanup a failure left after the last window closed has no window to ask, as before.
 *
 * The hold is certain only while a window is visible (Settings open). Windows terminates an app that has no visible
 * top-level window and refuses the end unless it registered a reason with ShutdownBlockReasonCreate, which Electron
 * does not expose (review pass 1, F1): a recording made from the menu bar alone still gets its stop and save started
 * at once, which usually takes tens of milliseconds, but may be terminated before they finish.
 */
import type { App, BrowserWindow, WindowSessionEndEvent } from "electron";

export interface SessionEndDeps {
  app: Pick<App, "on">;
  platform: NodeJS.Platform;
  /** Recording work that ending now would lose: a session, its saving or its cleanup (`Recorder.mediaPending`). */
  mediaPending: () => boolean;
  /** The normal quit, which stops and saves a recording and waits for it (quit-coordinator.ts). */
  quit: () => void;
  log: (message: string) => void;
}

export function holdSessionEnd(deps: SessionEndDeps): void {
  if (deps.platform !== "win32") return;
  deps.app.on("browser-window-created", (_event: unknown, window: Pick<BrowserWindow, "on">) => {
    window.on("query-session-end", (event: WindowSessionEndEvent) => {
      if (!deps.mediaPending()) return;
      event.preventDefault();
      deps.log(`quit: Windows is ending the session (${event.reasons.join(", ") || "no reason given"}); holding it to save the recording`);
      deps.quit();
    });
  });
}
