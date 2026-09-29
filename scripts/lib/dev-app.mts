/**
 * Stopping this checkout's development Electron.app, which `matrix` and
 * `measure:finalization` launch through `open -W` one at a time. Both used to
 * keep their own copy of this and had already drifted.
 */
import { electronPattern, pgrepPids, signalPids } from "./processes.mts";

/** How long an app may take to stop, save and quit through before-quit before it is killed. */
export const QUIT_GRACE_MS = 30_000;
/**
 * How long after a launch its app may still appear: `open` hands the request
 * to Launch Services, and stopping the launcher does not withdraw it, so a
 * first empty look is not yet "no app".
 */
export const LAUNCH_SETTLE_MS = 5_000;
/** How long a stopped app's `open -W` launcher gets to return, so the next `open` launches a new app instead of bringing this one forward. */
export const LAUNCHER_EXIT_MS = 5_000;

export type AppStop = "none" | "quit" | "forced";

export interface StopDevAppOptions {
  /** When the app was launched; before `LAUNCH_SETTLE_MS` has passed an empty look waits for it to appear. */
  launchedAt?: number;
  graceMs?: number;
  settleMs?: number;
  /** For tests: the processes of the bundle, or of its main process only. */
  pids?: (part: "bundle" | "main") => number[];
  signal?: (pids: readonly number[], name: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Stops the app through its normal quit: SIGTERM reaches Electron's
 * before-quit, where a recording in progress is stopped and saved first.
 * Whatever still runs after the grace period is killed. A launch still in
 * flight is waited for, so it cannot start recording after the stop.
 */
export async function stopDevApp(appPath: string, options: StopDevAppOptions = {}): Promise<AppStop> {
  const pids = options.pids ?? ((part) => pgrepPids(electronPattern(appPath, part)));
  const signal = options.signal ?? signalPids;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const settled = (options.launchedAt ?? 0) + (options.settleMs ?? LAUNCH_SETTLE_MS);
  while (pids("bundle").length === 0) {
    if (now() >= settled) return "none";
    await sleep(250);
  }
  signal(pids("main"), "SIGTERM");
  for (const deadline = now() + (options.graceMs ?? QUIT_GRACE_MS); now() < deadline;) {
    if (pids("bundle").length === 0) return "quit";
    await sleep(250);
  }
  signal(pids("bundle"), "SIGKILL");
  return "forced";
}
