import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_HOTKEY } from "../shared/hotkey";
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
    await fs.writeFile(filePath, JSON.stringify({ version: 4, outputDir: "/somewhere" }));
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
      version: 3,
      language: "en",
      outputDir: "/Volumes/External/Recordings",
      quality: DEFAULT_QUALITY,
      hotkey: DEFAULT_HOTKEY,
      updates: { enabled: true, lastAttempt: 0 },
      notifications: true,
    });
    expect(store().outputDir).toBe("/Volumes/External/Recordings");
    await expect(fs.stat(`${filePath}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("defaults notifications to on for a file written before the field existed", async () => {
    await fs.writeFile(filePath, JSON.stringify({ version: 3, outputDir: "/a", quality: DEFAULT_QUALITY, hotkey: DEFAULT_HOTKEY }));
    expect(store().notifications).toBe(true);
    // A missing switch is not a broken file: nothing to warn about.
    expect(logs).toEqual([]);
  });

  it("round-trips the notification switch and ignores a non-boolean value", async () => {
    const first = store();
    await first.setNotifications(false);
    expect(first.notifications).toBe(false);
    expect(JSON.parse(await fs.readFile(filePath, "utf8")).notifications).toBe(false);
    expect(store().notifications).toBe(false);
    await fs.writeFile(filePath, JSON.stringify({ version: 3, outputDir: "/a", quality: DEFAULT_QUALITY, hotkey: DEFAULT_HOTKEY, notifications: "off" }));
    expect(store().notifications).toBe(true);
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

describe("quality settings", () => {
  const custom = { videoQuality: "high", resolutionCap: "1080p", frameRate: 60 } as const;

  it("a version 1 file keeps its outputDir, gets the default quality and logs the upgrade", async () => {
    await fs.writeFile(filePath, JSON.stringify({ version: 1, outputDir: "/old" }));
    const s = store();
    expect(s.outputDir).toBe("/old");
    expect(s.quality).toEqual(DEFAULT_QUALITY);
    expect(logs).toEqual([
      "settings: version 1 file: quality set to defaults",
      "settings: version 1 file: shortcut set to default",
    ]);
  });

  it("round-trips a full quality block and persists it as version 2", async () => {
    const first = store();
    await first.setQuality({ videoQuality: "high", resolutionCap: "1080p" });
    await first.setQuality({ frameRate: 60 });
    expect(first.quality).toEqual(custom);
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({
      language: "en",
      version: 3,
      outputDir: DEFAULT,
      quality: custom,
      hotkey: DEFAULT_HOTKEY,
      updates: { enabled: true, lastAttempt: 0 },
      notifications: true,
    });
    const second = store();
    expect(second.quality).toEqual(custom);
    expect(second.outputDir).toBe(DEFAULT);
  });

  it("setOutputDir keeps the quality and setQuality keeps the outputDir", async () => {
    const s = store();
    await s.setQuality({ videoQuality: "economy" });
    await s.setOutputDir("/elsewhere");
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({
      version: 3,
      language: "en",
      outputDir: "/elsewhere",
      quality: { ...DEFAULT_QUALITY, videoQuality: "economy" },
      hotkey: DEFAULT_HOTKEY,
      updates: { enabled: true, lastAttempt: 0 },
      notifications: true,
    });
  });

  it("an invalid quality block falls back to defaults but keeps the outputDir", async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({ version: 3, outputDir: "/kept", quality: { ...custom, frameRate: 24 }, hotkey: DEFAULT_HOTKEY }),
    );
    const s = store();
    expect(s.outputDir).toBe("/kept");
    expect(s.quality).toEqual(DEFAULT_QUALITY);
    expect(logs).toEqual(["settings: quality is missing or has unsupported values: using defaults"]);
    await fs.writeFile(filePath, JSON.stringify({ version: 3, outputDir: "/kept", hotkey: DEFAULT_HOTKEY }));
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
      s.setOutputDir("/picked"),
      s.setQuality({ frameRate: 60 }),
    ]);
    const expected = { ...DEFAULT_QUALITY, videoQuality: "high", frameRate: 60 };
    expect(s.quality).toEqual(expected);
    expect(s.outputDir).toBe("/picked");
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({
      language: "en",
      version: 3,
      outputDir: "/picked",
      quality: expected,
      hotkey: DEFAULT_HOTKEY,
      updates: { enabled: true, lastAttempt: 0 },
      notifications: true,
    });
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
    const parsed = parseSettings(
      JSON.stringify({ version: 3, outputDir: "/a", quality: { ...custom, extra: 1 }, hotkey: DEFAULT_HOTKEY }),
    );
    expect(parsed?.settings.quality).toEqual(custom);
    expect(parsed?.warnings).toEqual([]);
  });
});

describe("parseSettings", () => {
  it("accepts versions 1 to 3 with an absolute string outputDir", () => {
    expect(parseSettings('{"version":1,"outputDir":"/a"}')?.settings).toEqual({
      version: 3,
      language: "en",
      outputDir: "/a",
      quality: DEFAULT_QUALITY,
      hotkey: DEFAULT_HOTKEY,
      updates: { enabled: true, lastAttempt: 0 },
      notifications: true,
    });
    expect(parseSettings('{"version":2,"outputDir":"/a","quality":' + JSON.stringify(DEFAULT_QUALITY) + "}")).toEqual({
      settings: { language: "en", version: 3, outputDir: "/a", quality: DEFAULT_QUALITY, hotkey: DEFAULT_HOTKEY, updates: { enabled: true, lastAttempt: 0 }, notifications: true },
      warnings: ["version 2 file: shortcut set to default"],
    });
    const v3 = { version: 3, outputDir: "/a", quality: DEFAULT_QUALITY, hotkey: DEFAULT_HOTKEY };
    expect(parseSettings(JSON.stringify(v3))).toEqual({ settings: { ...v3, language: "en", updates: { enabled: true, lastAttempt: 0 }, notifications: true }, warnings: [] });
    expect(parseSettings('{"version":1,"outputDir":""}')).toBeUndefined();
    expect(parseSettings("null")).toBeUndefined();
    expect(parseSettings("[]")).toBeUndefined();
  });
});

describe("language settings", () => {
  it("defaults existing v1/v2 files to English without losing their folder or quality", async () => {
    for (const version of [1, 2]) {
      await fs.writeFile(filePath, JSON.stringify({ version, outputDir: "/kept", quality: DEFAULT_QUALITY }));
      const s = store();
      expect(s.language).toBe("en");
      expect(s.outputDir).toBe("/kept");
      expect(s.quality).toEqual(DEFAULT_QUALITY);
    }
  });

  it("persists language alongside overlapping quality and folder changes", async () => {
    const s = store();
    await Promise.all([s.setLanguage("zh-TW"), s.setQuality({ videoQuality: "high" }), s.setOutputDir("/new")]);
    const reloaded = store();
    expect(reloaded.language).toBe("zh-TW");
    expect(reloaded.outputDir).toBe("/new");
    expect(reloaded.quality.videoQuality).toBe("high");
    await reloaded.setLanguage("en");
    expect(store().language).toBe("en");
  });

  it("preserves language on failed save, then allows recovery", async () => {
    const s = store();
    await fs.mkdir(filePath);
    await expect(s.setLanguage("zh-TW")).rejects.toThrow();
    expect(s.language).toBe("en");
    await fs.rmdir(filePath);
    await s.setLanguage("zh-TW");
    expect(store().language).toBe("zh-TW");
  });

  it("defaults corrupt language independently and rejects invalid mutations", async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({ version: 3, outputDir: "/kept", quality: DEFAULT_QUALITY, language: "fr", hotkey: DEFAULT_HOTKEY }),
    );
    const s = store();
    expect(s.language).toBe("en");
    expect(s.outputDir).toBe("/kept");
    expect(logs).toContain("settings: language is unsupported: using English");
    await expect(s.setLanguage("fr" as "en")).rejects.toThrow("unsupported language");
    expect(JSON.parse(await fs.readFile(filePath, "utf8")).language).toBe("fr");
  });
});

describe("hotkey settings (plan 016)", () => {
  const custom = { enabled: true, accelerator: "CommandOrControl+Shift+R" } as const;

  it("v1 and v2 files get the default shortcut and keep folder, quality and language", async () => {
    for (const version of [1, 2]) {
      logs.length = 0;
      await fs.writeFile(
        filePath,
        JSON.stringify({ version, outputDir: "/kept", quality: { ...DEFAULT_QUALITY, videoQuality: "high" }, language: "zh-TW" }),
      );
      const s = store();
      expect(s.hotkey).toEqual(DEFAULT_HOTKEY);
      expect(s.outputDir).toBe("/kept");
      expect(s.language).toBe("zh-TW");
      if (version === 2) expect(s.quality.videoQuality).toBe("high");
      expect(logs).toContain(`settings: version ${version} file: shortcut set to default`);
    }
  });

  it("round-trips a preset and the disabled state as version 3", async () => {
    const s = store();
    await s.setHotkey(custom);
    expect(s.hotkey).toEqual(custom);
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({
      version: 3,
      language: "en",
      outputDir: DEFAULT,
      quality: DEFAULT_QUALITY,
      hotkey: custom,
      updates: { enabled: true, lastAttempt: 0 },
      notifications: true,
    });
    expect(store().hotkey).toEqual(custom);
    // Disabling remembers the chosen accelerator so re-enabling restores it.
    await s.setHotkey({ ...custom, enabled: false });
    expect(store().hotkey).toEqual({ enabled: false, accelerator: custom.accelerator });
  });

  it("an unknown accelerator or a broken hotkey block falls back to the default and keeps the rest", async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({ version: 3, outputDir: "/kept", quality: DEFAULT_QUALITY, hotkey: { enabled: true, accelerator: "F13" } }),
    );
    const s = store();
    expect(s.hotkey).toEqual(DEFAULT_HOTKEY);
    expect(s.outputDir).toBe("/kept");
    expect(logs).toEqual(["settings: hotkey is missing or has unsupported values: using the default shortcut"]);
    await fs.writeFile(filePath, JSON.stringify({ version: 3, outputDir: "/kept", quality: DEFAULT_QUALITY }));
    expect(store().hotkey).toEqual(DEFAULT_HOTKEY);
  });

  it("rejects a non-preset accelerator without touching the file, and keeps the choice on a failed write", async () => {
    const s = store();
    await s.setHotkey(custom);
    await expect(s.setHotkey({ enabled: true, accelerator: "Command+Q" as typeof custom.accelerator })).rejects.toThrow(
      /unsupported shortcut/,
    );
    expect(JSON.parse(await fs.readFile(filePath, "utf8")).hotkey).toEqual(custom);
    await fs.rm(filePath);
    await fs.mkdir(filePath);
    await expect(s.setHotkey({ ...custom, enabled: false })).rejects.toThrow();
    expect(s.hotkey).toEqual(custom);
  });

  it("persists alongside overlapping saves of other fields", async () => {
    const s = store();
    await Promise.all([s.setHotkey({ ...custom, enabled: false }), s.setLanguage("zh-TW"), s.setOutputDir("/new")]);
    const reloaded = store();
    expect(reloaded.hotkey).toEqual({ ...custom, enabled: false });
    expect(reloaded.language).toBe("zh-TW");
    expect(reloaded.outputDir).toBe("/new");
  });
});


describe("update preferences", () => {
  it("defaults legacy files to enabled without a previous attempt", () => {
    expect(parseSettings('{"version":1,"outputDir":"/a"}')?.settings.updates).toEqual({ enabled: true, lastAttempt: 0 });
  });
  it("serializes concurrent update and language changes and persists across restart", async () => {
    const s = store();
    await Promise.all([s.setUpdates({ enabled: false }), s.setUpdates({ lastAttempt: 123 }), s.setLanguage("zh-TW")]);
    expect(store().updates).toEqual({ enabled: false, lastAttempt: 123 });
    expect(store().language).toBe("zh-TW");
  });
  it("defaults malformed timestamps and flags", () => {
    expect(parseSettings(JSON.stringify({ version: 1, outputDir: "/a", updates: { enabled: "no", lastAttempt: -1 } }))?.settings.updates).toEqual({ enabled: true, lastAttempt: 0 });
  });
});

it("round-trips a canonical custom shortcut and remembers it while Off", async () => {
  const s = store();
  await s.setHotkey({ enabled: true, accelerator: "Shift+Control+F12" });
  expect(store().hotkey).toEqual({ enabled: true, accelerator: "Control+Shift+F12" });
  await s.setHotkey({ ...s.hotkey, enabled: false });
  expect(store().hotkey).toEqual({ enabled: false, accelerator: "Control+Shift+F12" });
});
