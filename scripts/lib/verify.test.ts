import { describe, expect, it } from "vitest";
import {
  THRESHOLDS,
  formatMarkdown,
  formatText,
  frameStats,
  judge,
  measure,
  overallVerdict,
  pairRecordingsWithLog,
  parseAutorecordOutcome,
  parseBlackdetect,
  parseCaptureLine,
  parseChannelRms,
  parseFrameTimes,
  parseSilencedetect,
  sessionDurationSeconds,
  syncStats,
  type ProbeInfo,
} from "./verify.mts";
import { formatSessionRecord } from "../../src/shared/session-record.ts";
import type { CaptureReport, QualitySettings } from "../../src/shared/quality.ts";

const CAPTURE_LINE =
  "recorder: session mtynus3n-i3lxyd capture: requested video=standard cap=1440p fps=60 audio=high; track size=1440x1440 fps=60 sampleRate=48000 Hz channels=1; target videoBps=16200000 audioBps=256000";

describe("log parsing", () => {
  it("reads a capture line into requested / track / target", () => {
    expect(parseCaptureLine(CAPTURE_LINE)).toEqual({
      sessionId: "mtynus3n-i3lxyd",
      requested: { videoQuality: "standard", resolutionCap: "1440p", frameRate: 60 },
      track: { width: 1440, height: 1440, frameRate: 60, sampleRate: 48000, channelCount: 1 },
      targetVideoBps: 16_200_000,
      targetAudioBps: 256_000,
      warnings: undefined,
    });
  });

  it("keeps unknown track fields undefined, carries warnings, and reads the current line format without audio=", () => {
    expect(
      parseCaptureLine("recorder: session s0 capture: requested video=high cap=4k fps=60; track size=1920x1080 fps=60 sampleRate=48000 Hz channels=2; target videoBps=16200000 audioBps=256000")?.requested,
    ).toEqual({ videoQuality: "high", resolutionCap: "4k", frameRate: 60 });
    const entry = parseCaptureLine(
      "recorder: session s1 capture: requested video=economy cap=source fps=30 audio=standard; track size=unknown fps=unknown sampleRate=unknown channels=unknown; target videoBps=8100000 audioBps=192000; warnings: video track has no dimensions; cannot apply resolution cap",
    );
    expect(entry?.track).toEqual({});
    expect(entry?.warnings).toBe("video track has no dimensions; cannot apply resolution cap");
    expect(parseCaptureLine("state → recording")).toBeUndefined();
    expect(parseCaptureLine(CAPTURE_LINE.replace("fps=60 audio", "fps=24 audio"))).toBeUndefined();
  });

  it("pairs a kept partial with its failed session even when the next session's capture line comes first (F5)", () => {
    const a = CAPTURE_LINE.replace("mtynus3n-i3lxyd", "A").replace("cap=1440p", "cap=1080p");
    const b = CAPTURE_LINE.replace("mtynus3n-i3lxyd", "B").replace("cap=1440p", "cap=4k");
    const log = [
      a,
      "recorder: session A failed: capture_host_crashed killed",
      "state → idle",
      b,
      "failed: capture_host_crashed killed (kept /x/a.recording.mp4)",
      "saved /x/b.mp4",
    ].join("\n");
    const pairs = pairRecordingsWithLog(log);
    expect(pairs.lookup("/x/a.recording.mp4")).toMatchObject({ status: "legacy", entry: { requested: { resolutionCap: "1080p" } } });
    expect(pairs.lookup("/x/b.mp4")).toMatchObject({ status: "legacy", entry: { requested: { resolutionCap: "4k" } } });
  });

  it("retires a failed session that kept no file so a later kept partial is not misassigned (pass 2)", () => {
    const a = CAPTURE_LINE.replace("mtynus3n-i3lxyd", "A").replace("cap=1440p", "cap=1080p");
    const b = CAPTURE_LINE.replace("mtynus3n-i3lxyd", "B").replace("cap=1440p", "cap=4k");
    const log = [
      a,
      "recorder: session A failed: capture_start_failed timeout",
      "failed: capture_start_failed timeout",
      b,
      "recorder: session B failed: capture_host_crashed killed",
      "failed: capture_host_crashed killed (kept /x/b.recording.mp4)",
    ].join("\n");
    const pairs = pairRecordingsWithLog(log);
    expect(pairs.size).toBe(1);
    expect(pairs.lookup("/x/b.recording.mp4").entry?.requested.resolutionCap).toBe("4k");
  });

  it("reads the app's autorecord verdict lines", () => {
    expect(parseAutorecordOutcome("x\n[t] autorecord: recording, will stop in 30 s\n[t] autorecord: saved /x/a.mp4\n")).toEqual({ saved: "/x/a.mp4" });
    expect(parseAutorecordOutcome("[t] autorecord: failed: no_audio_track ended (kept /x/a.recording.mp4)")).toEqual({
      failed: "no_audio_track ended (kept /x/a.recording.mp4)",
    });
    expect(parseAutorecordOutcome("")).toEqual({});
  });

  it("pairs each saved or kept file with the capture line of its session", () => {
    const log = [
      "[2026-09-12T17:30:15.107Z] state → starting",
      `[2026-09-12T17:30:15.460Z] ${CAPTURE_LINE}`,
      "[2026-09-12T17:30:24.310Z] saved /Users/eric/Movies/RecordStuff/2026-09-13 01-30-15.mp4",
      "[2026-09-12T17:31:00.000Z] saved /Users/eric/Movies/RecordStuff/no-capture-line.mp4",
      `[2026-09-12T17:32:00.000Z] ${CAPTURE_LINE.replace("mtynus3n-i3lxyd", "s2").replace("cap=1440p", "cap=1080p")}`,
      "[2026-09-12T17:32:30.000Z] recorder: session s2 failed: capture_host_crashed killed",
      "[2026-09-12T17:32:30.001Z] failed: capture_host_crashed killed (kept /Users/eric/Movies/RecordStuff/2026-09-13 01-32-00.recording.mp4)",
    ].join("\n");
    const pairs = pairRecordingsWithLog(log);
    expect(pairs.lookup("/Users/eric/Movies/RecordStuff/2026-09-13 01-30-15.mp4").entry?.requested.resolutionCap).toBe("1440p");
    expect(pairs.lookup("/Users/eric/Movies/RecordStuff/no-capture-line.mp4")).toMatchObject({ status: "unknown" });
    expect(pairs.lookup("/Users/eric/Movies/RecordStuff/2026-09-13 01-32-00.recording.mp4").entry?.requested.resolutionCap).toBe("1080p");
    // A copied file still pairs by name while exactly one session names it.
    expect(pairs.lookup("/tmp/copy/2026-09-13 01-30-15.mp4")).toMatchObject({ status: "legacy", note: expect.stringContaining("file name only") });
  });

  it("reads the session length from the recording/stopping state lines, falling back to saved", () => {
    const log = [
      "[2026-09-19T10:02:38.300Z] state → starting",
      `[2026-09-19T10:02:38.407Z] ${CAPTURE_LINE}`,
      "[2026-09-19T10:02:38.407Z] state → recording",
      "[2026-09-19T10:02:55.130Z] state → stopping",
      "[2026-09-19T10:02:55.155Z] state → idle",
      "[2026-09-19T10:02:55.156Z] saved /Users/eric/Movies/RecordStuff/2026-09-19 18-02-38.mp4",
      `[2026-09-19T10:05:00.000Z] ${CAPTURE_LINE.replace("mtynus3n-i3lxyd", "s2")}`,
      "[2026-09-19T10:05:00.100Z] state → recording",
      "[2026-09-19T10:05:20.100Z] saved /Users/eric/Movies/RecordStuff/second.mp4",
      `${CAPTURE_LINE.replace("mtynus3n-i3lxyd", "s3")}`,
      "state → recording",
      "saved /Users/eric/Movies/RecordStuff/unstamped.mp4",
    ].join("\n");
    const pairs = pairRecordingsWithLog(log);
    const entry = (name: string) => pairs.lookup(`/Users/eric/Movies/RecordStuff/${name}`).entry;
    expect(sessionDurationSeconds(entry("2026-09-19 18-02-38.mp4"))).toBeCloseTo(16.723, 3);
    expect(sessionDurationSeconds(entry("second.mp4"))).toBeCloseTo(20, 3);
    expect(sessionDurationSeconds(entry("unstamped.mp4"))).toBeUndefined();
    expect(sessionDurationSeconds(undefined)).toBeUndefined();
  });
});

