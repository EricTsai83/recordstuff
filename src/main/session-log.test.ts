import { describe, expect, it } from "vitest";
import { DEFAULT_QUALITY } from "../shared/quality";
import { createRunId, logSessionEvent } from "./session-log";

describe("session log lines", () => {
  it("forms one run id from launch time and pid", () => {
    expect(createRunId(new Date("2026-09-25T10:15:30.123Z"), 4242)).toBe("20260925T101530123Z-4242");
  });

  it("writes the human line, then one escaped record on a single line", () => {
    const lines: string[] = [];
    const log = (message: string) => lines.push(message);
    const odd = '/m/My "clips"\n(kept )/a.recording.mp4';
    logSessionEvent(log, "r1", { type: "failed", code: "capture_host_crashed", detail: "killed", partialPath: odd, outcome: "partial",
      session: { id: "s1", recordingPath: odd, recordingAt: "2026-09-25T10:00:01.000Z" } });
    logSessionEvent(log, "r1", { type: "saved", path: "/m/b.mp4", stoppedEarly: "lowDisk",
      session: { id: "s2", recordingPath: "/m/b.recording.mp4", recordingAt: "2026-09-25T10:00:05.000Z", stoppingAt: "2026-09-25T10:00:09.000Z" } });
    logSessionEvent(log, "r1", { type: "captureStarted", sessionId: "s2", requested: DEFAULT_QUALITY,
      capture: { videoBitsPerSecond: 1, audioBitsPerSecond: 2, warnings: [] } });
    logSessionEvent(log, "r1", { type: "state", state: { type: "idle" } });
    expect(lines[0]).toBe(`failed: capture_host_crashed killed (kept ${odd})`);
    expect(lines[1]).not.toContain("\n");
    expect(JSON.parse(lines[1]!.slice("session-record: ".length))).toEqual({ v: 1, run: "r1", kind: "failed", session: "s1",
      code: "capture_host_crashed", detail: "killed", outcome: "partial", partialPath: odd, recordingPath: odd, recordingAt: "2026-09-25T10:00:01.000Z" });
    expect(lines[2]).toBe("saved /m/b.mp4 (stopped early: disk almost full)");
    // The saved record names the final file only; the temporary path no longer exists.
    expect(JSON.parse(lines[3]!.slice("session-record: ".length))).toEqual({ v: 1, run: "r1", kind: "saved", session: "s2", path: "/m/b.mp4",
      stoppedEarly: "lowDisk", recordingAt: "2026-09-25T10:00:05.000Z", stoppingAt: "2026-09-25T10:00:09.000Z" });
    expect(JSON.parse(lines[4]!.slice("session-record: ".length))).toMatchObject({ kind: "capture", session: "s2", requested: DEFAULT_QUALITY });
    expect(lines).toHaveLength(5);
  });

  it("writes a cancel as one plain line with no session record for analyzers to pair", () => {
    const lines: string[] = [];
    logSessionEvent((message) => lines.push(message), "r1", { type: "cancelled", reason: "toggle",
      session: { id: "s3", recordingPath: "/m/c.recording.mp4" } });
    expect(lines).toEqual(["cancelled: session s3 (toggle); no media was recorded; temporary file /m/c.recording.mp4"]);
    logSessionEvent((message) => lines.push(message), "r1", { type: "cancelled", reason: "quit", session: { id: "s4" } });
    expect(lines.at(-1)).toBe("cancelled: session s4 (quit); no media was recorded");
  });
});
