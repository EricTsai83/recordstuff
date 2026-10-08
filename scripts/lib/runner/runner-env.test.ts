import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INHERITED_ELECTRON_KEYS, readAppSettings, runnerArgs, scrubbedEnv, writeAppSettings } from "./runner-env.mts";

let dir: string | undefined;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe("runner environment", () => {
  it("removes every inherited Electron variable and keeps the rest", () => {
    const env = scrubbedEnv({ PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1", ELECTRON_RENDERER_URL: "http://x", RECORDSTUFF_AUTORECORD: "{}", NODE_OPTIONS: "--x", HOME: "/h" });
    for (const key of INHERITED_ELECTRON_KEYS) expect(env).not.toHaveProperty(key);
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/h" });
  });

  it("rewrites settings through a rename and leaves no temporary file", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-runner-env-"));
    const file = path.join(dir, "nested", "settings.json");
    expect(readAppSettings(file)).toBeUndefined();
    writeAppSettings({ countdown: 0, language: "en" }, file);
    expect(readAppSettings(file)).toEqual({ countdown: 0, language: "en" });
    expect(fs.readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["settings.json"]);
  });
});

it.each(["null", "[]", '"text"', "3"])("rejects non-object settings %s without overwriting them", value => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-runner-env-"));
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, value);
  expect(() => readAppSettings(file)).toThrow(/JSON object/);
  expect(fs.readFileSync(file, "utf8")).toBe(value);
});

it("removes its temporary file when publication fails", () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-runner-env-"));
  const file = path.join(dir, "settings.json");
  fs.mkdirSync(file);
  expect(() => writeAppSettings({ language: "en" }, file)).toThrow();
  expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
  expect(fs.statSync(file).isDirectory()).toBe(true);
});

describe("runnerArgs", () => {
  it("drops the separator pnpm forwards, and only that one", () => {
    expect(runnerArgs(["node", "runner.mts", "--", "--out", "x"])).toEqual(["--out", "x"]);
    expect(runnerArgs(["node", "runner.mts", "--out", "x"])).toEqual(["--out", "x"]);
    expect(runnerArgs(["node", "runner.mts", "--", "--", "y"])).toEqual(["--", "y"]);
    expect(runnerArgs(["node", "runner.mts"])).toEqual([]);
  });
});