describe("session identity pairing (plan 029)", () => {
  const RUN = "20260925T100000000Z-4242";
  const quality = (resolutionCap: QualitySettings["resolutionCap"]): QualitySettings => ({ videoQuality: "standard", resolutionCap, frameRate: 30 });
  const report = (height: number): CaptureReport => ({ width: Math.round((height * 16) / 9), height, frameRate: 30, sampleRate: 48_000, channelCount: 2,
    videoBitsPerSecond: 8_100_000, audioBitsPerSecond: 256_000, warnings: [] });
  const at = (second: number): string => `[2026-09-25T10:00:${String(second).padStart(2, "0")}.000Z] `;
  const start = (second: number, run = RUN): string => `${at(second)}start: RecordStuff 1.0.0; run ${run}; electron 44; executable /x`;
  const capture = (second: number, session: string, cap: QualitySettings["resolutionCap"], height: number, run = RUN): string =>
    at(second) + formatSessionRecord(run, { kind: "capture", session, requested: quality(cap), capture: report(height) });
  const saved = (second: number, session: string, filePath: string, run = RUN): string =>
    at(second) + formatSessionRecord(run, { kind: "saved", session, path: filePath,
      recordingAt: `2026-09-25T10:00:${String(second - 10).padStart(2, "0")}.000Z`, stoppingAt: `2026-09-25T10:00:${String(second).padStart(2, "0")}.000Z` });
  const failed = (second: number, session: string, fields: { partialPath?: string; recordingPath?: string; outcome?: "partial" | "empty" | "unknown" }, run = RUN): string =>
    at(second) + formatSessionRecord(run, { kind: "failed", session, code: "capture_host_crashed", detail: "killed", outcome: fields.outcome ?? (fields.partialPath ? "partial" : "empty"),
      ...(fields.partialPath ? { partialPath: fields.partialPath } : {}), ...(fields.recordingPath ? { recordingPath: fields.recordingPath } : {}) });
  const cap = (pairs: ReturnType<typeof pairRecordingsWithLog>, file: string) => pairs.lookup(file).entry?.requested.resolutionCap;

  it("pairs by identity when A fails first but B's cleanup finishes first, where the legacy order swapped them", () => {
    const log = [
      start(0), capture(1, "A", "1080p", 1080),
      "[2026-09-25T10:00:05.000Z] recorder: session A failed: capture_host_crashed killed",
      capture(6, "B", "4k", 2160),
      "[2026-09-25T10:00:08.000Z] recorder: session B failed: capture_host_crashed killed",
      "[2026-09-25T10:00:09.000Z] failed: capture_host_crashed killed (kept /m/b.recording.mp4)",
      failed(9, "B", { partialPath: "/m/b.recording.mp4", recordingPath: "/m/b.recording.mp4" }),
      "[2026-09-25T10:00:12.000Z] failed: capture_host_crashed killed (kept /m/a.recording.mp4)",
      failed(12, "A", { partialPath: "/m/a.recording.mp4", recordingPath: "/m/a.recording.mp4" }),
    ];
    const pairs = pairRecordingsWithLog(log.join("\n"));
    expect(pairs.lookup("/m/a.recording.mp4")).toMatchObject({ status: "matched", entry: { sessionId: "A", runId: RUN, requested: { resolutionCap: "1080p" } } });
    expect(cap(pairs, "/m/b.recording.mp4")).toBe("4k");
    // The same launch from a build before plan 029 cannot tell them apart: both are ambiguous, never swapped.
    const legacy = pairRecordingsWithLog([
      "[2026-09-25T10:00:00.000Z] start: RecordStuff 0.9.0; electron 44; executable /x",
      `${at(1)}${CAPTURE_LINE.replace("mtynus3n-i3lxyd", "A").replace("cap=1440p", "cap=1080p")}`,
      log[2], `${at(6)}${CAPTURE_LINE.replace("mtynus3n-i3lxyd", "B").replace("cap=1440p", "cap=4k")}`, log[4], log[5], log[7],
    ].join("\n"));
    expect(legacy.lookup("/m/a.recording.mp4")).toMatchObject({ status: "ambiguous" });
    expect(legacy.lookup("/m/b.recording.mp4")).toMatchObject({ status: "ambiguous" });
    expect(legacy.lookup("/m/a.recording.mp4").entry).toBeUndefined();
  });

  it("uses distinct legacy failure text as identity when it is unique", () => {
    const pairs = pairRecordingsWithLog([
      CAPTURE_LINE.replace("mtynus3n-i3lxyd", "A").replace("cap=1440p", "cap=1080p"),
      "recorder: session A failed: capture_host_crashed killed",
      CAPTURE_LINE.replace("mtynus3n-i3lxyd", "B").replace("cap=1440p", "cap=4k"),
      "recorder: session B failed: disk_full ENOSPC",
      "failed: disk_full ENOSPC (kept /m/b.recording.mp4)",
      "failed: capture_host_crashed killed (kept /m/a.recording.mp4)",
    ].join("\n"));
    expect(cap(pairs, "/m/a.recording.mp4")).toBe("1080p");
    expect(cap(pairs, "/m/b.recording.mp4")).toBe("4k");
  });

  it("keeps two same-text legacy failures ambiguous even after one of them resolves", () => {
    const pairs = pairRecordingsWithLog([
      CAPTURE_LINE.replace("mtynus3n-i3lxyd", "A"),
      "recorder: session A failed: capture_host_crashed killed",
      CAPTURE_LINE.replace("mtynus3n-i3lxyd", "B"),
      "recorder: session B failed: capture_host_crashed killed",
      "failed: capture_host_crashed killed (kept /m/b.recording.mp4)",
      "failed: capture_host_crashed killed (kept /m/a.recording.mp4)",
    ].join("\n"));
    expect(pairs.lookup("/m/a.recording.mp4").status).toBe("ambiguous");
    expect(pairs.lookup("/m/b.recording.mp4").status).toBe("ambiguous");
  });

  it("pairs a save, a failure with no file and a kept partial across three interleaved sessions", () => {
    const pairs = pairRecordingsWithLog([
      start(0),
      capture(1, "A", "1080p", 1080),
      capture(3, "B", "1440p", 1440),
      capture(5, "C", "4k", 2160),
      saved(20, "C", "/m/c.mp4"),
      failed(21, "A", { outcome: "empty", recordingPath: "/m/a.recording.mp4" }),
      failed(22, "B", { partialPath: "/m/b.recording.mp4", recordingPath: "/m/b.recording.mp4" }),
    ].join("\n"));
    expect(cap(pairs, "/m/c.mp4")).toBe("4k");
    expect(cap(pairs, "/m/b.recording.mp4")).toBe("1440p");
    // Nothing remains of A, so its temporary name claims no file and is never lent to a neighbour.
    expect(pairs.lookup("/m/a.recording.mp4")).toMatchObject({ status: "unknown" });
    expect(sessionDurationSeconds(pairs.lookup("/m/c.mp4").entry)).toBe(10);
  });

  it("treats a repeated record as one outcome and flags conflicting outcomes", () => {
    const outcome = saved(12, "A", "/m/a.mp4");
    const duplicate = pairRecordingsWithLog([start(0), capture(1, "A", "1080p", 1080), capture(2, "A", "1080p", 1080), outcome, outcome.replace(at(12), at(13))].join("\n"));
    expect(duplicate.lookup("/m/a.mp4")).toMatchObject({ status: "matched", entry: { sessionId: "A" } });
    const conflict = pairRecordingsWithLog([start(0), capture(1, "A", "1080p", 1080), saved(12, "A", "/m/a.mp4"),
      failed(13, "A", { partialPath: "/m/a.recording.mp4" })].join("\n"));
    expect(conflict.lookup("/m/a.mp4")).toMatchObject({ status: "conflict", note: expect.stringContaining("conflicting outcomes") });
    expect(conflict.lookup("/m/a.recording.mp4").entry).toBeUndefined();
    const captures = pairRecordingsWithLog([start(0), capture(1, "A", "1080p", 1080), capture(2, "A", "4k", 2160), saved(12, "A", "/m/a.mp4")].join("\n"));
    expect(captures.lookup("/m/a.mp4").status).toBe("conflict");
  });

  it("does not let the same file name in different folders collide", () => {
    const pairs = pairRecordingsWithLog([start(0), capture(1, "A", "1080p", 1080), saved(11, "A", "/one/clip.mp4"),
      capture(20, "B", "4k", 2160), saved(30, "B", "/two/clip.mp4")].join("\n"));
    expect(cap(pairs, "/one/clip.mp4")).toBe("1080p");
    expect(cap(pairs, "/two/clip.mp4")).toBe("4k");
    expect(pairs.lookup("/elsewhere/clip.mp4")).toMatchObject({ status: "ambiguous", note: expect.stringContaining("different folders") });
    expect(pairs.lookup("/one/./sub/../clip.mp4").entry?.sessionId).toBe("A");
  });

  it("keeps spaces, quotes, parentheses, line breaks and decomposed Unicode in paths intact", () => {
    const odd = `/Users/e/Movies/My "clips" (kept )/片段\n2026-09-25 10-00-00.recording.mp4`;
    const decomposed = "/Users/e/Movies/Cafe\u0301/2026-09-25 10-01-00.mp4";
    const pairs = pairRecordingsWithLog([start(0), capture(1, "A", "1080p", 1080), failed(5, "A", { partialPath: odd, recordingPath: odd }),
      capture(6, "B", "4k", 2160), saved(16, "B", decomposed)].join("\n"));
    expect(cap(pairs, odd)).toBe("1080p");
    expect(cap(pairs, "/Users/e/Movies/Caf\u00e9/2026-09-25 10-01-00.mp4")).toBe("4k");
  });

  it("reads old and new launches in one log without counting an outcome twice", () => {
    const pairs = pairRecordingsWithLog([
      "[2026-09-24T09:00:00.000Z] start: RecordStuff 0.9.0; electron 44; executable /x",
      `[2026-09-24T09:00:01.000Z] ${CAPTURE_LINE.replace("mtynus3n-i3lxyd", "old").replace("cap=1440p", "cap=source")}`,
      "[2026-09-24T09:00:11.000Z] saved /m/old.mp4",
      start(0),
      `${at(1)}${CAPTURE_LINE.replace("mtynus3n-i3lxyd", "new").replace("cap=1440p", "cap=1080p")}`,
      capture(1, "new", "4k", 2160),
      `${at(11)}saved /m/new.mp4`,
      saved(11, "new", "/m/new.mp4"),
      // A human line after the new launch's records must not become a second, legacy outcome.
      `${at(12)}saved /m/stray.mp4`,
    ].join("\n"));
    expect(pairs.lookup("/m/old.mp4")).toMatchObject({ status: "legacy", entry: { requested: { resolutionCap: "source" } } });
    expect(pairs.lookup("/m/new.mp4")).toMatchObject({ status: "matched", entry: { requested: { resolutionCap: "4k" } } });
    expect(pairs.lookup("/m/stray.mp4").status).toBe("unknown");
  });

  it("reports unknown sessions, unknown record versions and a failed preflight without borrowing a session", () => {
    const pairs = pairRecordingsWithLog([
      start(0),
      // The capture record of X was rotated away; its outcome alone is not enough to judge the file.
      saved(12, "X", "/m/x.mp4"),
      `${at(13)}session-record: {"v":2,"run":"${RUN}","kind":"saved","session":"Y","path":"/m/y.mp4"}`,
      `${at(14)}session-record: {"v":1,"run":"${RUN}","kind":"saved","session":"Z"`,
      capture(20, "A", "1080p", 1080),
      saved(30, "A", "/m/a.mp4"),
      at(31) + formatSessionRecord(RUN, { kind: "refused", code: "unsupported_os_version", detail: "" }),
      `${at(31)}failed: unsupported_os_version `,
    ].join("\n"));
    expect(pairs.lookup("/m/x.mp4")).toMatchObject({ status: "unknown", note: expect.stringContaining("capture record") });
    expect(pairs.lookup("/m/y.mp4").status).toBe("unknown");
    expect(pairs.lookup("/m/a.mp4")).toMatchObject({ status: "matched", entry: { sessionId: "A" } });
    expect(pairs.size).toBe(2);
    expect(pairRecordingsWithLog("").lookup("/m/a.mp4")).toMatchObject({ status: "unknown", note: "the log names no recording" });
  });

  it("lets a same-second retry reuse an empty failure's temporary name, and skips a lock-refused launch", () => {
    const pairs = pairRecordingsWithLog([
      start(0), capture(1, "A", "1080p", 1080),
      failed(3, "A", { outcome: "empty", recordingPath: "/m/x.recording.mp4" }),
      "[2026-09-25T10:00:04.000Z] start: another instance already holds the userData lock; run 20260925T100004000Z-99; exiting",
      capture(5, "B", "4k", 2160),
      failed(9, "B", { partialPath: "/m/x.recording.mp4", recordingPath: "/m/x.recording.mp4" }),
      capture(20, "C", "1440p", 1440), saved(30, "C", "/m/c.mp4"),
    ].join("\n"));
    expect(pairs.lookup("/m/x.recording.mp4")).toMatchObject({ status: "matched", entry: { sessionId: "B" } });
    expect(cap(pairs, "/m/c.mp4")).toBe("1440p");
    const legacy = pairRecordingsWithLog([
      "[2026-09-24T09:00:00.000Z] start: RecordStuff 0.9.0; electron 44; executable /x",
      `[2026-09-24T09:00:01.000Z] ${CAPTURE_LINE.replace("mtynus3n-i3lxyd", "old").replace("cap=1440p", "cap=source")}`,
      "[2026-09-24T09:00:02.000Z] start: another instance already holds the userData lock; exiting",
      "[2026-09-24T09:00:11.000Z] saved /m/old.mp4",
    ].join("\n"));
    expect(legacy.lookup("/m/old.mp4").entry?.requested.resolutionCap).toBe("source");
  });

  it("pairs the same session id in different launches separately", () => {
    const pairs = pairRecordingsWithLog([start(0, "run-1"), capture(1, "s", "1080p", 1080, "run-1"), saved(11, "s", "/m/1.mp4", "run-1"),
      start(20, "run-2"), capture(21, "s", "4k", 2160, "run-2"), saved(31, "s", "/m/2.mp4", "run-2")].join("\n"));
    expect(pairs.lookup("/m/1.mp4").entry).toMatchObject({ runId: "run-1", requested: { resolutionCap: "1080p" } });
    expect(pairs.lookup("/m/2.mp4").entry).toMatchObject({ runId: "run-2", requested: { resolutionCap: "4k" } });
  });

  it("explains missing metadata in the report instead of printing a clean request line", () => {
    const text = formatText("/m/a.mp4", undefined, [], { status: "ambiguous", note: "2 sessions name this file" });
    expect(text).toContain("Log metadata ambiguous: 2 sessions name this file; checks against requested settings not judged");
  });
});

