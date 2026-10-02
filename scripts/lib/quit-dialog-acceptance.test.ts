import { describe, expect, it } from "vitest";
import {
  classifyCleanup, classifyDelivery, classifyLifecycle, classifySetup, combineVerdict, isAuthorizationDenial,
  parseNotificationEvents, renderReport, type Layer, type Layers, type NotificationEvent,
} from "./quit-dialog-acceptance.mts";

const at = (ms: number): string => new Date(Date.UTC(2026, 9, 2, 12, 0, 0) + ms).toISOString();
const requested: NotificationEvent = { time: at(0), event: "requested", supported: true };
const pass: Layer = { status: "pass", reason: "ok" };
const layers = (overrides: Partial<Layers> = {}): Layers => ({ setup: pass, lifecycle: pass, delivery: pass, cleanup: pass, ...overrides });

describe("notification events", () => {
  it("parses appended lines and ignores a line torn by a killed process", () => {
    const text = `${JSON.stringify(requested)}\n${JSON.stringify({ time: at(40), event: "shown" })}\n{"time":"${at(50)}","ev`;
    expect(parseNotificationEvents(text).map(event => event.event)).toEqual(["requested", "shown"]);
    expect(parseNotificationEvents("")).toEqual([]);
  });

  it.each([
    ["The operation couldn’t be completed. (UNErrorDomain error 1.)", true],
    ["Error Domain=UNErrorDomain Code=1 \"Notifications are not allowed for this application\"", true],
    ["Notifications are not allowed for this application", true],
    ["The operation couldn’t be completed. (UNErrorDomain error 10.)", false],
    ["UNErrorDomain error 14", false],
    ["Invalid notification attachment", false],
  ])("recognizes an authorization denial: %s", (error, denial) => {
    expect(isAuthorizationDenial(error)).toBe(denial);
  });
});

describe("delivery", () => {
  it("passes only on a shown event inside the window and keeps it separate from visual proof", () => {
    const result = classifyDelivery([requested, { time: at(120), event: "shown" }]);
    expect(result).toMatchObject({ status: "pass", latencyMs: 120 });
    expect(result.reason).toContain("not proof of one visible, readable banner");
  });

  it("blocks an explicit authorization denial and keeps the raw error", () => {
    const error = "The operation couldn’t be completed. (UNErrorDomain error 1.)";
    expect(classifyDelivery([requested, { time: at(10), event: "failed", error }])).toMatchObject({ status: "blocked", error });
  });

  it("fails any other notification error, even after a shown event", () => {
    const failed: NotificationEvent = { time: at(30), event: "failed", error: "Invalid notification attachment" };
    expect(classifyDelivery([requested, failed])).toMatchObject({ status: "fail", error: "Invalid notification attachment" });
    expect(classifyDelivery([requested, { time: at(20), event: "shown" }, failed]).status).toBe("fail");
  });

  it("fails a missing, late, absent or repeated request instead of passing silently", () => {
    expect(classifyDelivery([requested]).reason).toContain("Neither a show nor a failure");
    expect(classifyDelivery([{ ...requested, supported: false }]).reason).toContain("isSupported() was false");
    expect(classifyDelivery([requested, { time: at(8001), event: "shown" }])).toMatchObject({ status: "fail", latencyMs: 8001 });
    expect(classifyDelivery([]).status).toBe("fail");
    expect(classifyDelivery([requested, requested, { time: at(5), event: "shown" }]).status).toBe("fail");
  });
});

describe("signed fixture app", () => {
  it("passes a verified copy", () => {
    expect(classifySetup({ code: 0 }, ["preflight", "copy", "sign", "verify"], "").status).toBe("pass");
  });

  it("blocks a missing identity prerequisite and fails a signing or verification error", () => {
    expect(classifySetup({ code: 2 }, [], "found 0")).toMatchObject({ status: "blocked" });
    expect(classifySetup({ code: 2 }, [], "found 0. Check its trust.").reason).toBe("Signing prerequisite unavailable: found 0. Check its trust. No fixture launched.");
    expect(classifySetup({ code: 1 }, ["preflight", "copy", "sign"], "Ad-hoc signature").status).toBe("fail");
  });

  it("treats a timeout while the keychain is consulted as a pending permission, any other as a failure", () => {
    expect(classifySetup({ code: null, stopped: "timeout" }, ["preflight", "copy"], "").status).toBe("blocked");
    expect(classifySetup({ code: null, stopped: "timeout" }, [], "").status).toBe("blocked");
    expect(classifySetup({ code: null, stopped: "timeout" }, ["preflight"], "").status).toBe("fail");
    expect(classifySetup({ code: null, stopped: "timeout" }, ["preflight", "copy", "sign"], "").status).toBe("fail");
  });

  it("fails an interrupted or unsupervised setup", () => {
    expect(classifySetup({ code: null, stopped: "interrupted" }, ["preflight"], "").status).toBe("fail");
    expect(classifySetup({ code: 0, error: "EPERM" }, [], "").status).toBe("fail");
  });
});

