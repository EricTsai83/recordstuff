import { describe, expect, it } from "vitest";
import { fileId } from "../../src/main/recordings-library";
import { classifyTrayRound, recordingCardOpenId, renderTrayReport, type TrayCase } from "./tray-acceptance.mts";

it("names a Recordings card's Play button as the page does, from the library's own file id", () => {
  for (const file of ["/Users/me/Movies/RecordStuff/2026-10-04 20-35-08.mp4", "/tmp/測試 資料夾/錄影.mov"]) {
    expect(recordingCardOpenId(file)).toBe(`clip-${fileId(file)}-open`);
  }
  expect(recordingCardOpenId("/a/2026-10-04 20-35-08.mp4")).not.toBe(recordingCardOpenId("/a/2026-10-04 20-35-40.mp4"));
});

const one = (status: TrayCase["status"], problems: string[] = []): TrayCase =>
  ({ id: "menu-idle", title: "Idle menu", language: "en", status, evidence: "scripted input", problems, details: [], screenshots: ["en-idle-menu.png"] });
const base = { cleanup: [], roundError: undefined, blocked: undefined, lockedAt: undefined, interrupted: undefined };

describe("tray round verdict (plan 063)", () => {
  it("passes only when every case that ran passed and cleanup left nothing; not-run cases stay counted", () => {
    const verdict = classifyTrayRound({ ...base, cases: [one("pass"), one("not run")] });
    expect(verdict).toMatchObject({ status: "PASS", exitCode: 0, counts: { pass: 1, "not run": 1 } });
  });

  it("fails a failed case, a cleanup problem or a refusal, even when other cases passed", () => {
    expect(classifyTrayRound({ ...base, cases: [one("pass"), one("fail", ["entry 2: label"])] })).toMatchObject({ status: "FAIL", exitCode: 1, reasons: ["menu-idle (en): entry 2: label"] });
    expect(classifyTrayRound({ ...base, cases: [one("pass")], cleanup: ["quit RecordStuff: still running"] })).toMatchObject({ status: "FAIL", reasons: ["cleanup: quit RecordStuff: still running"] });
    expect(classifyTrayRound({ ...base, cases: [], roundError: "another RecordStuff bundle is running\nstack" })).toMatchObject({ status: "FAIL", reasons: ["another RecordStuff bundle is running"] });
    expect(classifyTrayRound({ ...base, cases: [] })).toMatchObject({ status: "FAIL", reasons: ["no case ran"] });
  });

  it("blocks a round whose screen locked or whose terminal lacks Accessibility, and marks an interruption", () => {
    expect(classifyTrayRound({ ...base, cases: [one("pass")], lockedAt: "2026-10-02T15:00:00Z" })).toMatchObject({ status: "BLOCKED", exitCode: 2 });
    expect(classifyTrayRound({ ...base, cases: [one("blocked")], blocked: "AXError -25211" })).toMatchObject({ status: "BLOCKED", exitCode: 2 });
    expect(classifyTrayRound({ ...base, cases: [one("pass")], interrupted: "SIGINT" })).toMatchObject({ status: "INTERRUPTED", exitCode: 130 });
  });

  it("orders the exit as the other desktop runners do: a lock or an interrupt outranks a failed case, cleanup outranks both", () => {
    const failedCase = [one("pass"), one("fail", ["entry 2: label"])];
    expect(classifyTrayRound({ ...base, cases: failedCase, lockedAt: "2026-10-02T15:00:00Z" }))
      .toMatchObject({ status: "BLOCKED", exitCode: 2, reasons: ["the screen locked at 2026-10-02T15:00:00Z", "menu-idle (en): entry 2: label"] });
    expect(classifyTrayRound({ ...base, cases: failedCase, interrupted: "SIGTERM" })).toMatchObject({ status: "INTERRUPTED", exitCode: 143 });
    expect(classifyTrayRound({ ...base, cases: [], interrupted: "SIGINT" })).toMatchObject({ status: "INTERRUPTED", exitCode: 130 });
    expect(classifyTrayRound({ ...base, cases: failedCase, cleanup: ["quit RecordStuff: still running"], interrupted: "SIGINT", lockedAt: "x" }))
      .toMatchObject({ status: "FAIL", exitCode: 1 });
    expect(classifyTrayRound({ ...base, cases: [one("fail", ["x"]), one("blocked")], blocked: "AXError -25211" })).toMatchObject({ status: "FAIL", exitCode: 1 });
  });

  it("labels the evidence as scripted input and leaves the visual review pending in the report", () => {
    const verdict = classifyTrayRound({ ...base, cases: [one("pass")] });
    const report = renderTrayReport({ verdict, cases: [one("pass")], cleanup: [], notes: ["bundle x"], recordings: [], roundError: undefined, blocked: undefined, desktop: undefined, bundle: "/x/RecordStuff.app", interrupted: undefined });
    expect(report).toContain("| scripted input |");
    expect(report).toContain("Visual review: **pending**");
    expect(report).toContain("[en-idle-menu.png](en-idle-menu.png)");
  });
});