describe("frame statistics", () => {
  it("parses pts csv and counts drops from gaps", () => {
    const times = parseFrameTimes("0.000000,\n0.033333,\n0.066667\n\n0.133333,\n");
    expect(times).toEqual([0, 0.033333, 0.066667, 0.133333]);
    const stats = frameStats([times], 30);
    expect(stats.frames).toBe(4);
    expect(stats.dropped).toBe(1);
    expect(stats.dropRate).toBeCloseTo(0.2);
    expect(stats.maxGapMs).toBeCloseTo(66.7, 0);
  });

  it("evaluates head and tail samples separately so the jump between them is not a drop", () => {
    const head = [0, 1 / 30, 2 / 30];
    const tail = [500, 500 + 1 / 30, 500 + 2 / 30];
    expect(frameStats([head, tail], 30)).toEqual({ frames: 6, dropped: 0, dropRate: 0, maxGapMs: expect.closeTo(33.3, 0) });
    expect(frameStats([[0, 1 / 30 + 0.01]], 30).dropped).toBe(0); // jitter below 1.5× is not a drop
    expect(frameStats([], 30)).toEqual({ frames: 0, dropped: 0, dropRate: 0, maxGapMs: 0 });
  });
});

describe("sync markers", () => {
  it("parses ffmpeg detector output and drops the EOF closure of an open interval (F1)", () => {
    const black = "[blackdetect @ 0x1] black_start:0.1 black_end:1.0333 black_duration:0.93\n[blackdetect @ 0x1] black_start:1.133 black_end:2.033 black_duration:0.9\n";
    expect(parseBlackdetect(black)).toEqual([1.0333, 2.033]);
    expect(parseBlackdetect(black, 2.05)).toEqual([1.0333]);
    // A black, silent file: ffmpeg closes both intervals at EOF; neither is a marker.
    expect(parseBlackdetect("[blackdetect] black_start:0 black_end:2.966667 black_duration:2.966667", 3)).toEqual([]);
    expect(parseSilencedetect("[silencedetect] silence_start: 0\n[silencedetect] silence_end: 3 | silence_duration: 3", 3)).toEqual([]);
    expect(
      parseSilencedetect("[silencedetect @ 0x2] silence_start: 0.06\n[silencededetect] silence_end: 1.05 | silence_duration: 0.99\n"),
    ).toEqual([1.05]);
    expect(
      parseChannelRms(
        [
          "[Parsed_astats_0 @ 0x3] Channel: 1",
          "[Parsed_astats_0 @ 0x3] DC offset: 0.000001",
          "[Parsed_astats_0 @ 0x3] RMS level dB: -23.5",
          "[Parsed_astats_0 @ 0x3] Channel: 2",
          "[Parsed_astats_0 @ 0x3] RMS level dB: -inf",
          "[Parsed_astats_0 @ 0x3] Overall",
          "[Parsed_astats_0 @ 0x3] RMS level dB: -26.5",
        ].join("\n"),
      ),
    ).toEqual([-23.5, Number.NEGATIVE_INFINITY]);
  });

  it("matches flashes to the nearest beep and measures head/tail drift", () => {
    const flashes = Array.from({ length: 130 }, (_, i) => i + 1);
    // Audio starts 20 ms late and drifts 1 ms per second → 150 ms late at the end.
    const beeps = flashes.map((t) => t + 0.02 + t * 0.001);
    const stats = syncStats(flashes, beeps, { durationSeconds: 131 });
    expect(stats?.pairs).toBe(130);
    expect(stats?.headOffsetMs).toBeCloseTo(20 + 30, 0);
    expect(stats?.tailOffsetMs).toBeCloseTo(20 + 100, 0);
    expect(stats?.driftMs).toBeCloseTo(70, 0);
  });

  it("anchors the tail window to the recording length, not the last marker found (F2)", () => {
    // Markers only in the first two minutes of a ten-minute file: no tail, no drift.
    const flashes = Array.from({ length: 120 }, (_, i) => i + 1);
    const beeps = flashes.map((t) => t + 0.02);
    const stats = syncStats(flashes, beeps, { durationSeconds: 600 });
    expect(stats?.pairs).toBe(120);
    expect(stats?.tailOffsetMs).toBeUndefined();
    expect(stats?.driftMs).toBeUndefined();
  });

  it("ignores beeps outside the window, needs at least three pairs, and has no drift for short files", () => {
    const short = syncStats([1, 2, 3], [1.03, 2.03, 3.03, 7.5], { durationSeconds: 8 });
    expect(short?.pairs).toBe(3);
    expect(short?.medianOffsetMs).toBeCloseTo(30);
    expect(short?.driftMs).toBeUndefined();
    expect(syncStats([1, 2], [5, 6])).toBeUndefined();
    expect(syncStats([2.97], [3.0], { durationSeconds: 3 })).toBeUndefined(); // one stray pair is not a measurement
  });
});

