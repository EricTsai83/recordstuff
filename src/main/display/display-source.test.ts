import { afterEach, describe, expect, it, vi } from "vitest";
import type { DisplayInfo, DisplayPreference } from "../../shared/display";
import { DisplayRequest, describeResolutionTiming, primaryDisplayChoosable, resolveDisplayPreference, selectScreenSource, uniqueDisplay } from "./display-source";
const display: DisplayInfo = { id: "1", label: "Same name", logicalWidth: 100, logicalHeight: 100, scaleFactor: 2, internal: true, primary: true };
const explicit: DisplayPreference = { kind: "display", id: "1", label: "Same name" };
const primary: DisplayPreference = { kind: "primary" };
const source = { display_id: "1" };
const resolve = (preference: DisplayPreference = explicit, displays = [display]) => resolveDisplayPreference({ displays, primaryDisplayId: "1", preference });
afterEach(() => vi.useRealTimers());
describe("display resolution", () => {
  it("requires one exact id, never name/size or list order", () => {
    expect(resolve()).toMatchObject({ ok: true, id: "1" });
    expect(resolve(explicit, [{ ...display, id: "2" }])).toEqual({ ok: false, detail: "target_missing" });
    expect(resolve(explicit, [display, display])).toMatchObject({ ok: false });
    expect(resolve(explicit, [{ ...display, id: "2" }, { ...display, id: "3" }])).toMatchObject({ ok: false });
  });
  it("names a display by an id only one display has, for recording, the Screen row and the way back to Primary alike", () => {
    const other = { ...display, id: "2", primary: false };
    expect([uniqueDisplay([display, other], "2"), uniqueDisplay([display, other], "3"), uniqueDisplay([display, display], "1")]).toEqual([other, undefined, undefined]);
    expect([primaryDisplayChoosable([display, other]), primaryDisplayChoosable([display, display]), primaryDisplayChoosable([other])]).toEqual([true, false, false]);
  });
  it("rejects an ambiguous primary source and applies explicit empty-source precedence", () => {
    for (const sources of [[], [{ display_id: "" }], [source, source]]) {
      expect(selectScreenSource({ preference: explicit, resolution: resolve(), sources })).toMatchObject({ ok: false, code: "display_unavailable" });
    }
    expect(selectScreenSource({ preference: primary, resolution: resolve(primary), sources: [] })).toMatchObject({ ok: false, code: "no_display" });
    expect(selectScreenSource({ preference: primary, resolution: resolve(primary), sources: [{ display_id: "" }] })).toMatchObject({ ok: false, code: "no_display" });
    expect(selectScreenSource({ preference: primary, resolution: resolve(primary), sources: [{ display_id: "2" }, source] })).toMatchObject({ ok: true, source, rule: "primary" });
  });
});
function setup(preference = explicit, platform: NodeJS.Platform = "darwin") {
  let generation = 0;
  let displays = [display];
  /** The request's clock: a test moves it to stand for time an enumeration took. */
  const clock = { ms: 0 };
  const getSources = vi.fn(async () => [source]);
  const selected = vi.fn(); const denied = vi.fn(); const failed = vi.fn(); const callback = vi.fn();
  const request = new DisplayRequest({ preference, platform, snapshot: () => ({ generation, displays, primaryDisplayId: "1" }), getSources, selected, denied, failed, now: () => clock.ms });
  return { request, callback, getSources, selected, denied, failed, clock, change: (next = displays) => { generation++; displays = next; } };
}
describe("bounded request lifetime", () => {
  it("rejects definitely missing targets without enumeration", async () => {
    const x = setup(); x.change([]); await x.request.run(x.callback);
    expect(x.getSources).not.toHaveBeenCalled(); expect(x.denied).toHaveBeenCalledWith("display_unavailable", "target_missing", 1, expect.anything());
  });
  it("retries a transient missing source then grants once (outside macOS, where an empty list is not a refusal)", async () => {
    vi.useFakeTimers(); const x = setup(explicit, "win32"); x.getSources.mockResolvedValueOnce([]);
    const run = x.request.run(x.callback); await vi.runAllTimersAsync(); await run;
    expect(x.getSources).toHaveBeenCalledTimes(2); expect(x.callback).toHaveBeenCalledExactlyOnceWith(source);
  });
  it("bounds source and topology retries to three attempts", async () => {
    vi.useFakeTimers();
    for (const [topology, platform, code] of [[true, "darwin", "display_unavailable"], [false, "win32", "display_unavailable"]] as const) {
      const x = setup(explicit, platform); x.getSources.mockImplementation(async () => { if (topology) x.change(); return topology ? [source] : []; });
      const run = x.request.run(x.callback); await vi.runAllTimersAsync(); await run;
      expect(x.getSources).toHaveBeenCalledTimes(3); expect(x.callback).toHaveBeenCalledTimes(1);
      expect(x.denied).toHaveBeenCalledWith(code, topology ? "topology_changed" : "source_missing", 3, expect.anything());
    }
  });
  it("reports a macOS capture that lists no screen at all as a permission problem, at the first such answer (plan 035 D2, 089 D1)", async () => {
    vi.useFakeTimers();
    for (const [platform, code, attempts] of [["darwin", "permission_denied", 1], ["win32", "no_display", 3]] as const) {
      const x = setup(primary, platform); x.getSources.mockResolvedValue([]);
      const run = x.request.run(x.callback); await vi.runAllTimersAsync(); await run;
      expect(x.getSources).toHaveBeenCalledTimes(attempts);
      expect(x.denied).toHaveBeenCalledExactlyOnceWith(code, "source_missing", attempts, expect.anything());
      expect(x.callback).toHaveBeenCalledExactlyOnceWith(undefined);
    }
    // The displays changed while it listed nothing: retried, as a topology change is, and refused only at the third.
    const moving = setup(primary); moving.getSources.mockImplementation(async () => { moving.change(); return []; });
    const moved = moving.request.run(moving.callback); await vi.runAllTimersAsync(); await moved;
    expect(moving.getSources).toHaveBeenCalledTimes(3);
    expect(moving.denied).toHaveBeenCalledExactlyOnceWith("permission_denied", "topology_changed", 3, expect.anything());
    // Once the displays changed during the request, a later empty answer still gets the retries left.
    const later = setup(primary);
    later.getSources.mockImplementationOnce(async () => { later.change(); return []; }).mockImplementationOnce(async () => []);
    const recovered = later.request.run(later.callback); await vi.runAllTimersAsync(); await recovered;
    expect(later.getSources).toHaveBeenCalledTimes(3);
    expect(later.selected).toHaveBeenCalledExactlyOnceWith(source, "primary", 3, expect.anything(), expect.anything());
    const settled = setup(primary); settled.getSources.mockImplementationOnce(async () => { settled.change(); return []; });
    const after = settled.request.run(settled.callback); await vi.runAllTimersAsync(); await after;
    expect(settled.selected).toHaveBeenCalledExactlyOnceWith(source, "primary", 2, expect.anything(), expect.anything());
    // No display connected at all is still a missing display, not a permission problem.
    const none = setup(primary); none.change([]); none.getSources.mockResolvedValue([]);
    const absent = none.request.run(none.callback); await vi.runAllTimersAsync(); await absent;
    expect(none.denied).toHaveBeenCalledExactlyOnceWith("no_display", "source_missing", 3, expect.anything());
    // A missing primary must never capture another display.
    const other = setup(primary); other.getSources.mockResolvedValue([{ display_id: "2" }]);
    const missing = other.request.run(other.callback); await vi.runAllTimersAsync(); await missing;
    expect(other.selected).not.toHaveBeenCalled();
  });
  it("rechecks topology and exact target after enumeration", async () => {
    const x = setup(); x.getSources.mockImplementation(async () => { x.change([]); return [source]; });
    await x.request.run(x.callback); expect(x.selected).not.toHaveBeenCalled(); expect(x.denied).toHaveBeenCalledWith("display_unavailable", "target_missing", 1, expect.anything());
  });
  it.each([primary, explicit])("cancels hung enumeration and ignores late results after a new start: %j", async (preference) => {
    const x = setup(preference); let complete!: (s: typeof source[]) => void;
    x.getSources.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const run = x.request.run(x.callback); x.request.cancel();
    expect(x.callback).toHaveBeenCalledTimes(1);
    const next = setup(preference); await next.request.run(next.callback);
    complete([source]); await run;
    expect(x.callback).toHaveBeenCalledExactlyOnceWith(undefined); expect(x.selected).not.toHaveBeenCalled(); expect(x.denied).not.toHaveBeenCalled();
    expect(next.selected).toHaveBeenCalledTimes(1);
  });
  it("cancels retry timers and ignores late enumeration errors", async () => {
    vi.useFakeTimers(); const x = setup(); x.getSources.mockResolvedValue([]);
    const run = x.request.run(x.callback); await vi.advanceTimersByTimeAsync(1); x.request.cancel(); await run;
    expect(vi.getTimerCount()).toBe(0); expect(x.getSources).toHaveBeenCalledTimes(1);
    const late = setup(); let reject!: (e: Error) => void;
    late.getSources.mockImplementation(() => new Promise((_resolve, r) => { reject = r; }));
    const pending = late.request.run(late.callback); late.request.cancel(); reject(new Error("denied")); await pending;
    expect(late.denied).not.toHaveBeenCalled(); expect(late.callback).toHaveBeenCalledTimes(1);
  });
  it.each(["darwin", "linux"] as const)("does not retry exceptions, preserving %s mapping", async (platform) => {
    const x = setup(explicit, platform); x.getSources.mockRejectedValue(new Error("permission"));
    await x.request.run(x.callback); expect(x.getSources).toHaveBeenCalledTimes(1);
    expect(x.denied).toHaveBeenCalledWith("capture_start_failed", "source_missing", 1, expect.anything());
  });
});

