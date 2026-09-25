import { expect, it } from "vitest";
import {
  InputSourceGuard, classify, layoutVerdict, needsActivation, orderCandidates, otherRecordStuffProcesses,
  type Execution, type InputSource, type KeyResult, type LayoutState, type RunOutcome,
} from "./shortcut-layout.mts";

// Characters typed without modifiers, as the helper reports them on this Mac.
const row = (typed: string[]) => Object.fromEntries([29, 18, 19, 20, 21, 23, 22, 26, 28, 25].map((code, i) => [code, typed[i]!]));
const zhuyin: LayoutState = {
  source: "com.apple.inputmethod.TCIM.Zhuyin", layout: "com.apple.keylayout.ZhuyinBopomofo",
  keys: { ...row(["ㄢ", "ㄅ", "ㄉ", "ˇ", "ˋ", "ㄓ", "ˊ", "˙", "ㄚ", "ㄞ"]), 89: "7" },
};
const abc: LayoutState = {
  source: "com.apple.keylayout.ABC", layout: "com.apple.keylayout.ABC",
  keys: { ...row(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]), 89: "7" },
};
const source = (id: string, type: string, extra: Partial<InputSource> = {}): InputSource =>
  ({ id, name: id, type, category: "TISCategoryKeyboardInputSource", selectCapable: true, ...extra });
const enabled = [
  source("com.apple.keylayout.ABC", "TISTypeKeyboardLayout"),
  source("com.apple.inputmethod.TCIM", "TISTypeKeyboardInputMethodModeEnabled", { selectCapable: false }),
  source("com.apple.PressAndHold", "TISTypeCharacterPalette", { category: "TISCategoryPaletteInputSource" }),
  source("com.apple.inputmethod.TCIM.Zhuyin", "TISTypeKeyboardInputMode"),
];

it("accepts a layout only when no number-row key types a digit and keypad 7 still types 7", () => {
  expect(layoutVerdict(zhuyin).qualifies).toBe(true);
  expect(layoutVerdict(abc)).toEqual({ qualifies: false, reason: expect.stringContaining("types 0 1 2 3 4 5 6 7 8 9 on the number row") });
  // A digit anywhere on the row lets the lookup stay on the row for that digit.
  expect(layoutVerdict({ ...zhuyin, keys: { ...zhuyin.keys, 18: "1" } }).qualifies).toBe(false);
  // Without a keypad 7 the lookup falls back to the fixed position and the drill could not fail.
  expect(layoutVerdict({ ...zhuyin, keys: { ...zhuyin.keys, 89: "" } }).qualifies).toBe(false);
});

it("tries the current keyboard source first, then other selectable keyboard sources", () => {
  expect(orderCandidates(enabled, "com.apple.keylayout.ABC")).toEqual({ candidates: [enabled[0], enabled[3]] });
  expect(orderCandidates(enabled, "com.apple.inputmethod.TCIM.Zhuyin")).toEqual({ candidates: [enabled[3], enabled[0]] });
  expect(orderCandidates([enabled[2]!], "com.apple.keylayout.ABC")).toEqual({ blocked: expect.stringContaining("No enabled") });
});

it("blocks a requested source that is not enabled or not a selectable keyboard source", () => {
  expect(orderCandidates(enabled, "com.apple.keylayout.ABC", "com.apple.inputmethod.TCIM.Zhuyin")).toEqual({ candidates: [enabled[3]] });
  for (const requested of ["com.apple.inputmethod.TCIM.Cangjie", "com.apple.inputmethod.TCIM", "com.apple.PressAndHold"]) {
    expect(orderCandidates(enabled, "com.apple.keylayout.ABC", requested)).toEqual({ blocked: expect.stringContaining("never adds or enables") });
  }
});

it("activates input methods but not plain keyboard layouts", () => {
  expect(needsActivation(enabled[3]!)).toBe(true);
  expect(needsActivation(enabled[0]!)).toBe(false);
});

function fakeSources(start: string, options: { failSelect?: string; stuckOn?: string } = {}) {
  let current = start;
  const selects: string[] = [];
  return {
    selects,
    get current() { return current; },
    ops: {
      current: async () => current,
      select: async (id: string) => {
        selects.push(id);
        // A failing call may still have switched, as an interrupted one can.
        if (id === options.failSelect) { current = id; throw new Error(`select ${id} failed`); }
        current = options.stuckOn ?? id;
      },
      wait: async () => undefined,
    },
  };
}

