import { expect, it, vi } from "vitest";
import {
  activation, expectedFixtureExit, failureBlocked, judgeActive, lsappinfoName, settingsOutcome, windowActive,
  type FixtureFailure, type SettingsCase, type WindowState,
} from "./settings-activation.mts";

const active: WindowState = { focused: true, visible: true, page: "" };
const inactive: WindowState = { focused: false, visible: true, page: "inactive" };
const hidden: WindowState = { focused: false, visible: false, page: "" };
const pass = (name: string): SettingsCase => ({ name, ok: true, detail: "" });
const round = (cases: SettingsCase[], failure?: FixtureFailure, extra: Partial<Parameters<typeof settingsOutcome>[0]> = {}) =>
  settingsOutcome({ cases, failure, exit: expectedFixtureExit(cases, failure), processClean: true, locked: false, ...extra });

it("counts a window as active only when main and the page both say so", () => {
  expect(windowActive(active)).toBe(true);
  expect(windowActive({ ...active, page: "inactive" })).toBe(false);
  expect(windowActive({ ...active, focused: false })).toBe(false);
  expect(windowActive({ ...active, visible: false })).toBe(false);
  // A page that did not answer cannot contradict a focused, visible window.
  expect(windowActive({ ...active, page: "unreadable" })).toBe(true);
});

it("judges a case that ran on an active window, pass or fail, and does not read the frontmost app", () => {
  const frontmost = vi.fn(() => "ChatGPT");
  const held = activation(active, active, 0, frontmost);
  expect(frontmost).not.toHaveBeenCalled();
  expect(judgeActive("ring", held, true, "solid")).toEqual({ name: "ring", ok: true, detail: "solid", activation: held });
  const failed = judgeActive("ring", held, false, "none");
  expect(failed.ok).toBe(false);
  expect(failed.notRun).toBeUndefined();
  expect(round([failed]).outcome).toBe("fail");
});

it("records a case whose window was inactive before, during or after it as not run, naming the frontmost app", () => {
  const before = judgeActive("ring", activation(inactive, active, 0, () => "ChatGPT"), true, "none");
  expect(before).toMatchObject({ ok: false, notRun: expect.stringContaining("was not active when the case started") });
  expect(before.notRun).toContain("frontmost app: ChatGPT");
  expect(before.notRun).toContain("data-window inactive");
  const during = judgeActive("ring", activation(active, active, 2, () => undefined), false, "none");
  expect(during.notRun).toContain("lost activation during the case (2 blur events");
  expect(during.notRun).toContain("frontmost app: unknown");
  const after = judgeActive("ring", activation(active, hidden, 0, () => "Finder"), false, "none");
  expect(after.notRun).toContain("was not active when the case was judged (focused false, visible false, data-window unset)");
  // A pass read while inactive is not a pass either.
  expect(before.ok).toBe(false);
});

it("ends a round with not-run cases blocked, unless a judged case failed", () => {
  const notRun = judgeActive("ring", activation(inactive, inactive, 0), true, "none");
  expect(round([pass("a"), notRun])).toEqual({ outcome: "blocked", reasons: ["1 case did not run because the window was not active"] });
  expect(round([pass("a"), notRun, { name: "b", ok: false, detail: "" }])).toEqual({ outcome: "fail", reasons: ["1 case failed"] });
  expect(round([pass("a"), pass("b")])).toEqual({ outcome: "pass", reasons: [] });
});

it("classifies a capture that threw as blocked only when the shown window was inactive or hidden at that moment", () => {
  const capture = (window: WindowState | undefined, shown = true): FixtureFailure =>
    ({ error: "UnknownVizError", screenshot: "focus-tab-en-light-minimum.png", window, shown, frontmost: "ChatGPT" });
  expect(failureBlocked(capture(inactive))).toBe(true);
  expect(failureBlocked(capture(hidden))).toBe(true);
  expect(failureBlocked(capture(active))).toBe(false);
  // Before the fixture shows its window, a hidden window is expected; a failed capture there is a failure.
  expect(failureBlocked(capture(hidden, false))).toBe(false);
  expect(failureBlocked(capture(undefined))).toBe(false);
  expect(failureBlocked({ error: "Could not open t-d2" })).toBe(false);

  const kept = [pass("a"), pass("b")];
  const blocked = round(kept, capture(inactive));
  expect(blocked.outcome).toBe("blocked");
  expect(blocked.reasons[0]).toContain("capturing focus-tab-en-light-minimum.png failed while the window was not active");
  expect(blocked.reasons[0]).toContain("frontmost app: ChatGPT");
  expect(round(kept, capture(active))).toEqual({ outcome: "fail",
    reasons: ["the fixture stopped: capturing focus-tab-en-light-minimum.png: UnknownVizError"] });
  expect(round(kept, { error: "Could not open t-d2" }).outcome).toBe("fail");
  // A judged failure before a blocked capture still fails the round.
  expect(round([{ name: "a", ok: false, detail: "" }], capture(inactive)).outcome).toBe("fail");
});

it("fails a round whose fixture exit or process cleanup disagrees with its results, and blocks a locked one", () => {
  expect(expectedFixtureExit([pass("a")], undefined)).toBe(0);
  expect(expectedFixtureExit([{ name: "a", ok: false, detail: "", notRun: "x" }], undefined)).toBe(1);
  expect(expectedFixtureExit([pass("a")], { error: "x" })).toBe(2);
  expect(expectedFixtureExit([], undefined)).toBe(1);
  expect(round([pass("a")], undefined, { exit: 1 })).toEqual({ outcome: "fail", reasons: ["the fixture exited 1, not 0"] });
  expect(round([pass("a")], undefined, { exit: null }).reasons).toEqual(["the fixture exited by signal, not 0"]);
  expect(round([pass("a")], undefined, { processClean: false }).reasons).toEqual(["the fixture's process did not exit cleanly; see cleanup.json"]);
  expect(round([], undefined).reasons).toEqual(["the fixture recorded no cases"]);
  expect(round([{ name: "a", ok: false, detail: "" }], undefined, { locked: true }).outcome).toBe("blocked");
});

it("reads the app name from lsappinfo", () => {
  expect(lsappinfoName('"LSDisplayName"="ChatGPT"\n')).toBe("ChatGPT");
  expect(lsappinfoName('"CFBundleName"="Finder"')).toBe("Finder");
  expect(lsappinfoName("")).toBeUndefined();
});
