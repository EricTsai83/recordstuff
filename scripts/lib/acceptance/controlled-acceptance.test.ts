import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transformWithEsbuild } from "vite";
import {
  SETTINGS_FILE_VERSION, instrumentControlledAcceptance, latestRun, nextRequestNumber, parseControlledArgs,
  seedFiles, selfTestFiles, writeSeedFiles,
} from "./controlled-acceptance.mts";
import { RecordingResults } from "../../../src/main/recording/recording-result";
import { RecordingResultStore } from "../../../src/main/recording/recording-result-store";
import { SETTINGS_VERSION, parseSettings } from "../../../src/main/settings/settings";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "controlled-acceptance-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("controlled acceptance instrumentation", () => {
  const source = fs.readFileSync(path.resolve("src/main/index.ts"), "utf8");
  it("wires data locations and fault boundaries into a copy of the current entry, which still compiles", async () => {
    const instrumented = instrumentControlledAcceptance(source, '/tmp/run with "quotes" $&');
    expect(instrumented).toContain('configureControlled("/tmp/run with \\"quotes\\" $&")');
    expect(instrumented).toContain("defaultOutputDir: controlled.outputDir || defaultOutputDir(),");
    expect(instrumented).toContain("  const recorder = new Recorder({\n    host: controlled.host(host),\n");
    expect(instrumented).toContain("openWriter: (recordingPath, finalPath) => controlled.openWriter(recordingPath, finalPath),");
    expect(instrumented).toContain("publishFailure: async result => { await controlled.beforePublish(result); return recordingResults.receive(result, {");
    expect(instrumented).toContain('notify: code => permissionNotices.failed(code),');
    expect(instrumented).toContain('failure: code => captureNotices.hold(`recording failure ${code}`, () => tray.notifyRecordingFailure(code)),');
    expect(instrumented).toContain("controlled.storage(new RecordingResultStore(");
    expect(instrumented).toContain("controlled.attach({ recorder, recordingResults, settings, tray, handleAction, log });\n  updates.flush();");
    await expect(transformWithEsbuild(instrumented, "index.ts", { loader: "ts" })).resolves.toBeDefined();
    expect(source).not.toContain("controlled");
  });
  it("fails closed when production wiring drifts or an anchor repeats", () => {
    expect(() => instrumentControlledAcceptance(source.replace("FileWriter.open(recordingPath, finalPath),", "FileWriter.open(recordingPath, finalPath, {}),"), "/tmp/x")).toThrow("anchor changed");
    const changedNotice = source.replace('notify: code => permissionNotices.failed(code),', "notify: () => undefined,");
    expect(changedNotice).not.toBe(source);
    expect(() => instrumentControlledAcceptance(changedNotice, "/tmp/x")).toThrow("anchor changed");
    expect(() => instrumentControlledAcceptance(source + "\nlet appLanguage: () => Language = () => DEFAULT_LANGUAGE;", "/tmp/x")).toThrow("anchor changed");
  });
});

describe("controlled acceptance seeds", () => {
  const now = Date.parse("2026-09-27T12:00:00.000Z");
  it("seeds a current-format partial result which the production store rechecks", async () => {
    writeSeedFiles(dir, seedFiles("partial", dir, now));
    const store = new RecordingResultStore(path.join(dir, "user-data/recording-history.json"), () => undefined);
    const results = new RecordingResults(store, () => undefined, () => undefined, [60_000]);
    await results.ready;
    await results.restore(file => fs.promises.stat(file), () => undefined);
    expect(results.all).toMatchObject([{ id: "seed-partial", outcome: "partial", acknowledged: false,
      partialPath: path.join(dir, "recordings/seed-partial.recording.mp4") }]);
  });
  it("seeds twenty reviewed records between two unread ones, at the retention limit", async () => {
    writeSeedFiles(dir, seedFiles("retention", dir, now));
    const results = new RecordingResults(new RecordingResultStore(path.join(dir, "user-data/recording-history.json")),
      () => undefined, () => undefined, [60_000]);
    await results.ready;
    expect(results.all).toHaveLength(22);
    expect(results.all.filter(r => !r.acknowledged).map(r => r.id)).toEqual(["seed-unread-new", "seed-unread-old"]);
    // Reviewing the oldest unread record keeps it and evicts the least recently reviewed one instead.
    expect(await results.acknowledge("seed-unread-old")).toBe(true);
    const ids = results.all.map(r => r.id);
    expect(results.all.filter(r => r.acknowledged)).toHaveLength(20);
    expect(ids).toContain("seed-unread-old");
    expect(ids).not.toContain("seed-reviewed-20");
    expect(results.all.find(r => r.id === "seed-unread-new")?.acknowledged).toBe(false);
  });
  it("gives the self-test quiet preferences the production parser accepts", () => {
    expect(SETTINGS_FILE_VERSION).toBe(SETTINGS_VERSION);
    const parsed = parseSettings(selfTestFiles(dir)["user-data/settings.json"]!);
    expect(parsed?.settings).toMatchObject({ outputDir: path.join(dir, "recordings"), notifications: false,
      hotkey: { enabled: false } });
    expect(parsed?.warnings.some(w => w.includes("hotkey"))).toBe(false);
    expect(seedFiles("none", dir, now)).toEqual({});
  });
  it("never overwrites an existing file", () => {
    writeSeedFiles(dir, { "user-data/a.json": "1" });
    expect(() => writeSeedFiles(dir, { "user-data/a.json": "2" })).toThrow();
    expect(fs.readFileSync(path.join(dir, "user-data/a.json"), "utf8")).toBe("1");
  });
});

