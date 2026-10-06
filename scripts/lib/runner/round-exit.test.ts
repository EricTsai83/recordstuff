import { describe, expect, it } from "vitest";
import { roundExit } from "./round-exit.mts";

describe("roundExit", () => {
  const clean = { cleanupIncomplete: false, locked: false, failed: false };
  it("passes only a clean, uninterrupted, unlocked round with nothing failed or blocked", () => {
    expect(roundExit(clean)).toEqual({ outcome: "pass", code: 0 });
    expect(roundExit({ ...clean, failed: true })).toEqual({ outcome: "fail", code: 1 });
    expect(roundExit({ ...clean, blocked: true })).toEqual({ outcome: "blocked", code: 2 });
  });
  it("lets incomplete cleanup outrank a lock and an interrupt, so the next round never starts over leftovers", () => {
    expect(roundExit({ ...clean, cleanupIncomplete: true, locked: true, interrupted: "SIGINT" })).toEqual({ outcome: "fail", code: 1 });
  });
  it("reports an interrupt that left nothing as 130 or 143, before a lock or the failures it caused", () => {
    expect(roundExit({ ...clean, interrupted: "SIGINT", locked: true, failed: true })).toEqual({ outcome: "interrupted", code: 130 });
    expect(roundExit({ ...clean, interrupted: "SIGTERM" })).toEqual({ outcome: "interrupted", code: 143 });
  });
  it("keeps a lock blocked even when a case failed, since the lock may be why", () => {
    expect(roundExit({ ...clean, locked: true, failed: true })).toEqual({ outcome: "blocked", code: 2 });
  });
  it("never lets a missing prerequisite hide a real failure (review pass 1, F2 and F3)", () => {
    expect(roundExit({ ...clean, blocked: true, failed: true })).toEqual({ outcome: "fail", code: 1 });
  });
});
