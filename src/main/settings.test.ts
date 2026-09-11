import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsStore, parseSettings } from "./settings";

let dir: string;
let filePath: string;
const logs: string[] = [];
const DEFAULT = "/Users/test/Movies/RecordStuff";

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordstuff-settings-"));
  filePath = path.join(dir, "settings.json");
  logs.length = 0;
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const store = () => new SettingsStore({ filePath, defaultOutputDir: DEFAULT, log: (m) => logs.push(m) });

describe("SettingsStore", () => {
  it("uses the default when the file does not exist, silently", () => {
    expect(store().outputDir).toBe(DEFAULT);
    expect(logs).toEqual([]);
  });

  it("falls back and logs on broken JSON", async () => {
    await fs.writeFile(filePath, "{ not json");
    expect(store().outputDir).toBe(DEFAULT);
    expect(logs).toHaveLength(1);
  });

  it("falls back on an unknown version", async () => {
    await fs.writeFile(filePath, JSON.stringify({ version: 2, outputDir: "/somewhere" }));
    expect(store().outputDir).toBe(DEFAULT);
    expect(logs).toHaveLength(1);
  });

  it("falls back on a wrong field type or relative path", async () => {
    await fs.writeFile(filePath, JSON.stringify({ version: 1, outputDir: 42 }));
    expect(store().outputDir).toBe(DEFAULT);
    await fs.writeFile(filePath, JSON.stringify({ version: 1, outputDir: "relative/dir" }));
    expect(store().outputDir).toBe(DEFAULT);
  });

  it("round-trips outputDir and persists across instances", async () => {
    const first = store();
    await first.setOutputDir("/Volumes/External/Recordings");
    expect(first.outputDir).toBe("/Volumes/External/Recordings");
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({
      version: 1,
      outputDir: "/Volumes/External/Recordings",
    });
    expect(store().outputDir).toBe("/Volumes/External/Recordings");
    await expect(fs.stat(`${filePath}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates the parent directory on first write", async () => {
    const nested = path.join(dir, "a", "b", "settings.json");
    const s = new SettingsStore({ filePath: nested, defaultOutputDir: DEFAULT });
    await s.setOutputDir("/tmp/x");
    expect(JSON.parse(await fs.readFile(nested, "utf8")).outputDir).toBe("/tmp/x");
  });

  it("a leftover tmp file from a crashed write is ignored and then overwritten", async () => {
    await fs.writeFile(filePath, JSON.stringify({ version: 1, outputDir: "/good" }));
    await fs.writeFile(`${filePath}.tmp`, '{"version":1,"outputDir":"/half');
    const s = store();
    expect(s.outputDir).toBe("/good");
    await s.setOutputDir("/new");
    expect(JSON.parse(await fs.readFile(filePath, "utf8")).outputDir).toBe("/new");
    await expect(fs.stat(`${filePath}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a relative outputDir without touching the file", async () => {
    const s = store();
    await expect(s.setOutputDir("relative")).rejects.toThrow(/absolute/);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("parseSettings", () => {
  it("accepts only version 1 with an absolute string outputDir", () => {
    expect(parseSettings('{"version":1,"outputDir":"/a"}')).toEqual({ version: 1, outputDir: "/a" });
    expect(parseSettings('{"version":1,"outputDir":""}')).toBeUndefined();
    expect(parseSettings("null")).toBeUndefined();
    expect(parseSettings("[]")).toBeUndefined();
  });
});