describe("controlled acceptance arguments and runs", () => {
  it("parses each command and refuses what does not apply", () => {
    expect(parseControlledArgs(["--", "launch"])).toEqual({ command: "launch", seed: "none", holdHistoryLoad: false });
    expect(parseControlledArgs(["launch", "--seed", "retention", "--hold-history-load"])).toEqual({ command: "launch", seed: "retention", holdHistoryLoad: true });
    expect(parseControlledArgs(["fault", "cleanup=hold", "write=enospc", "--dir", "/tmp/r"])).toEqual({ command: "fault",
      faults: [{ name: "cleanup", mode: "hold" }, { name: "write", mode: "enospc" }], dir: "/tmp/r" });
    expect(parseControlledArgs(["release", "history-load"])).toEqual({ command: "release", target: "history-load" });
    expect(parseControlledArgs(["release", "prepare"])).toEqual({ command: "release", target: "prepare" });
    expect(parseControlledArgs(["fault", "prepare=hold"])).toEqual({ command: "fault", faults: [{ name: "prepare", mode: "hold" }] });
    expect(parseControlledArgs(["reopen", "--hold-history-load"])).toEqual({ command: "reopen", holdHistoryLoad: true });
    expect(parseControlledArgs(["status"])).toEqual({ command: "status" });
    expect(parseControlledArgs(["throw", "--dir", "/tmp/r"])).toEqual({ command: "throw", dir: "/tmp/r" });
    for (const bad of [[], ["record"], ["fault"], ["fault", "close=hold"], ["fault", "cleanup"], ["fault", "cleanup=hold=x"],
      ["release", "write"], ["status", "extra"], ["throw", "now"], ["status", "--seed", "v1"], ["launch", "--seed", "v2"], ["launch", "--dir", "/tmp"],
      ["selftest", "--hold-history-load"]]) {
      expect(() => parseControlledArgs(bad), bad.join(" ")).toThrow();
    }
  });
  it("finds the newest guided run and never a self-test", () => {
    const run = (name: string, createdAt: string, selftest = false): void => {
      fs.mkdirSync(path.join(dir, name));
      fs.writeFileSync(path.join(dir, name, "run.json"), JSON.stringify({ tool: "acceptance:controlled", createdAt, seed: "none", selftest }));
    };
    expect(latestRun(dir)).toBeUndefined();
    run("b", "2026-09-27T10:00:00.000Z");
    run("a", "2026-09-27T11:00:00.000Z");
    run("c", "2026-09-27T12:00:00.000Z", true);
    fs.mkdirSync(path.join(dir, "junk"));
    expect(latestRun(dir)).toBe(path.join(dir, "a"));
    expect(latestRun(path.join(dir, "missing"))).toBeUndefined();
  });
  it("numbers requests after every earlier one", () => {
    expect(nextRequestNumber([])).toBe(1);
    expect(nextRequestNumber(["1.json", "12.json", "13.json.tmp", "x"])).toBe(13);
  });
});
