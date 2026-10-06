import { describe, expect, it } from "vitest";
import {
  expectedBannerBody,
  finderSetupScript,
  judgeClick,
  pressBannerScript,
  summarize,
  type ClickObservation,
} from "./notification-acceptance.mts";

const saved = "/Users/eric/Movies/RecordStuff/2026-09-20 01-27-11.mp4";
const good: ClickObservation = {
  finalFront: "RecordStuff",
  fronts: ["TextEdit", "RecordStuff"],
  settingsFocused: true,
  recordingFocused: true,
  bannerBody: "Saved 2026-09-20 01-27-11.mp4",
  appLog: [
    `[2026-09-19T17:27:15.840Z] notification: clicked: ${expectedBannerBody(saved, "en")}`,
    `[2026-09-19T17:27:15.843Z] notification: show saved ${saved}`,
    `[2026-09-19T17:27:15.860Z] show last recording: Recordings with ${saved}`,
  ],
};

describe("notification acceptance judgement (Recordings entry, 2026-10-04)", () => {
  it("passes only when RecordStuff is in front with Settings focused and the entry named the saved file", () => {
    expect(judgeClick("en", "closed", 2, saved, good).verdict).toBe("pass");
  });

  it("reports the front app and Settings focus separately from the entry", () => {
    const behind = judgeClick("en", "behind", 2, saved, { ...good, finalFront: "Finder", fronts: ["Finder"] });
    expect(behind.reasons).toEqual(["frontmost app after the click is Finder, not RecordStuff"]);
    const unfocused = judgeClick("en", "closed", 2, saved, { ...good, settingsFocused: false });
    expect(unfocused.reasons).toEqual(["RecordStuff is in front but its Settings window does not have focus"]);
    // Main logged the entry, but the page did not land on a recording (a player left open, a failed render).
    const unrendered = judgeClick("en", "closed", 2, saved, { ...good, recordingFocused: false });
    expect(unrendered.reasons).toEqual(["Settings is in front but focus is not on a recording in Recordings"]);
  });

  it("names an undelivered click separately from the window facts", () => {
    const r = judgeClick("en", "closed", 5, saved, { ...good, settingsFocused: false, appLog: [] });
    expect(r.verdict).toBe("fail");
    expect(r.reasons).toEqual([
      "no click callback was logged for this saved notification",
      "no Recordings entry was logged for this saved file",
      "RecordStuff is in front but its Settings window does not have focus",
    ]);
  });

  it("does not accept callback or entry evidence for another saved file", () => {
    const r = judgeClick("en", "closed", 1, saved, { ...good, appLog: [
      "notification: clicked: Saved other.mp4", "show last recording: Recordings with /tmp/other.mp4",
    ] });
    expect(r.reasons).toEqual([
      "no click callback was logged for this saved notification",
      "no Recordings entry was logged for this saved file",
    ]);
  });

  it("checks the banner body in the configured language", () => {
    expect(expectedBannerBody(saved, "zh-TW")).toBe("已儲存 2026-09-20 01-27-11.mp4");
    const r = judgeClick("zh-TW", "closed", 1, saved, good);
    expect(r.verdict).toBe("fail");
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toContain('expected "已儲存');
    expect(
      judgeClick("zh-TW", "closed", 1, saved, { ...good, bannerBody: "已儲存 2026-09-20 01-27-11.mp4",
        appLog: [`notification: clicked: ${expectedBannerBody(saved, "zh-TW")}`, good.appLog[2]!],
      }).verdict,
    ).toBe("pass");
  });

  it("marks a missing banner or a missing save as not run, never as pass", () => {
    expect(judgeClick("en", "closed", 3, saved, undefined).verdict).toBe("not-run");
    expect(judgeClick("en", "closed", 3, undefined, good).verdict).toBe("not-run");
  });

  it("builds Finder setup scripts for every state", () => {
    expect(finderSetupScript("closed")).not.toContain("close");
    expect(finderSetupScript("behind")).toContain("make new Finder window to home");
    expect(finderSetupScript("minimized")).toContain("collapsed of w to true");
  });

  it("presses only the banner carrying the app title and this save's body", () => {
    const script = pressBannerScript("RecordStuff", 'Saved a "quoted" 錄影.mp4');
    expect(script).toContain('"RecordStuff"');
    expect(script).toContain('"Saved a \\"quoted\\" 錄影.mp4"');
    expect(script).toContain('starts with "AXNotificationCenter"');
    expect(script).toContain('perform action "AXPress" of b');
  });

  it("needs two passing clicks per language and Finder state and no failure", () => {
    const pass = judgeClick("en", "closed", 1, saved, good);
    const pass2 = { ...pass, click: 2 };
    const notRun = judgeClick("en", "closed", 3, saved, undefined);
    const failed = judgeClick("en", "closed", 2, saved, { ...good, finalFront: "Finder" });
    expect(summarize([pass, pass2, notRun])).toMatchObject({ pass: 2, notRun: 1, ok: true });
    // Only the first click ran: the second-click case was never observed.
    expect(summarize([pass, notRun, notRun])).toMatchObject({ ok: false, uncovered: ["en/closed"] });
    expect(summarize([pass, pass2, failed]).ok).toBe(false);
    // Every group must be covered, not just one.
    expect(summarize([pass, pass2, { ...pass, finderState: "behind" }]).ok).toBe(false);
    expect(summarize([]).ok).toBe(false);
  });
});
