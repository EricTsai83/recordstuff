import { describe, expect, it } from "vitest";
import {
  expectedBannerBody,
  fileSelected,
  finderSetupScript,
  judgeClick,
  pressBannerScript,
  samePath,
  summarize,
  type ClickObservation,
} from "./notification-acceptance.mts";

const saved = "/Users/eric/Movies/RecordStuff/2026-09-20 01-27-11.mp4";
const good: ClickObservation = {
  finalFront: "Finder",
  fronts: ["Finder"],
  selected: saved,
  selectedRow: "2026-09-20 01-27-11.mp4",
  windowTarget: "/Users/eric/Movies/RecordStuff/",
  bannerBody: "Saved 2026-09-20 01-27-11.mp4",
  appLog: [`[2026-09-19T17:27:15.843Z] notification: reveal requested ${saved}`],
};

describe("notification acceptance judgement (plan 014)", () => {
  it("passes only when Finder is frontmost and shows the saved file", () => {
    expect(judgeClick("en", "closed", 2, saved, good).verdict).toBe("pass");
  });

  it("reports file selection and foreground separately when Finder stayed behind", () => {
    // The v0.1.0 report: Finder selected the file, the windowless app stayed frontmost.
    const r = judgeClick("en", "behind", 2, saved, { ...good, finalFront: "RecordStuff", fronts: ["RecordStuff"] });
    expect(r.verdict).toBe("fail");
    expect(r.reasons).toEqual(["frontmost app after the click is RecordStuff, not Finder"]);
  });

  it("names an undelivered click separately from the Finder facts", () => {
    // Seen on macOS 26: the banner was pressed, the app was activated, but no reveal ran.
    const r = judgeClick("en", "closed", 5, saved, {
      ...good,
      finalFront: "RecordStuff",
      selected: undefined,
      selectedRow: undefined,
      windowTarget: undefined,
      appLog: [],
    });
    expect(r.verdict).toBe("fail");
    expect(r.reasons[0]).toContain("did not reach the app");
    expect(r.reasons).toHaveLength(3);
  });

  it("fails when Finder is in front but shows another file", () => {
    const r = judgeClick("en", "closed", 1, saved, { ...good, selected: undefined, selectedRow: "other.mp4" });
    expect(r.verdict).toBe("fail");
    expect(r.reasons[0]).toContain("does not show the saved file selected");
  });

  it("accepts either Finder's selection or the highlighted row in the saved file's folder", () => {
    // macOS 26 returned an empty `selection` right after a reveal while the row was highlighted.
    expect(
      fileSelected(saved, {
        selected: undefined,
        selectedRow: "2026-09-20 01-27-11.mp4",
        windowTarget: "/Users/eric/Movies/RecordStuff/",
      }),
    ).toBe(true);
    expect(fileSelected(saved, { selected: saved, selectedRow: undefined, windowTarget: undefined })).toBe(true);
    // Same name in another folder is not the saved file.
    expect(
      fileSelected(saved, {
        selected: undefined,
        selectedRow: "2026-09-20 01-27-11.mp4",
        windowTarget: "/Users/eric/Desktop/",
      }),
    ).toBe(false);
    expect(
      fileSelected(saved, {
        selected: undefined,
        selectedRow: undefined,
        windowTarget: "/Users/eric/Movies/RecordStuff/",
      }),
    ).toBe(false);
  });

  it("checks the banner body in the configured language", () => {
    expect(expectedBannerBody(saved, "zh-TW")).toBe("已儲存 2026-09-20 01-27-11.mp4");
    const r = judgeClick("zh-TW", "closed", 1, saved, good);
    expect(r.verdict).toBe("fail");
    expect(r.reasons[0]).toContain('expected "已儲存');
    expect(
      judgeClick("zh-TW", "closed", 1, saved, { ...good, bannerBody: "已儲存 2026-09-20 01-27-11.mp4" }).verdict,
    ).toBe("pass");
  });

  it("marks a missing banner or a missing save as not run, never as pass", () => {
    expect(judgeClick("en", "closed", 3, saved, undefined).verdict).toBe("not-run");
    expect(judgeClick("en", "closed", 3, undefined, good).verdict).toBe("not-run");
  });

  it("treats Finder's /private prefix and paths with spaces or non-ASCII as the same file", () => {
    expect(samePath("/private/tmp/測試 資料夾/錄影 test.mp4", "/tmp/測試 資料夾/錄影 test.mp4")).toBe(true);
    expect(samePath("/tmp/a.mp4", "/tmp/b.mp4")).toBe(false);
    expect(samePath(undefined, "/tmp/a.mp4")).toBe(false);
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
    const failed = judgeClick("en", "closed", 2, saved, { ...good, finalFront: "RecordStuff" });
    expect(summarize([pass, pass2, notRun])).toMatchObject({ pass: 2, notRun: 1, ok: true });
    // Only the first click ran: the second-click case was never observed.
    expect(summarize([pass, notRun, notRun])).toMatchObject({ ok: false, uncovered: ["en/closed"] });
    expect(summarize([pass, pass2, failed]).ok).toBe(false);
    // Every group must be covered, not just one.
    expect(summarize([pass, pass2, { ...pass, finderState: "behind" }]).ok).toBe(false);
    expect(summarize([]).ok).toBe(false);
  });
});
