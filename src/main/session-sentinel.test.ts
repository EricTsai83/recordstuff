import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RecordingResultStore, type ResultStorage } from "./recording-result-store";
import { RecordingResults, failureGuidance, failureReason, isOutputFolderFailure, isPermissionFailure } from "./recording-result";
import { SessionSentinels, reportInterruptions, type SessionSentinel } from "./session-sentinel";

let dir: string, sentinelDir: string, historyFile: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-sentinel-"));
  sentinelDir = path.join(dir, "recording-sessions");
  historyFile = path.join(dir, "recording-history.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const stat = (file: string) => fs.promises.stat(file);
const sentinel = (sessionId: string, name: string): SessionSentinel =>
  ({ sessionId, startedAt: "2026-09-25T10:00:00.000Z", recordingPath: path.join(dir, `${name}.recording.mp4`) });
/** One app launch: fresh controllers over the same userData files. */
function start(options: { log?: (message: string) => void; storage?: ResultStorage } = {}) {
  const results = new RecordingResults(options.storage ?? new RecordingResultStore(historyFile), () => {}, () => {}, [10]);
  const sentinels = new SessionSentinels(sentinelDir, options.log);
  const reported = reportInterruptions(sentinels, {
    restore: interrupted => results.restore(stat, vi.fn(), interrupted), saved: ids => results.saved(ids),
  }, options.log ?? (() => {}));
  return { results, sentinels, reported };
}
async function launch(options: { log?: (message: string) => void } = {}) {
  const launched = start(options);
  await launched.reported;
  return launched;
}
const remaining = () => fs.existsSync(sentinelDir) ? fs.readdirSync(sentinelDir) : [];

it("turns each leftover sentinel into one entry, partial only while its file exists, then removes it", async () => {
  const previous = new SessionSentinels(sentinelDir);
  const kept = sentinel("a1", "kept"), missing = sentinel("b2", "missing");
  await previous.write(kept);
  await previous.write(missing);
  fs.writeFileSync(kept.recordingPath, "partial bytes");

  const log = vi.fn();
  const { results } = await launch({ log });
  expect(log).toHaveBeenCalledWith(expect.stringContaining("2 recording session(s) did not finish"));
  const rows = [...results.all].sort((x, y) => x.id.localeCompare(y.id));
  expect(rows).toEqual([
    expect.objectContaining({ id: "interrupted-a1", code: "app_terminated", outcome: "partial", partialPath: kept.recordingPath, acknowledged: false, restored: true }),
    expect.objectContaining({ id: "interrupted-b2", code: "app_terminated", outcome: "unknown", recordingPath: missing.recordingPath, acknowledged: false }),
  ]);
  expect(rows[1]).not.toHaveProperty("partialPath");
  expect(rows[0]!.detail).toContain("session a1");
  expect(remaining()).toEqual([]);
  expect(fs.readFileSync(kept.recordingPath, "utf8")).toBe("partial bytes");

  // The saved history carries them; another launch rechecks without adding again.
  fs.renameSync(kept.recordingPath, path.join(dir, "moved-away.mp4"));
  const second = await launch();
  expect(second.results.all.map(r => [r.id, r.outcome])).toEqual(expect.arrayContaining([["interrupted-a1", "unknown"], ["interrupted-b2", "unknown"]]));
  expect(second.results.all).toHaveLength(2);
  expect(await second.results.acknowledge("interrupted-a1")).toBe(true);
  const third = await launch();
  expect(third.results.all).toHaveLength(2);
  expect(third.results.all.find(r => r.id === "interrupted-a1")).toMatchObject({ acknowledged: true });
});

it("keeps sentinels while the history cannot be saved and never adds an entry twice", async () => {
  await new SessionSentinels(sentinelDir).write(sentinel("c3", "c3"));
  fs.writeFileSync(historyFile, "{ corrupt");
  const log = vi.fn();
  const blocked = start({ log });
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith("start: interruption sentinels kept until the failure history is saved"));
  expect(blocked.results.all).toEqual([expect.objectContaining({ id: "interrupted-c3", code: "app_terminated" })]);
  expect(remaining()).toEqual(["c3.json"]);

  // Once history is healthy the entry is saved; a sentinel whose removal failed is not reported again.
  fs.rmSync(historyFile);
  const healthy = new RecordingResults(new RecordingResultStore(historyFile));
  const sentinels = new SessionSentinels(sentinelDir);
  await healthy.restore(stat, vi.fn(), (await sentinels.leftovers()).map(s => ({
    id: `interrupted-${s.sessionId}`, occurredAt: s.startedAt, code: "app_terminated" as const, detail: "", outcome: "unknown" as const,
  })));
  expect(remaining()).toEqual(["c3.json"]);
  const relaunched = await launch();
  expect(relaunched.results.all.filter(r => r.id === "interrupted-c3")).toHaveLength(1);
  expect(remaining()).toEqual([]);
});