function info(overrides: { video?: Partial<ProbeInfo["streams"][number]>; audio?: Partial<ProbeInfo["streams"][number]> | null; format?: ProbeInfo["format"] } = {}): ProbeInfo {
  const streams: ProbeInfo["streams"] = [
    {
      codec_type: "video",
      codec_name: "h264",
      width: 1920,
      height: 1080,
      pix_fmt: "yuv420p",
      r_frame_rate: "30/1",
      nb_read_frames: "900",
      duration: "30.000",
      start_time: "0.000",
      ...overrides.video,
    },
  ];
  if (overrides.audio !== null) {
    streams.push({
      codec_type: "audio",
      codec_name: "aac",
      sample_rate: "48000",
      channels: 2,
      channel_layout: "stereo",
      bit_rate: "256000",
      duration: "30.020",
      start_time: "0.021",
      ...overrides.audio,
    });
  }
  return { format: overrides.format ?? { duration: "30.020", bit_rate: "8356000", size: "31335000" }, streams };
}

const ENTRY = parseCaptureLine(
  "recorder: session s capture: requested video=standard cap=1080p fps=30 audio=high; track size=1920x1080 fps=30 sampleRate=48000 Hz channels=2; target videoBps=8100000 audioBps=256000",
)!;

const evenFrames = (count: number, fps: number): number[] => Array.from({ length: count }, (_, i) => i / fps);

