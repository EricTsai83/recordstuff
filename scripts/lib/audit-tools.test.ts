import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hasTool } from "./media-tools.mts";
import { appendMeasurements, parseDimensions } from "./verify-recording.mts";
import { parseStableTag } from "./release-manifest.mts";

let directory: string | undefined;
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); directory = undefined; });
const temporary = () => directory = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-tools-"));

it("rejects a tool with a failing version command and bounds a hung tool", () => {
  const dir = temporary(), tool = path.join(dir, "tool");
  fs.writeFileSync(tool, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  expect(hasTool(tool)).toBe(false);
  fs.writeFileSync(tool, "#!/bin/sh\nwhile :; do :; done\n", { mode: 0o755 });
  vi.stubEnv("RECORDSTUFF_MEDIA_TIMEOUT_MS", "50");
  const start = performance.now();
  expect(hasTool(tool)).toBe(false);
  expect(performance.now() - start).toBeLessThan(2000);
});

it("reports a bad media timeout instead of a missing tool", () => {
  vi.stubEnv("RECORDSTUFF_MEDIA_TIMEOUT_MS", "30s");
  expect(() => hasTool("ffprobe")).toThrow(/RECORDSTUFF_MEDIA_TIMEOUT_MS/);
});

it.each(["0x1080", "1920x0", "x1080"])("refuses the screen size %s", text => {
  expect(parseDimensions(text)).toBeUndefined();
  expect(parseDimensions("1920x1080")).toEqual({ width: 1920, height: 1080 });
});

it.each(["v01.2.3", "v1.02.3", "v1.2.03", "v1.2.3+build"])("rejects inconsistent stable tag %s", tag => {
  expect(() => parseStableTag(tag)).toThrow();
});

it("replays both report snapshots after interruption before appending again", () => {
  const dir = temporary(), md = path.join(dir, "report.md"), json = path.join(dir, "report.json");
  fs.writeFileSync(md, "old report\n"); fs.writeFileSync(json, "[]");
  const rename = fs.renameSync;
  const failure = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === md) throw new Error("interrupted markdown publication");
    return rename(from, to);
  });
  expect(() => appendMeasurements(md, [], { title: () => "", runLabel: "first" })).toThrow("interrupted");
  failure.mockRestore();
  expect(fs.existsSync(md + ".pending")).toBe(true);
  appendMeasurements(md, [], { title: () => "", runLabel: "second" });
  const report = fs.readFileSync(md, "utf8");
  expect(report.match(/— first/g)).toHaveLength(1);
  expect(report.match(/— second/g)).toHaveLength(1);
  expect(JSON.parse(fs.readFileSync(json, "utf8"))).toEqual([]);
  expect(fs.existsSync(md + ".pending")).toBe(false);
});