it("restores and confirms the original source after a switch", async () => {
  const fake = fakeSources("com.apple.keylayout.ABC");
  const guard = new InputSourceGuard(fake.ops, "com.apple.keylayout.ABC");
  await guard.select("com.apple.inputmethod.TCIM.Zhuyin");
  expect(await guard.restore()).toEqual({
    original: "com.apple.keylayout.ABC", changed: true, selected: true, restored: "com.apple.keylayout.ABC", confirmed: true,
  });
  expect(fake.selects).toEqual(["com.apple.inputmethod.TCIM.Zhuyin", "com.apple.keylayout.ABC"]);
  // A second restore, as from a later cleanup path, does not switch again.
  await guard.restore();
  expect(fake.selects).toHaveLength(2);
});

it("confirms without switching when nothing changed", async () => {
  const fake = fakeSources("com.apple.inputmethod.TCIM.Zhuyin");
  const guard = new InputSourceGuard(fake.ops, "com.apple.inputmethod.TCIM.Zhuyin");
  await guard.select("com.apple.inputmethod.TCIM.Zhuyin");
  expect(await guard.restore()).toMatchObject({ changed: false, selected: false, confirmed: true });
  expect(fake.selects).toEqual(["com.apple.inputmethod.TCIM.Zhuyin"]);
});

it("restores after a selection that failed part-way", async () => {
  const fake = fakeSources("com.apple.keylayout.ABC", { failSelect: "com.apple.inputmethod.TCIM.Zhuyin" });
  const guard = new InputSourceGuard(fake.ops, "com.apple.keylayout.ABC");
  await expect(guard.select("com.apple.inputmethod.TCIM.Zhuyin")).rejects.toThrow("failed");
  expect(await guard.restore()).toMatchObject({ changed: true, selected: true, confirmed: true });
  expect(fake.current).toBe("com.apple.keylayout.ABC");
});

it("reports a restore that macOS does not confirm as unconfirmed, with the source it reports", async () => {
  const fake = fakeSources("com.apple.keylayout.ABC");
  const guard = new InputSourceGuard(fake.ops, "com.apple.keylayout.ABC", 3);
  await guard.select("com.apple.inputmethod.TCIM.Zhuyin");
  fake.ops.select = async (id: string) => { fake.selects.push(id); };
  expect(await guard.restore()).toMatchObject({
    confirmed: false, restored: "com.apple.inputmethod.TCIM.Zhuyin",
    error: "input source is com.apple.inputmethod.TCIM.Zhuyin, expected com.apple.keylayout.ABC",
  });
  // Unconfirmed restores are retried by the next call.
  await guard.restore();
  expect(fake.selects.filter(id => id === "com.apple.keylayout.ABC")).toHaveLength(2);
});

it("still selects the original when the first query after a switch fails", async () => {
  const fake = fakeSources("com.apple.keylayout.ABC");
  const guard = new InputSourceGuard(fake.ops, "com.apple.keylayout.ABC");
  await guard.select("com.apple.inputmethod.TCIM.Zhuyin");
  let failures = 1;
  const current = fake.ops.current;
  fake.ops.current = async () => { if (failures-- > 0) throw new Error("osascript: timed out"); return current(); };
  expect(await guard.restore()).toEqual({
    original: "com.apple.keylayout.ABC", changed: true, selected: true, restored: "com.apple.keylayout.ABC", confirmed: true,
  });
  expect(fake.selects.at(-1)).toBe("com.apple.keylayout.ABC");
});

it("records a query that never recovers as unconfirmed instead of throwing", async () => {
  const fake = fakeSources("com.apple.keylayout.ABC");
  const guard = new InputSourceGuard({ ...fake.ops, current: async () => { throw new Error("osascript: timed out"); } }, "com.apple.keylayout.ABC", 2);
  expect(await guard.restore()).toMatchObject({ selected: true, confirmed: false, restored: undefined, error: "osascript: timed out" });
  expect(fake.selects).toEqual(["com.apple.keylayout.ABC"]);
});

const key = (keyCode: number, expected: boolean, observed: boolean): KeyResult =>
  ({ name: `key ${keyCode}`, keyCode, accelerator: "a", expected, observed, presses: observed ? 1 : 0 });
const passingKeys = [key(43, true, true), key(26, true, true), key(89, false, false)];
const confirmed = { original: "ABC", changed: true, selected: true, restored: "ABC", confirmed: true };
const exited = (phase: string, extra: Partial<Execution> = {}): Execution =>
  ({ phase, code: 0, stopped: undefined, forced: false, error: undefined, ...extra });
const outcome = (extra: Partial<RunOutcome> = {}): RunOutcome => ({
  drill: false, blocked: [], locked: false, interrupted: false, error: undefined, keys: passingKeys,
  restore: confirmed, processesGone: true, executions: [exited("check")], fixtureCleanup: { registered: false, windows: 0 }, ...extra,
});