describe("measure + judge", () => {
  it("passes a recording that matches the log and every threshold", () => {
    const m = measure("a.mp4", 31_335_000, info(), [evenFrames(900, 30)], { channelRmsDb: [-20, -21], nominalFps: 30 });
    expect(m.video?.bitsPerSecond).toBe(8_356_000 - 256_000); // total minus audio when the stream has no bit_rate
    const checks = judge(m, ENTRY, { screen: { width: 1920, height: 1080 }, movingMaterial: true });
    const byMetric = Object.fromEntries(checks.map((c) => [c.metric, c]));
    expect(byMetric["Output dimensions"]?.verdict).toBe("pass");
    expect(byMetric["Average frame rate"]?.verdict).toBe("pass");
    expect(byMetric["Dropped frames"]?.verdict).toBe("pass");
    expect(byMetric["Audio-video duration difference"]?.verdict).toBe("pass");
    expect(byMetric["Audio-video start offset (container)"]?.verdict).toBe("pass");
    expect(byMetric["Audio-video offset (flash/beep)"]?.verdict).toBe("n/a");
    expect(byMetric["Audio-video offset (flash/beep)"]?.note).toBe("Requires --sync and the test material page");
    expect(byMetric["Sample rate/channels"]?.verdict).toBe("pass");
    expect(byMetric["Video bitrate"]?.verdict).toBe("pass");
    expect(byMetric["Audio bitrate"]?.verdict).toBe("pass");
    expect(byMetric["CPU (all Electron processes)"]?.verdict).toBe("n/a");
    const busy = judge(measure("cpu.mp4", 1, info(), [evenFrames(900, 30)], { cpu: { averagePercent: 55, peakPercent: 80 } }), ENTRY, { movingMaterial: true });
    expect(busy.find((c) => c.metric.startsWith("CPU"))?.verdict).toBe("fail");
    const calm = judge(measure("cpu.mp4", 1, info(), [evenFrames(900, 30)], { cpu: { averagePercent: 15, peakPercent: 20 } }), ENTRY, { movingMaterial: true });
    expect(calm.find((c) => c.metric.startsWith("CPU"))?.verdict).toBe("pass");
    expect(byMetric["Decodability (ffprobe full frame decode)"]?.verdict).toBe("pass");
    expect(overallVerdict(checks)).toBe("pass");
  });

  it("fails size, aspect, fps, drops, offsets, mono audio and clamped bitrate", () => {
    // Square output from a 1440p cap on a 16:9 screen, mono, 20 fps, audio 130 ms late, bitrate at 55 % of target.
    const entry = parseCaptureLine(
      "recorder: session s capture: requested video=standard cap=1440p fps=30 audio=high; track size=1440x1440 fps=30 sampleRate=48000 Hz channels=1; target videoBps=8100000 audioBps=256000",
    )!;
    const probe = info({
      video: { width: 1440, height: 1440, nb_read_frames: "600", start_time: "0.000" },
      audio: { channels: 1, channel_layout: "mono", start_time: "0.130", duration: "30.250" },
      format: { duration: "30.25", bit_rate: "4700000", size: "17770000" },
    });
    const frames = evenFrames(600, 20);
    const m = measure("b.mp4", 17_770_000, probe, [frames], { channelRmsDb: [-20], nominalFps: 30 });
    const checks = judge(m, entry, { screen: { width: 1920, height: 1080 }, movingMaterial: true });
    const byMetric = Object.fromEntries(checks.map((c) => [c.metric, c]));
    expect(byMetric["Output dimensions"]?.verdict).toBe("fail");
    expect(byMetric["Output dimensions"]?.note).toContain("aspect ratio differs from screen 1920x1080 (expected 1920x1080)");
    // F3: a 1080p cap that produced 4K fails even without --screen, and even when the track agrees.
    const uncapped = parseCaptureLine(
      "recorder: session s capture: requested video=standard cap=1080p fps=30 audio=high; track size=3840x2160 fps=30 sampleRate=48000 Hz channels=2; target videoBps=8100000 audioBps=256000",
    )!;
    const big = measure("big.mp4", 1, info({ video: { width: 3840, height: 2160 } }), [evenFrames(900, 30)], {});
    const size = judge(big, uncapped).find((c) => c.metric === "Output dimensions");
    expect(size?.verdict).toBe("fail");
    expect(size?.note).toContain("exceeds cap 1080p");
    expect(byMetric["Average frame rate"]?.verdict).toBe("fail");
    expect(byMetric["Dropped frames"]?.verdict).toBe("fail"); // 20 fps against a 30 fps nominal: every gap is 1.5× → drops
    expect(byMetric["Audio-video duration difference"]?.verdict).toBe("fail");
    expect(byMetric["Audio-video start offset (container)"]?.verdict).toBe("fail");
    expect(byMetric["Sample rate/channels"]?.verdict).toBe("fail");
    expect(byMetric["Video bitrate"]?.verdict).toBe("fail"); // 55 % of target is below the 70 % floor
    expect(overallVerdict(checks)).toBe("fail");
  });

  it("does not judge frame timing for content of unknown motion, and reports the reason", () => {
    // A desktop recording: the encoder emitted 57.5 fps of a 60 fps request because the picture was often still.
    const entry = parseCaptureLine(
      "recorder: session s capture: requested video=standard cap=source fps=60; track size=1920x1080 fps=60 sampleRate=48000 Hz channels=2; target videoBps=16200000 audioBps=256000",
    )!;
    const probe = info({ video: { r_frame_rate: "60/1", nb_read_frames: "1725", duration: "30.000" } });
    const m = measure("desk.mp4", 90_000_000, probe, [evenFrames(1725, 57.5)], { channelRmsDb: [-29, -29], nominalFps: 60 });
    const unknown = Object.fromEntries(judge(m, entry).map((c) => [c.metric, c]));
    expect(unknown["Average frame rate"]?.verdict).toBe("n/a");
    expect(unknown["Average frame rate"]?.note).toContain("--moving");
    expect(unknown["Dropped frames"]?.verdict).toBe("n/a");
    expect(unknown["Dropped frames"]?.actual).toContain("%"); // still measured and shown
    const moving = Object.fromEntries(judge(m, entry, { movingMaterial: true }).map((c) => [c.metric, c]));
    expect(moving["Average frame rate"]?.verdict).toBe("fail");
    expect(moving["Average frame rate"]?.note).toBeUndefined();
  });

  it("treats bitrate as a floor: overshoot passes with a note, undershoot fails, audio has its own floor", () => {
    const over = info({ format: { duration: "30.000", bit_rate: "24_000_000".replace(/_/g, ""), size: "90000000" } });
    const m = measure("over.mp4", 90_000_000, over, [evenFrames(900, 30)], { channelRmsDb: [-20, -20] });
    const byMetric = Object.fromEntries(judge(m, ENTRY).map((c) => [c.metric, c]));
    expect(byMetric["Video bitrate"]?.verdict).toBe("pass"); // 23.7 Mbps against an 8.1 Mbps target
    expect(byMetric["Video bitrate"]?.note).toContain("Above target");
    expect(byMetric["Video bitrate"]?.expected).toContain("≥ 70%");
    const quiet = measure("quiet.mp4", 1, info({ audio: { bit_rate: "160000" } }), [evenFrames(900, 30)], { channelRmsDb: [-20, -20] });
    const quietAudio = judge(quiet, ENTRY).find((c) => c.metric === "Audio bitrate");
    expect(quietAudio?.verdict).toBe("pass"); // 62.5 % of the request, above the 50 % floor
    expect(quietAudio?.note).toContain("below the request is normal");
    const starved = measure("starved.mp4", 1, info({ audio: { bit_rate: "96000" } }), [evenFrames(900, 30)], { channelRmsDb: [-20, -20] });
    expect(judge(starved, ENTRY).find((c) => c.metric === "Audio bitrate")?.verdict).toBe("fail");
    // The test material's sparse beeps: the same starved bitrate is reported, not judged.
    const material = judge(starved, ENTRY, { testMaterial: true }).find((c) => c.metric === "Audio bitrate");
    expect(material?.verdict).toBe("n/a");
    expect(material?.actual).toContain("96 kbps");
    expect(material?.note).toContain("Reported only");
  });

  it("judges duration against the log session length when no matrix duration is given", () => {
    const entry = { ...ENTRY, recordingStartedAtMs: Date.parse("2026-09-19T10:00:00.000Z"), stoppedAtMs: Date.parse("2026-09-19T10:00:30.100Z") };
    const m = measure("s.mp4", 1, info(), [evenFrames(900, 30)], {});
    const fromLog = judge(m, entry).find((c) => c.metric === "Recording duration");
    expect(fromLog?.verdict).toBe("pass");
    expect(fromLog?.expected).toContain("log session");
    const cut = judge(m, { ...entry, stoppedAtMs: Date.parse("2026-09-19T10:01:00.000Z") }).find((c) => c.metric === "Recording duration");
    expect(cut?.verdict).toBe("fail"); // the session ran 60 s but the file holds 30 s
    const requested = judge(m, entry, { expectedDurationSeconds: 30 }).find((c) => c.metric === "Recording duration");
    expect(requested?.expected).toContain("requested");
    const noInfo = judge(m, ENTRY).find((c) => c.metric === "Recording duration");
    expect(noInfo?.verdict).toBe("n/a");
    expect(noInfo?.note).toContain("timestamped log session");
  });

  it("marks log-dependent checks not applicable without a log entry and flags a silent channel", () => {
    const m = measure("c.mp4", 31_335_000, info(), [evenFrames(900, 30)], {
      channelRmsDb: [-20, Number.NEGATIVE_INFINITY],
      sync: { pairs: 29, medianOffsetMs: 35, headOffsetMs: 35, tailOffsetMs: undefined, driftMs: undefined },
    });
    const checks = judge(m, undefined, { movingMaterial: true });
    const byMetric = Object.fromEntries(checks.map((c) => [c.metric, c]));
    expect(byMetric["Output dimensions"]?.verdict).toBe("n/a");
    expect(byMetric["Average frame rate"]?.verdict).toBe("n/a");
    expect(byMetric["Video bitrate"]?.verdict).toBe("n/a");
    expect(byMetric["Audio-video offset (flash/beep)"]?.verdict).toBe("pass");
    expect(byMetric["End-to-end A/V drift"]?.verdict).toBe("n/a");
    // ITU-R BT.1359 asymmetry: 80 ms late is fine, 60 ms early is not.
    const late = judge(measure("l.mp4", 1, info(), [], { sync: { pairs: 20, medianOffsetMs: 80, headOffsetMs: 80, tailOffsetMs: undefined, driftMs: undefined } }), undefined);
    expect(late.find((c) => c.metric.startsWith("Audio-video offset (flash"))?.verdict).toBe("pass");
    const early = judge(measure("e.mp4", 1, info(), [], { sync: { pairs: 20, medianOffsetMs: -60, headOffsetMs: -60, tailOffsetMs: undefined, driftMs: undefined } }), undefined);
    expect(early.find((c) => c.metric.startsWith("Audio-video offset (flash"))?.verdict).toBe("fail");
    expect(byMetric["Sample rate/channels"]?.verdict).toBe("fail");
    expect(byMetric["Sample rate/channels"]?.actual).toContain("−∞");
  });

  it("treats decode errors and a missing audio track as failures, and says when --sync found nothing", () => {
    const m = measure("d.mp4", 100, info({ audio: null }), [evenFrames(10, 30)], { decodeErrors: "moov atom not found", syncAttempted: true });
    const byMetric = Object.fromEntries(judge(m, ENTRY).map((c) => [c.metric, c]));
    expect(byMetric["Audio-video offset (flash/beep)"]?.note).toContain("found no");
    expect(byMetric["Recording duration"]?.verdict).toBe("n/a");
    const cut = judge(measure("e.mp4", 1, info(), [evenFrames(900, 30)], {}), ENTRY, { expectedDurationSeconds: 600 }).find((c) => c.metric === "Recording duration");
    expect(cut?.verdict).toBe("fail");
    const full = judge(measure("f.mp4", 1, info(), [evenFrames(900, 30)], {}), ENTRY, { expectedDurationSeconds: 30 }).find((c) => c.metric === "Recording duration");
    expect(full?.verdict).toBe("pass");
    expect(m.decodable).toBe(false);
    expect(byMetric["Decodability (ffprobe full frame decode)"]?.verdict).toBe("fail");
    expect(byMetric["Sample rate/channels"]?.verdict).toBe("fail");
    expect(byMetric["Audio-video duration difference"]?.verdict).toBe("n/a");
  });

  it("formats text and markdown with the verdict marks and a human section", () => {
    const m = measure("e.mp4", 31_335_000, info(), [evenFrames(900, 30)], { channelRmsDb: [-20, -21], cpu: { averagePercent: 42.4, peakPercent: 61 } });
    const checks = judge(m, ENTRY);
    const text = formatText("e.mp4", ENTRY, checks);
    expect(text).toContain("✅ Output dimensions");
    expect(text).toContain("average 42%, peak 61%");
    const md = formatMarkdown("1080p Standard (30 s)", "e.mp4", ENTRY, checks, { material: "scripts/test-material.html" });
    expect(md).toContain("### 1080p Standard (30 s)");
    expect(md).toContain("| Metric | Threshold/request | Measured | Verdict |");
    expect(md).toContain("Subjective comparison (manual)");
    expect(md).toContain(`< ${THRESHOLDS.maxDropRate * 100}%`);
  });
});
