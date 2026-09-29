/**
 * Opening the app again while it runs opens Settings (plan 053): a user whose
 * menu bar icon is hidden behind the notch or a crowded menu bar has no other
 * visible way in. A second process started on any platform reaches the running
 * one as `second-instance` and then exits on the single-instance lock. On macOS,
 * opening the running app from Finder, Spotlight or the Dock starts no second
 * process; LaunchServices sends a reopen, which Electron reports as `activate`.
 * A notification click or `app.focus()` only makes the app active
 * (`did-become-active`), so neither opens Settings.
 *
 * A click can still arrive as a launch: with a development bundle running,
 * clicking its banner made macOS start the copy registered in /Applications,
 * which reached this one as `second-instance` about 0.5 s later. Whether the
 * registered copy itself is sent a reopen was not observed, so a reopen within
 * `NOTIFICATION_ACTIVATION_MS` of a notification click is taken as the click's
 * activation and ignored.
 */
import { stackOf } from "./errors";

export const NOTIFICATION_ACTIVATION_MS = 2000;

export interface ReopenEvents {
  on(event: "second-instance" | "activate", listener: () => void): unknown;
  removeListener(event: "second-instance" | "activate", listener: () => void): unknown;
}

export interface ReopenWatcher {
  /** Called on every notification click, before its own action. */
  notificationClicked(): void;
  stop(): void;
}

/** `open` goes through the app's action handler, whose quit gate answers false while quitting. */
export function watchReopen(options: {
  events: ReopenEvents;
  platform: string;
  open: () => Promise<boolean | void>;
  log: (message: string) => void;
  /** Monotonic milliseconds. */
  now: () => number;
}): ReopenWatcher {
  let clickedAt: number | undefined;
  const listen = (source: string) => (): void => {
    if (clickedAt !== undefined && options.now() - clickedAt < NOTIFICATION_ACTIVATION_MS) {
      options.log(`reopen: ${source} ignored ${Math.round(options.now() - clickedAt)} ms after a notification click`);
      return;
    }
    void options.open().then(
      (result) => options.log(result === false ? `reopen: ${source} ignored while quitting` : `reopen: ${source}; Settings opened`),
      (cause: unknown) => options.log(`reopen: ${source}; Settings could not open: ${stackOf(cause)}`),
    );
  };
  const subscriptions: Array<["second-instance" | "activate", () => void]> = [["second-instance", listen("second launch")]];
  if (options.platform === "darwin") subscriptions.push(["activate", listen("reopened from Finder or the Dock")]);
  for (const [event, listener] of subscriptions) options.events.on(event, listener);
  return {
    notificationClicked: () => { clickedAt = options.now(); },
    stop: () => { for (const [event, listener] of subscriptions) options.events.removeListener(event, listener); },
  };
}
