import { afterEach, expect, it, vi } from "vitest";
import { DesktopBlockedError, beginDesktopRound, parseScreenLocked, type DesktopProbe } from "./desktop-session.mts";

const session = (extra = "") => `<plist><dict><key>IOConsoleUsers</key><array><dict>
  <key>kCGSSessionOnConsoleKey</key><true/>${extra}</dict></array></dict></plist>`;
afterEach(() => { vi.useRealTimers(); });

function probe(states: Array<boolean | undefined>, platform: NodeJS.Platform = "darwin") {
  const calls: string[] = [];
  const stop = vi.fn(() => { calls.push("stop"); });
  const fake: DesktopProbe = {
    platform,
    locked: () => { calls.push("locked"); return states.length > 1 ? states.shift() : states[0]; },
    wake: () => { calls.push("wake"); },
    keepAwake: pid => { calls.push(`keepAwake ${pid}`); return { stop }; },
  };
  return { fake, calls, stop };
}

it("reads the console session lock flag and treats an absent flag as unlocked", () => {
  expect(parseScreenLocked(session("<key>CGSSessionScreenIsLocked</key>\n\t\t\t<true/>"))).toBe(true);
  expect(parseScreenLocked(session("<key>CGSSessionScreenIsLocked</key><false/>"))).toBe(false);
  expect(parseScreenLocked(session())).toBe(false);
  expect(parseScreenLocked("unexpected output")).toBeUndefined();
});

it("wakes before checking, refuses a locked session and never holds an assertion for it", async () => {
  const { fake, calls } = probe([true]);
  await expect(beginDesktopRound({ probe: fake, log: vi.fn() })).rejects.toBeInstanceOf(DesktopBlockedError);
  expect(calls).toEqual(["wake", "locked"]);
});

it("keeps the display awake for the runner process and releases it once", async () => {
  const { fake, calls, stop } = probe([false]);
  const round = await beginDesktopRound({ probe: fake, log: vi.fn() });
  expect(calls.slice(0, 3)).toEqual(["wake", "locked", `keepAwake ${process.pid}`]);
  expect(round.summary).toContain("session stayed unlocked");
  round.end(); round.end();
  expect(stop).toHaveBeenCalledOnce();
  expect(round.lockedAt).toBeUndefined();
});

it("marks a round blocked when the screen locks during it", async () => {
  vi.useFakeTimers();
  const log = vi.fn();
  const { fake, stop } = probe([false, false, true]);
  const round = await beginDesktopRound({ probe: fake, pollMs: 1000, log });
  await vi.advanceTimersByTimeAsync(1000);
  expect(round.lockedAt).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1000);
  expect(round.lockedAt).toEqual(expect.any(String));
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining("BLOCKED"));
  round.end();
  expect(round.summary).toContain("BLOCKED");
  expect(stop).toHaveBeenCalledOnce();
});

it("detects a lock that appears just before the round ends", async () => {
  const { fake } = probe([false, true]);
  const round = await beginDesktopRound({ probe: fake, pollMs: 60_000, log: vi.fn() });
  round.end();
  expect(round.lockedAt).toEqual(expect.any(String));
});

it("proceeds with an honest summary when the lock state cannot be read, and does nothing off macOS", async () => {
  const unknown = await beginDesktopRound({ probe: probe([undefined]).fake, log: vi.fn() });
  unknown.end();
  expect(unknown.summary).toContain("could not always be read");
  const { fake, calls } = probe([false], "win32");
  const other = await beginDesktopRound({ probe: fake, log: vi.fn() });
  other.end();
  expect(calls).toEqual([]);
  expect(other.summary).toContain("not macOS");
});