describe("lifecycle", () => {
  const result = { prompts: 1, deferred: 1, maxLateMs: 3 };
  it("passes one on-time deferral after a normal exit", () => {
    expect(classifyLifecycle({ code: 0 }, result).status).toBe("pass");
  });

  it.each([
    [{ code: 0, stopped: "timeout" }, result],
    [{ code: 0, error: "EPERM" }, result],
    [{ code: 1 }, result],
    [{ code: 0 }, undefined],
    [{ code: 0 }, { ...result, prompts: 2 }],
    [{ code: 0 }, { ...result, maxLateMs: 500 }],
    [{ code: 0 }, { prompts: 1, deferred: 1 }],
  ])("fails %j with %j", (run, fixture) => {
    expect(classifyLifecycle(run, fixture).status).toBe("fail");
  });
});

describe("cleanup", () => {
  const clean = { setupGroupGone: true, fixtureGroupGone: true, forced: false, temporaryRemoved: true };
  it("passes when every owned group is gone and the copy removed, launched or not", () => {
    expect(classifyCleanup(clean).status).toBe("pass");
    expect(classifyCleanup({ ...clean, fixtureGroupGone: undefined }).status).toBe("pass");
  });

  it.each([
    { setupGroupGone: false }, { setupGroupGone: undefined }, { fixtureGroupGone: false }, { forced: true }, { temporaryRemoved: false },
  ])("fails %j", overrides => {
    expect(classifyCleanup({ ...clean, ...overrides }).status).toBe("fail");
  });
});

describe("combined verdict", () => {
  const blocked: Layer = { status: "blocked", reason: "denied" };
  const fail: Layer = { status: "fail", reason: "broken" };
  const notRun: Layer = { status: "not run", reason: "setup blocked" };

  it("passes only when every automated layer passed on an unlocked desktop", () => {
    expect(combineVerdict(layers(), undefined)).toEqual({ automated: "pass", exitCode: 0 });
  });

  it("does not let a passing lifecycle hide a failed or blocked delivery", () => {
    expect(combineVerdict(layers({ delivery: fail }), undefined)).toEqual({ automated: "fail", exitCode: 1 });
    expect(combineVerdict(layers({ delivery: blocked }), undefined)).toEqual({ automated: "blocked", exitCode: 2 });
  });

  it("blocks a locked desktop and layers that could not run", () => {
    expect(combineVerdict(layers(), at(0))).toEqual({ automated: "blocked", exitCode: 2 });
    expect(combineVerdict(layers({ setup: blocked, lifecycle: notRun, delivery: notRun }), undefined).automated).toBe("blocked");
  });

  it("lets any failure outrank blocked results, including a lock", () => {
    expect(combineVerdict(layers({ setup: blocked, cleanup: fail }), undefined).automated).toBe("fail");
    expect(combineVerdict(layers({ delivery: blocked, lifecycle: fail }), at(0))).toEqual({ automated: "fail", exitCode: 1 });
  });
});

describe("report", () => {
  it("keeps the five layers apart and the visual layer pending after an automated pass", () => {
    const text = renderReport({ language: "en", layers: layers({ delivery: { status: "pass", reason: "a | b" } }),
      verdict: { automated: "pass", exitCode: 0 }, desktop: "Desktop: unlocked.", provenance: ["Commit abc"], files: ["report.json", "setup.log"] });
    expect(text).toContain("Automated evidence: **PASS** (exit 0)");
    expect(text).toContain("| Visual banner observation | NOT RUN | Pending:");
    expect(text).toContain("| Notification delivery event | PASS | a \\| b |");
    expect(text).toContain("- Commit abc");
    expect(text).toContain("Details: [report.json](report.json), [setup.log](setup.log).");
  });
});
