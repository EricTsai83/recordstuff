/**
 * One desktop round (docs/testing.md#environment-and-shared-machine-use):
 * wake a display that idled off, refuse a password-locked session, and keep
 * the display awake until the runner exits. Synthetic input such as
 * `sendInputEvent` or System Events keystrokes does not reset the macOS idle
 * timer, so a long unattended round would otherwise reach display sleep and,
 * with a password policy, the lock screen. A lock is never bypassed: it makes
 * the round blocked, not a pass or a failure.
 */
import { spawn, spawnSync } from "node:child_process";

/** Exit code for a round that could not run on an available desktop. */
export const DESKTOP_BLOCKED_EXIT = 2;

export class DesktopBlockedError extends Error {}

export interface DesktopProbe {
  platform: NodeJS.Platform;
  /** `undefined` when the lock state cannot be read. */
  locked(): boolean | undefined;
  /** Declares user activity, which turns an idle-slept display back on. */
  wake(): void;
  /** Holds display and idle-sleep prevention until `stop` or the process exits. */
  keepAwake(pid: number): { stop(): void };
}

export interface DesktopRound {
  /** First time a locked session was seen during the round. */
  readonly lockedAt: string | undefined;
  /** One report line describing the desktop during the round. */
  readonly summary: string;
  /** Stops the assertion and lock polling; safe to call more than once. */
  end(): void;
}

/** Reads `CGSSessionScreenIsLocked` from `ioreg -a -n Root -d1`; absent means unlocked. */
export function parseScreenLocked(plist: string): boolean | undefined {
  if (!plist.includes("<key>IOConsoleUsers</key>")) return undefined;
  const match = /<key>CGSSessionScreenIsLocked<\/key>\s*<(true|false)\/>/.exec(plist);
  return match ? match[1] === "true" : false;
}

export const macProbe: DesktopProbe = {
  platform: process.platform,
  locked: () => {
    const result = spawnSync("ioreg", ["-a", "-n", "Root", "-d1"], { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    return result.error || result.status !== 0 ? undefined : parseScreenLocked(result.stdout);
  },
  wake: () => { spawnSync("caffeinate", ["-u", "-t", "1"], { stdio: "ignore", timeout: 5000 }); },
  keepAwake: pid => {
    // `-w` also ends the assertion if this runner is killed before `stop`.
    const child = spawn("caffeinate", ["-d", "-i", "-w", String(pid)], { stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
    return { stop: () => { if (child.exitCode === null) child.kill(); } };
  },
};

export async function beginDesktopRound(options: { probe?: DesktopProbe; pollMs?: number; log?(line: string): void } = {}): Promise<DesktopRound> {
  const probe = options.probe ?? macProbe;
  const log = options.log ?? ((line: string) => console.log(line));
  if (probe.platform !== "darwin") {
    return { lockedAt: undefined, summary: "Desktop: not macOS; no display assertion or lock check.", end() {} };
  }
  probe.wake();
  const initial = probe.locked();
  if (initial) {
    throw new DesktopBlockedError("the screen is locked. Unlock it and run again; automated desktop tests never bypass a password.");
  }
  const hold = probe.keepAwake(process.pid);
  let lockedAt: string | undefined;
  let unknown = initial === undefined;
  const check = (): void => {
    const locked = probe.locked();
    if (locked === undefined) unknown = true;
    if (locked && !lockedAt) {
      lockedAt = new Date().toISOString();
      log(`BLOCKED: the screen locked at ${lockedAt}; this round's results are not a pass or a failure.`);
    }
  };
  const timer = setInterval(check, options.pollMs ?? 2000);
  timer.unref();
  let ended = false;
  log(`Desktop: display kept awake for this round${unknown ? "; lock state unknown" : ""}.`);
  return {
    get lockedAt() { return lockedAt; },
    get summary() {
      return lockedAt
        ? `Desktop: BLOCKED — the screen locked at ${lockedAt}; results from this round are not a pass or a failure.`
        : `Desktop: display kept awake (caffeinate -d -i); ${unknown ? "lock state could not always be read" : "session stayed unlocked"}.`;
    },
    end() {
      if (ended) return;
      ended = true;
      check();
      clearInterval(timer);
      hold.stop();
    },
  };
}