it("re-enumerates after primary topology changes instead of granting the stale source", async () => {
  vi.useFakeTimers();
  const x = setup(primary);
  x.getSources.mockImplementationOnce(async () => { x.change(); return [source]; });
  const run = x.request.run(x.callback);
  await vi.runAllTimersAsync(); await run;
  expect(x.getSources).toHaveBeenCalledTimes(2);
  expect(x.selected).toHaveBeenCalledExactlyOnceWith(source, "primary", 2, expect.anything(), expect.anything());
});

describe("resolution timing (plan 089 step 1)", () => {
  it("names each enumeration's time, what it listed and the displays present, then the whole request", () => {
    expect(describeResolutionTiming({ enumerations: [{ ms: 3012.4, sources: 0, displays: 2 }, { ms: 2998.6, sources: "error", displays: 2 }], totalMs: 6311.5 }))
      .toBe("timing 3012 ms (0 source(s), 2 display(s)), 2999 ms (threw, 2 display(s)); total 6312 ms");
    expect(describeResolutionTiming({ enumerations: [], totalMs: 0.2 })).toBe("timing no enumeration; total 0 ms");
  });
  it("times every enumeration of a refusal after three empty answers, from the request's start to its answer", async () => {
    vi.useFakeTimers();
    const x = setup(explicit, "win32"); x.clock.ms = 1000;
    x.getSources.mockImplementation(async () => { x.clock.ms += 3000; return []; });
    const run = x.request.run(x.callback); await vi.runAllTimersAsync(); await run;
    const empty = { ms: 3000, sources: 0, displays: 1 };
    expect(x.denied).toHaveBeenCalledExactlyOnceWith("display_unavailable", "source_missing", 3, { enumerations: [empty, empty, empty], totalMs: 9000 });
  });
  it("records an empty answer that a retry then grants", async () => {
    vi.useFakeTimers();
    const x = setup(explicit, "win32");
    x.getSources.mockImplementationOnce(async () => { x.clock.ms += 40; return []; }).mockImplementationOnce(async () => { x.clock.ms += 20; return [source]; });
    const run = x.request.run(x.callback); await vi.runAllTimersAsync(); await run;
    expect(x.selected).toHaveBeenCalledExactlyOnceWith(source, "exact", 2, expect.anything(),
      { enumerations: [{ ms: 40, sources: 0, displays: 1 }, { ms: 20, sources: 1, displays: 1 }], totalMs: 60 });
  });
  it("counts the displays after the enumeration, so a topology change during it shows", async () => {
    const x = setup();
    x.getSources.mockImplementation(async () => { x.clock.ms += 5; x.change([]); return [source]; });
    await x.request.run(x.callback);
    expect(x.denied).toHaveBeenCalledExactlyOnceWith("display_unavailable", "target_missing", 1, { enumerations: [{ ms: 5, sources: 1, displays: 0 }], totalMs: 5 });
  });
  it("times a refusal made before any enumeration and an enumeration that threw", async () => {
    const missing = setup(); missing.change([]); await missing.request.run(missing.callback);
    expect(missing.denied).toHaveBeenCalledWith("display_unavailable", "target_missing", 1, { enumerations: [], totalMs: 0 });
    const threw = setup(); threw.getSources.mockImplementation(async () => { threw.clock.ms += 7; throw new Error("TCC"); });
    await threw.request.run(threw.callback);
    const timing = { enumerations: [{ ms: 7, sources: "error", displays: 1 }], totalMs: 7 };
    expect(threw.failed).toHaveBeenCalledExactlyOnceWith(expect.any(Error), timing);
    expect(threw.denied).toHaveBeenCalledExactlyOnceWith("capture_start_failed", "source_missing", 1, timing);
  });
});