it("passes only with every key as expected and complete cleanup", () => {
  expect(classify(outcome())).toMatchObject({ status: "PASS", exitCode: 0 });
  expect(classify(outcome({ keys: [key(43, true, true), key(26, true, false), key(89, false, true)] })))
    .toMatchObject({ status: "FAIL", exitCode: 1, reasons: ["key 26: did not fire", "key 89: fired"] });
  expect(classify(outcome({ keys: [] }))).toMatchObject({ status: "FAIL", reasons: ["no key results"] });
});

it("blocks for missing prerequisites and a lock, but reports cleanup failures first", () => {
  expect(classify(outcome({ blocked: ["No enabled input source"], keys: [], restore: undefined }))).toMatchObject({ status: "BLOCKED", exitCode: 2 });
  expect(classify(outcome({ locked: true }))).toMatchObject({ status: "BLOCKED", exitCode: 2 });
  const unrestored = { ...confirmed, confirmed: false, error: "input source is Zhuyin, expected ABC" };
  expect(classify(outcome({ locked: true, blocked: ["x"], restore: unrestored })))
    .toMatchObject({ status: "FAIL", exitCode: 1, reasons: ["cleanup: input source not restored: input source is Zhuyin, expected ABC"] });
  expect(classify(outcome({ processesGone: false }))).toMatchObject({ status: "FAIL", reasons: ["cleanup: a fixture process group remained"] });
  expect(classify(outcome({ fixtureCleanup: { registered: true, windows: 0 } }))).toMatchObject({ status: "FAIL" });
});

it("fails an interrupted round even when its keys had passed", () => {
  expect(classify(outcome({ interrupted: true, executions: [exited("check", { stopped: "interrupted" })] })))
    .toMatchObject({ status: "FAIL", exitCode: 1, reasons: ["interrupted before completion"] });
});

it("fails passing results from a process that then hung, crashed or had to be killed", () => {
  // Results are written at will-quit, so a shutdown that goes wrong afterwards must still fail the run.
  expect(classify(outcome({ executions: [exited("check", { stopped: "timeout" })] })))
    .toMatchObject({ status: "FAIL", reasons: ["check: stopped after timeout"] });
  expect(classify(outcome({ executions: [exited("check", { code: 134 })] }))).toMatchObject({ status: "FAIL", reasons: ["check: exited with 134"] });
  expect(classify(outcome({ executions: [exited("check", { forced: true })] }))).toMatchObject({ status: "FAIL", reasons: ["check: had to be killed"] });
  expect(classify(outcome({ executions: [exited("activate-2", { error: "Error: spawn EACCES" }), exited("check")] })))
    .toMatchObject({ status: "FAIL", reasons: ["activate-2: Error: spawn EACCES"] });
});

it("never passes the drill and says whether it caught the layout lookup", () => {
  const caught = classify(outcome({ drill: true, keys: [key(43, true, true), key(26, true, false), key(89, false, true)] }));
  expect(caught).toMatchObject({ status: "FAIL", exitCode: 1, drillDetected: true });
  expect(classify(outcome({ drill: true }))).toMatchObject({ status: "FAIL", exitCode: 1, drillDetected: false });
});

it("finds RecordStuff processes that would own the same shortcuts", () => {
  const root = "/Users/eric/personal-project/recordstuff";
  const electron = "/Users/eric/personal-project/recordstuff/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
  const lines = [
    "  101 /Applications/RecordStuff.app/Contents/MacOS/RecordStuff",
    `  102 ${electron} ${root}`,
    `  103 ${electron} /tmp/fixture/shortcut-failure.cjs ${root} /tmp/t /tmp/r normal`,
    `  104 ${electron} /tmp/fixture/shortcut-layout.cjs ${root} /tmp/t /tmp/r check`,
    `  105 ${electron} /Users/eric/other-project`,
    `  106 /usr/local/bin/code ${root}`,
    "  107 /Applications/RecordStuff.app/Contents/Frameworks/RecordStuff Helper.app/Contents/MacOS/RecordStuff Helper --type=renderer",
    // pnpm dev and pnpm preview: electron-vite spawns the checkout's Electron with a relative entry.
    `  108 ${root}/node_modules/.pnpm/electron@44.3.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .`,
    "  109 /Users/eric/other-project/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .",
  ];
  expect(otherRecordStuffProcesses(lines, root, [104]).map(line => line.split(/\s+/)[0])).toEqual(["101", "102", "103", "108"]);
});
