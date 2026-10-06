import { describe, expect, it } from "vitest";
import { stopDevApp, type StopDevAppOptions } from "./dev-app.mts";

/** A fake clock and process table: `alive` lists, per bundle look, whether the app is running. */
function world(alive: (look: number, signals: string[]) => boolean) {
  let clock = 0, looks = 0;
  const signals: string[] = [];
  const options: StopDevAppOptions = {
    pids: (part) => { if (part === "bundle") looks += 1; return alive(looks, signals) ? [part === "main" ? 1 : 2] : []; },
    signal: (pids, name) => { if (pids.length) signals.push(name); },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  };
  return { options, signals, elapsed: () => clock };
}

describe("stopDevApp", () => {
  it("reports none once the launch has settled without an app", async () => {
    const w = world(() => false);
    expect(await stopDevApp("/E.app", { ...w.options, launchedAt: 0, settleMs: 1000 })).toBe("none");
    expect(w.signals).toEqual([]);
    expect(w.elapsed()).toBe(1000);
  });

  it("waits for a launch still in flight, then quits it through SIGTERM", async () => {
    const w = world((look, signals) => look >= 3 && !signals.includes("SIGTERM"));
    expect(await stopDevApp("/E.app", { ...w.options, launchedAt: 0 })).toBe("quit");
    expect(w.signals).toEqual(["SIGTERM"]);
  });

  it("kills what outlives the grace period", async () => {
    const w = world(() => true);
    expect(await stopDevApp("/E.app", { ...w.options, graceMs: 1000 })).toBe("forced");
    expect(w.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