it("removes a sentinel once an automatic retry saves its entry, so a removed entry never returns", async () => {
  await new SessionSentinels(sentinelDir).write(sentinel("d4", "d4"));
  const store = new RecordingResultStore(historyFile);
  let saves = 0;
  const flaky: ResultStorage = { load: () => store.load(),
    save: async results => { if (++saves === 1) throw new Error("EIO: transient"); await store.save(results); } };
  const log = vi.fn();
  const first = start({ log, storage: flaky });
  await first.reported;
  expect(saves).toBeGreaterThanOrEqual(2);
  expect(log).toHaveBeenCalledWith("start: interruption sentinels kept until the failure history is saved");
  expect(remaining()).toEqual([]);
  expect(await first.results.acknowledge("interrupted-d4")).toBe(true);
  expect(await first.results.remove("interrupted-d4")).toBe(true);
  const restarted = await launch();
  expect(restarted.results.all).toEqual([]);
});

it("removes the sentinels when an entry is reviewed and removed while the launch recheck is still running", async () => {
  const media = path.join(dir, "slow.mp4");
  await new RecordingResultStore(historyFile).save([{ id: "older", occurredAt: "2026-09-24T10:00:00.000Z", code: "disk_full", detail: "",
    outcome: "partial", partialPath: media, acknowledged: true }]);
  await new SessionSentinels(sentinelDir).write(sentinel("f6", "f6"));
  let release: (() => void) | undefined;
  const check = (file: string) => file === media
    ? new Promise<{ isFile(): boolean; size: number }>(resolve => { release = () => resolve({ isFile: () => true, size: 1 }); })
    : stat(file);
  const results = new RecordingResults(new RecordingResultStore(historyFile));
  const reported = reportInterruptions(new SessionSentinels(sentinelDir), {
    restore: interrupted => results.restore(check, vi.fn(), interrupted), saved: ids => results.saved(ids),
  }, () => {});
  await vi.waitFor(() => expect(release).toBeDefined());
  expect(await results.acknowledge("interrupted-f6")).toBe(true);
  expect(await results.remove("interrupted-f6")).toBe(true);
  release!();
  await reported;
  expect(remaining()).toEqual([]);
  const restarted = await launch();
  expect(restarted.results.all.map(r => r.id)).toEqual(["older"]);
});

it("keeps a sentinel it cannot read now and reports it once it can", async () => {
  const previous = new SessionSentinels(sentinelDir);
  await previous.write(sentinel("e5", "e5"));
  const file = path.join(sentinelDir, "e5.json");
  fs.chmodSync(file, 0o000);
  const log = vi.fn();
  try {
    expect(await new SessionSentinels(sentinelDir, log).leftovers()).toEqual([]);
    expect(remaining()).toEqual(["e5.json"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("could not read e5.json; kept for a later launch"));
  } finally { fs.chmodSync(file, 0o600); }
  expect(await new SessionSentinels(sentinelDir).leftovers()).toEqual([sentinel("e5", "e5")]);
});

it("never reports this process's own sessions and discards unusable leftovers", async () => {
  const log = vi.fn();
  const sentinels = new SessionSentinels(sentinelDir, log);
  await sentinels.write(sentinel("live", "live"));
  fs.writeFileSync(path.join(sentinelDir, "torn.json.tmp"), "{\"version\":1");
  fs.writeFileSync(path.join(sentinelDir, "bad.json"), "not json");
  fs.writeFileSync(path.join(sentinelDir, "other.json"), JSON.stringify({ version: 1, ...sentinel("mismatch", "x") }));
  fs.writeFileSync(path.join(sentinelDir, "notes.txt"), "unrelated");
  expect(await sentinels.leftovers()).toEqual([]);
  expect(remaining().sort()).toEqual(["live.json", "notes.txt"]);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("discarding interrupted write torn.json.tmp"));
  expect(log).toHaveBeenCalledWith(expect.stringContaining("discarding invalid sentinel bad.json"));
  await sentinels.remove("live");
  expect(remaining()).toEqual(["notes.txt"]);
  await expect(sentinels.write(sentinel("../escape", "x"))).rejects.toThrow("invalid session id");
  expect(await new SessionSentinels(path.join(dir, "absent")).leftovers()).toEqual([]);
});

it("explains the interruption without pointing at settings, the folder or permissions", () => {
  expect(failureReason("app_terminated", "en")).toBe("RecordStuff did not exit normally while recording.");
  expect(failureReason("app_terminated", "zh-TW")).toBe("RecordStuff 在錄製期間未正常結束");
  expect(failureGuidance("app_terminated", "en")).toContain("may be incomplete. RecordStuff does not repair it");
  expect(failureGuidance("app_terminated", "zh-TW")).toContain("不會修復");
  expect(isOutputFolderFailure("app_terminated") || isPermissionFailure("app_terminated")).toBe(false);
});
