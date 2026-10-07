import { describe, expect, it } from "vitest";
import { judgeToolCleanup, parseProcesses } from "./tool-cleanup-audit.mts";

describe("tool cleanup audit", () => {
  it("preserves shared helper services while confirming owned processes exited", () => {
    const processes = parseProcesses(" 22 1 S /Users/test/cmux Computer Use.app/Contents/MacOS/cmux-cua\n");
    const result = judgeToolCleanup([], processes, [44]);
    expect(result.status).toBe("pass");
    expect(result.sharedHelpers.map((row) => row.pid)).toEqual([22]);
  });
  it("fails when a Software Cursor is visible, even if no owned process remains", () => {
    expect(judgeToolCleanup([{ id: 12, pid: 44, owner: "ChatGPT Computer Use", name: "Software Cursor" }], [], []).status).toBe("fail");
  });
  it("does not treat a zombie as an exited process or assume it can still be killed", () => {
    const processes = parseProcesses("44 33 Z <defunct>\n45 33 S /usr/local/bin/node\n");
    const result = judgeToolCleanup([], processes, [44, 45]);
    expect(result.status).toBe("fail");
    expect(result.ownedZombies.map((row) => row.pid)).toEqual([44]);
    expect(result.ownedProcesses.map((row) => row.pid)).toEqual([44, 45]);
  });
  it("rejects unreadable process inventory instead of reporting clean", () => {
    expect(() => parseProcesses("permission denied")).toThrow("process inventory");
  });
});
