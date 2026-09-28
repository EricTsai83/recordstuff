import { describe, expect, it } from "vitest";
import { formatSessionRecord } from "../../src/shared/session-record.ts";
import { parseSessionRecord } from "./session-records.mts";

describe("saved session records", () => {
  const saved = (stoppedEarly?: string): string => {
    const line = formatSessionRecord("r1", { kind: "saved", session: "s1", path: "/m/a.mp4" });
    return stoppedEarly ? line.replace(/\}$/, `,"stoppedEarly":${JSON.stringify(stoppedEarly)}}`) : line;
  };

  it("accept each early-stop reason the app writes, including sleep (plan 050), and refuse others", () => {
    expect(parseSessionRecord(saved())).toMatchObject({ kind: "saved", path: "/m/a.mp4" });
    expect(parseSessionRecord(saved("lowDisk"))).toMatchObject({ stoppedEarly: "lowDisk" });
    expect(parseSessionRecord(saved("sleep"))).toMatchObject({ stoppedEarly: "sleep" });
    expect(parseSessionRecord(saved("user"))).toBeUndefined();
  });
});
