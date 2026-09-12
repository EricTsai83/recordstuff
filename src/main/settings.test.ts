import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_QUALITY } from "../shared/quality";
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
    await fs.writeFile(filePath, JSON.stringify({ version: 3, outputDir: "/somewhere" }));
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
      version: 2,
      outputDir: "/Volumes/External/Recordings",
      quality: DEFAULT_QUALITY,
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

describe("quality settings (plan 007 §B3)", () => {
  const custom = { videoQuality: "high", resolutionCap: "1080p", frameRate: 60, audioQuality: "standard" } as const;

  it("a version 1 file keeps its outputDir, gets the default quality and logs the upgrade", async () => {
    await fs.writeFile(filePath, JSON.stringify({ version: 1, outputDir: "/old" }));
    const s = store();
    expect(s.outputDir).toBe("/old");
    expect(s.quality).toEqual(DEFAULT_QUALITY);
    expect(logs).toEqual(["settings: version 1 file: quality set to defaults"]);
  });

  it("round-trips a full quality block and persists it as version 2", async () => {
    const first = store();
    await first.setQuality({ videoQuality: "high", resolutionCap: "1080p" });
    await first.setQuality({ frameRate: 60, audioQuality: "standard" });
    expect(first.quality).toEqual(custom);
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({ version: 2, outputDir: DEFAULT, quality: custom });
    const second = store();
    expect(second.quality).toEqual(custom);
    expect(second.outputDir).toBe(DEFAULT);
  });

  it("setOutputDir keeps the quality and setQuality keeps the outputDir", async () => {
    const s = store();
    await s.setQuality({ videoQuality: "economy" });
    await s.setOutputDir("/elsewhere");
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({
      version: 2,
      outputDir: "/elsewhere",
      quality: { ...DEFAULT_QUALITY, videoQuality: "economy" },
    });
  });

  it("an invalid quality block falls back to defaults but keeps the outputDir", async () => {
    await fs.writeFile(filePath, JSON.stringify({ version: 2, outputDir: "/kept", quality: { ...custom, frameRate: 24 } }));
    const s = store();
    expect(s.outputDir).toBe("/kept");
    expect(s.quality).toEqual(DEFAULT_QUALITY);
    expect(logs).toEqual(["settings: quality is missing or has unsupported values: using defaults"]);
    await fs.writeFile(filePath, JSON.stringify({ version: 2, outputDir: "/kept" }));
    expect(store().quality).toEqual(DEFAULT_QUALITY);
  });

  it("rejects an unsupported value without touching the file or the current choice", async () => {
    const s = store();
    await s.setQuality({ videoQuality: "high" });
    await expect(s.setQuality({ frameRate: 24 as unknown as 30 })).rejects.toThrow(/unsupported quality/);
    expect(s.quality).toEqual({ ...DEFAULT_QUALITY, videoQuality: "high" });
    expect(JSON.parse(await fs.readFile(filePath, "utf8")).quality).toEqual({ ...DEFAULT_QUALITY, videoQuality: "high" });
  });

  it("a failed write keeps the previous choice", async () => {
    const s = store();
    await s.setQuality({ videoQuality: "high" });
    // Make the settings path a directory so the rename cannot succeed.
    await fs.rm(filePath);
    await fs.mkdir(filePath);
    await expect(s.setQuality({ videoQuality: "economy" })).rejects.toThrow();
    expect(s.quality).toEqual({ ...DEFAULT_QUALITY, videoQuality: "high" });
  });

  it("overlapping saves are serialized and none of the fields is lost (review F2)", async () => {
    const s = store();
    await Promise.all([
      s.setQuality({ videoQuality: "high" }),
      s.setQuality({ audioQuality: "standard" }),
      s.setOutputDir("/picked"),
      s.setQuality({ frameRate: 60 }),
    ]);
    const expected = { ...DEFAULT_QUALITY, videoQuality: "high", audioQuality: "standard", frameRate: 60 };
    expect(s.quality).toEqual(expected);
    expect(s.outputDir).toBe("/picked");
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({ version: 2, outputDir: "/picked", quality: expected });
    await expect(fs.stat(`${filePath}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a failed save does not block later saves", async () => {
    const s = store();
    await fs.mkdir(filePath);
    await expect(s.setQuality({ videoQuality: "economy" })).rejects.toThrow();
    await fs.rmdir(filePath);
    await s.setQuality({ videoQuality: "high" });
    expect(JSON.parse(await fs.readFile(filePath, "utf8")).quality.videoQuality).toBe("high");
  });

  it("ignores unknown extra keys inside quality", () => {
    const parsed = parseSettings(JSON.stringify({ version: 2, outputDir: "/a", quality: { ...custom, extra: 1 } }));
    expect(parsed?.settings.quality).toEqual(custom);
    expect(parsed?.warnings).toEqual([]);
  });
});

describe("parseSettings", () => {
  it("accepts version 1 and 2 with an absolute string outputDir", () => {
    expect(parseSettings('{"version":1,"outputDir":"/a"}')?.settings).toEqual({
      version: 2,
      outputDir: "/a",
      quality: DEFAULT_QUALITY,
    });
    expect(parseSettings('{"version":2,"outputDir":"/a","quality":' + JSON.stringify(DEFAULT_QUALITY) + "}")).toEqual({
      settings: { version: 2, outputDir: "/a", quality: DEFAULT_QUALITY },
      warnings: [],
    });
    expect(parseSettings('{"version":1,"outputDir":""}')).toBeUndefined();
    expect(parseSettings("null")).toBeUndefined();
    expect(parseSettings("[]")).toBeUndefined();
  });
});