describe("the engine's answer on the screen grant (plan 089, D1)", () => {
  /** An engine answer the test settles; `asked` holds the displays it was asked about. */
  function engine() {
    let settle!: (answer: "granted" | "denied" | "unknown") => void;
    const asked: string[] = [];
    const access = vi.fn((displayId: string) => { asked.push(displayId); return new Promise<"granted" | "denied" | "unknown">((resolve) => { settle = resolve; }); });
    return { access, asked, answer: (a: "granted" | "denied" | "unknown") => settle(a) };
  }
  it("refuses as soon as the engine refuses, while the enumeration still waits", async () => {
    const x = setup(primary); const e = engine(); let listed!: (s: typeof source[]) => void;
    x.getSources.mockImplementation(() => new Promise((resolve) => { listed = resolve; }));
    const run = x.request.run(x.callback, e.access);
    x.clock.ms = 90; e.answer("denied"); await run;
    expect(e.asked).toEqual(["1"]);
    expect(x.denied).toHaveBeenCalledExactlyOnceWith("permission_denied", "source_missing", 1, { enumerations: [], access: { answer: "denied", ms: 90 }, totalMs: 90 });
    expect(x.callback).toHaveBeenCalledExactlyOnceWith(undefined);
    listed([source]); await Promise.resolve();
    expect(x.selected).not.toHaveBeenCalled();
  });
  it("grants by the enumeration whatever the engine says or has not yet said, and asks it once", async () => {
    for (const answer of ["granted", "unknown", undefined] as const) {
      const x = setup(primary); const e = engine();
      x.getSources.mockImplementation(async () => { if (answer) e.answer(answer); await Promise.resolve(); return [source]; });
      await x.request.run(x.callback, e.access);
      expect(x.callback).toHaveBeenCalledExactlyOnceWith(source);
      expect(e.access).toHaveBeenCalledTimes(1);
      expect(x.selected.mock.calls[0]![4].access).toEqual(answer ? { answer, ms: 0 } : "unanswered");
    }
  });
  it("refuses during the wait before a retry when the engine refuses then", async () => {
    vi.useFakeTimers();
    const x = setup(primary); const e = engine();
    x.getSources.mockImplementation(async () => { x.change(); return [source]; });
    const run = x.request.run(x.callback, e.access);
    await vi.advanceTimersByTimeAsync(10); e.answer("denied"); await vi.advanceTimersByTimeAsync(0); await run;
    expect(x.getSources).toHaveBeenCalledTimes(1);
    expect(x.denied).toHaveBeenCalledExactlyOnceWith("permission_denied", "source_missing", 1, expect.anything());
    expect(vi.getTimerCount()).toBe(0);
  });
  it("is not asked outside macOS, and an engine that fails is an unknown answer", async () => {
    const win = setup(primary, "win32"); const e = engine();
    await win.request.run(win.callback, e.access);
    expect(e.access).not.toHaveBeenCalled(); expect(win.selected.mock.calls[0]![4]).not.toHaveProperty("access");
    const x = setup(primary); x.getSources.mockImplementation(async () => { await Promise.resolve(); await Promise.resolve(); return [source]; });
    await x.request.run(x.callback, () => Promise.reject(new Error("gone")));
    expect(x.selected.mock.calls[0]![4].access).toEqual({ answer: "unknown", ms: 0 });
  });
  it("names the engine's answer in the timing line", () => {
    expect(describeResolutionTiming({ enumerations: [], access: { answer: "denied", ms: 81.6 }, totalMs: 82 })).toBe("timing no enumeration; engine access denied 82 ms; total 82 ms");
    expect(describeResolutionTiming({ enumerations: [{ ms: 17, sources: 2, displays: 2 }], access: "unanswered", totalMs: 17 })).toBe("timing 17 ms (2 source(s), 2 display(s)); engine access unanswered; total 17 ms");
  });
});
