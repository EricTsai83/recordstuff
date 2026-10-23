import { describe, expect, it } from "vitest";
import { PIPELINE_REPORT_SCHEMA, formatSession, mergeSessions, parsePipelineLog, summarizeSession } from "./pipeline-report.mts";

const engine = (session: string, write: string, extra = "") =>
  `[2026-10-23T10:00:00.000Z] capture host: diagnostics: {"kind":"engine","schema":1,"session":"${session}","outcome":"finished",` +
  `"host":{"previewForwarded":20,"previewWithoutPort":3},"engine":{"schema":1,"stages":{"write":${write},"encode_latency":{"n":1,"sum":5000,"max":5000,"b":{"49":1}}},` +
  `"counts":{"frames_submitted":30,"writer_pending_high":2${extra}}}}`;
const page = (session: string | null, received: number) =>
  `[2026-10-23T10:00:01.000Z] capture host: diagnostics: {"kind":"page","session":${session === null ? "null" : `"${session}"`},"schema":1,"received":${received},` +
  `"drawn":${received},"missed":0,"notDecoded":0,"restarts":{"codec":1,"error":0},"port":{"n":${received},"sum":${received * 1000},"max":1000,"b":{"39":${received}}},` +
  `"decode":{"n":${received},"sum":${received * 2000},"max":2000,"b":{"43":${received}}}}`;

describe("the pipeline's report (plan 083)", () => {
  it("merges a session's engine line with every page report of it, and ignores other lines", () => {
    const report = parsePipelineLog([
      "[2026-10-23T09:59:59.000Z] capture host: timing: record 0.1 ms",
      page("s1", 10),
      page("s1", 5),
      engine("s1", `{"n":2,"sum":400,"max":300,"b":{"30":1,"32":1}}`),
      engine("s2", `{"n":1,"sum":100,"max":100,"b":{"26":1}}`),
    ]);
    expect(report.schema).toBe(PIPELINE_REPORT_SCHEMA);
    expect(report.problems).toEqual([]);
    expect(report.sessions.map((s) => s.session)).toEqual(["s1", "s2"]);
    const s1 = report.sessions[0]!;
    expect(s1.outcome).toBe("finished");
    expect(s1.at).toBe("2026-10-23T10:00:00.000Z");
    expect(s1.page).toEqual(expect.objectContaining({ reports: 2, received: 15, restarts: { codec: 2, error: 0 } }));
    expect(s1.page!.port.n).toBe(15);
    expect(s1.host).toEqual({ previewForwarded: 20, previewWithoutPort: 3 });
    const summary = summarizeSession(s1);
    expect(summary.stages["write"]).toEqual(expect.objectContaining({ n: 2, meanMs: 0.2, maxMs: 0.3 }));
    expect(summary.page!.decode).toEqual(expect.objectContaining({ n: 15, meanMs: 2 }));
  });

  it("names what it could not read: another schema, a broken line, a page with no session", () => {
    const report = parsePipelineLog([
      engine("s1", `{"n":1}`),
      `capture host: diagnostics: {"kind":"engine","session":"s3","outcome":"finished","engine":{"schema":2,"stages":{},"counts":{}}}`,
      "capture host: diagnostics: {broken",
      page(null, 1),
      `capture host: diagnostics: {"kind":"page","session":"s1","schema":1}`,
    ]);
    expect(report.problems).toEqual([
      "session s1: malformed engine stages",
      "session s3: engine schema 2, not 1",
      "unreadable diagnostics line: capture host: diagnostics: {broken",
      "page figures without a session",
      "session s1: malformed page figures",
    ]);
    // A session whose figures could not be read is still listed, with how it ended.
    expect(report.sessions.find((s) => s.session === "s3")).toEqual(expect.objectContaining({ outcome: "finished", stages: {} }));
  });

  it("merges runs: histograms and counts added, high-water marks at their highest", () => {
    const report = parsePipelineLog([engine("a", `{"n":1,"sum":100,"max":100,"b":{"26":1}}`), engine("b", `{"n":3,"sum":900,"max":500,"b":{"26":1,"35":2}}`, `,"in_flight_high":4`)]);
    const merged = mergeSessions("R 30 fps", report.sessions);
    expect(merged.stages["write"]).toEqual(expect.objectContaining({ n: 4, sum: 1000, max: 500 }));
    expect(merged.counts).toEqual({ frames_submitted: 60, writer_pending_high: 2, in_flight_high: 4 });
    expect(merged.host).toEqual({ previewForwarded: 40, previewWithoutPort: 6 });
    const table = formatSession(summarizeSession(merged));
    expect(table).toContain("#### R 30 fps\n");
    expect(formatSession(summarizeSession({ session: "lost", stages: {}, counts: {} }))).toContain("#### lost (no engine figures)");
    expect(table).toMatch(/\| encode_latency \| 2 \| 5\.00 \|/);
    expect(table).toContain("frames_submitted 60");
  });

  it("keeps a session's last snapshot: running ones while it ran, then its outcome, or the last running one of a process that was ended", () => {
    const running = (session: string, n: number) => engine(session, `{"n":${n},"sum":${n * 100},"max":100,"b":{"26":${n}}}`).replace(`"outcome":"finished"`, `"outcome":"running"`);
    const report = parsePipelineLog([running("a", 1), running("a", 5), engine("a", `{"n":9,"sum":900,"max":100,"b":{"26":9}}`), running("b", 2), running("b", 4)]);
    expect(report.sessions.map((s) => [s.session, s.outcome, s.stages["write"]!.n])).toEqual([["a", "finished", 9], ["b", "running", 4]]);
  });
});
