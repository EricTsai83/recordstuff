import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_HOTKEY } from "../shared/hotkey";
import { DEFAULT_QUALITY } from "../shared/quality";
import { KEPT_UNUSABLE_NAMES, SettingsStore, parseSettings, defaultSettings } from "./settings";

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

  it("keeps an unusable file aside instead of replacing it with defaults", async () => {
    const newer = JSON.stringify({ version: 4, outputDir: "/somewhere", future: true });
    await fs.writeFile(filePath, newer);
    const first = store();
    // An automatic write, like the launch update check's attempt stamp.
    await first.setUpdates({ lastAttempt: 1 });
    expect(await fs.readFile(`${filePath}.unreadable`, "utf8")).toBe(newer);
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toMatchObject({ version: 3, outputDir: DEFAULT });
    expect(logs).toContainEqual(expect.stringContaining("kept the unusable file"));
    // Only the first write moves it; a later one keeps the file it wrote.
    await first.setNotifications(false);
    expect(await fs.readFile(`${filePath}.unreadable`, "utf8")).toBe(newer);
  });

  it("does not move a missing or valid file aside", async () => {
    await store().setNotifications(false);
    await store().setNotifications(true);
    await expect(fs.access(`${filePath}.unreadable`)).rejects.toThrow();
  });

  it("never replaces a copy an earlier unusable load kept", async () => {
    await fs.writeFile(`${filePath}.unreadable`, "first");
    await fs.mkdir(`${filePath}.unreadable.1`);
    await fs.writeFile(filePath, "second");
    await store().setNotifications(false);
    expect(await fs.readFile(`${filePath}.unreadable`, "utf8")).toBe("first");
    expect(await fs.readFile(`${filePath}.unreadable.2`, "utf8")).toBe("second");
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toMatchObject({ version: 3, notifications: false });
  });

  it("gives up keeping the unusable file once every name is taken, rejecting the save and keeping the file", async () => {
    for (let index = 0; index < KEPT_UNUSABLE_NAMES; index++) await fs.writeFile(`${filePath}.unreadable${index ? `.${index}` : ""}`, "older");
    await fs.writeFile(filePath, "{ not json");
    const first = store();
    await expect(first.setNotifications(false)).rejects.toThrow(/is taken/);
    expect(await fs.readFile(filePath, "utf8")).toBe("{ not json");
    await expect(fs.access(`${filePath}.unreadable.${KEPT_UNUSABLE_NAMES}`)).rejects.toThrow();
  });

  // chmod cannot make a directory unwritable to its owner on Windows.
  it.skipIf(process.platform === "win32")("rejects the save and keeps the unusable file when it cannot be kept", async () => {
    await fs.writeFile(filePath, "{ not json");
    const first = store();
    await fs.chmod(dir, 0o500);
    try {
      await expect(first.setNotifications(false)).rejects.toThrow();
    } finally {
      await fs.chmod(dir, 0o700);
    }
    expect(await fs.readFile(filePath, "utf8")).toBe("{ not json");
    await expect(fs.access(`${filePath}.unreadable`)).rejects.toThrow();
    expect(first.notifications).toBe(true);
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
      language: "en", appearance: "system",
      outputDir: "/Volumes/External/Recordings",
      quality: DEFAULT_QUALITY,
      hotkey: DEFAULT_HOTKEY,
      updates: { enabled: true, lastAttempt: 0 },
      notifications: true,
      display: { kind: "primary" },
      countdown: 3, countdownSound: true, trayClick: "menu", fileNameTemplate: "{date} {time}", libraryLayout: "grid",
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

  it("rejects unsupported notification and update values without touching the file", async () => {
    const s = store();
    await expect(s.setNotifications("yes" as unknown as boolean)).rejects.toThrow(/notifications/);
    await expect(s.setUpdates({ enabled: 1 as unknown as boolean })).rejects.toThrow(/updates/);
    await expect(s.setUpdates({ lastAttempt: -5 })).rejects.toThrow(/updates/);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(s.notifications).toBe(true);
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
      language: "en", appearance: "system",
      version: 3,
      outputDir: DEFAULT,
      quality: custom,
      hotkey: DEFAULT_HOTKEY,
      updates: { enabled: true, lastAttempt: 0 },
      notifications: true,
      display: { kind: "primary" },
      countdown: 3, countdownSound: true, trayClick: "menu", fileNameTemplate: "{date} {time}", libraryLayout: "grid",
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
      language: "en", appearance: "system",
      outputDir: "/elsewhere",
      quality: { ...DEFAULT_QUALITY, videoQuality: "economy" },
      hotkey: DEFAULT_HOTKEY,
      updates: { enabled: true, lastAttempt: 0 },
      notifications: true,
      display: { kind: "primary" },
      countdown: 3, countdownSound: true, trayClick: "menu", fileNameTemplate: "{date} {time}", libraryLayout: "grid",
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
      language: "en", appearance: "system",
      version: 3,
      outputDir: "/picked",
      quality: expected,
      hotkey: DEFAULT_HOTKEY,
      updates: { enabled: true, lastAttempt: 0 },
      notifications: true,
      display: { kind: "primary" },
      countdown: 3, countdownSound: true, trayClick: "menu", fileNameTemplate: "{date} {time}", libraryLayout: "grid",
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
      language: "en", appearance: "system",
      outputDir: "/a",
      quality: DEFAULT_QUALITY,
      hotkey: DEFAULT_HOTKEY,
      updates: { enabled: true, lastAttempt: 0 },
      notifications: true,
      display: { kind: "primary" },
      countdown: 3, countdownSound: true, trayClick: "record", fileNameTemplate: "{date} {time}", libraryLayout: "grid",
    });
    expect(parseSettings('{"version":2,"outputDir":"/a","quality":' + JSON.stringify(DEFAULT_QUALITY) + "}")).toEqual({
      settings: { language: "en", appearance: "system", version: 3, outputDir: "/a", quality: DEFAULT_QUALITY, hotkey: DEFAULT_HOTKEY, updates: { enabled: true, lastAttempt: 0 }, notifications: true, display: { kind: "primary" }, countdown: 3, countdownSound: true, trayClick: "record", fileNameTemplate: "{date} {time}", libraryLayout: "grid" },
      warnings: ["version 2 file: shortcut set to default"],
    });
    const v3 = { version: 3, outputDir: "/a", quality: DEFAULT_QUALITY, hotkey: DEFAULT_HOTKEY };
    expect(parseSettings(JSON.stringify(v3))).toEqual({ settings: { ...v3, language: "en", appearance: "system", updates: { enabled: true, lastAttempt: 0 }, notifications: true, display: { kind: "primary" }, countdown: 3, countdownSound: true, trayClick: "record", fileNameTemplate: "{date} {time}", libraryLayout: "grid" }, warnings: [] });
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
      language: "en", appearance: "system",
      outputDir: DEFAULT,
      quality: DEFAULT_QUALITY,
      hotkey: custom,
      updates: { enabled: true, lastAttempt: 0 },
      notifications: true,
      display: { kind: "primary" },
      countdown: 3, countdownSound: true, trayClick: "menu", fileNameTemplate: "{date} {time}", libraryLayout: "grid",
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
    // A hand-edited Command+W would take every app's close key; it is not registered.
    await fs.writeFile(filePath, JSON.stringify({ version: 3, outputDir: "/kept", quality: DEFAULT_QUALITY, hotkey: { enabled: true, accelerator: "CommandOrControl+W" } }));
    expect(store().hotkey).toEqual(DEFAULT_HOTKEY);
    await fs.writeFile(filePath, JSON.stringify({ version: 3, outputDir: "/kept", quality: DEFAULT_QUALITY }));
    expect(store().hotkey).toEqual(DEFAULT_HOTKEY);
  });

  it("validates a saved or chosen shortcut against the platform's reserved combinations (plan 064)", async () => {
    const file = (accelerator: string) => JSON.stringify({ version: 3, outputDir: "/kept", quality: DEFAULT_QUALITY, hotkey: { enabled: true, accelerator } });
    expect(parseSettings(file("CommandOrControl+Space"), "darwin")?.settings.hotkey).toEqual(DEFAULT_HOTKEY);
    expect(parseSettings(file("CommandOrControl+Space"), "win32")?.settings.hotkey).toEqual({ enabled: true, accelerator: "CommandOrControl+Space" });
    expect(parseSettings(file("Control+Q"), "darwin")?.settings.hotkey).toEqual({ enabled: true, accelerator: "Control+Q" });
    expect(parseSettings(file("Control+Q"), "win32")?.settings.hotkey).toEqual(DEFAULT_HOTKEY);
    const windows = new SettingsStore({ filePath, defaultOutputDir: DEFAULT, platform: "win32" });
    await expect(windows.setHotkey({ enabled: true, accelerator: "Control+W" })).rejects.toThrow(/unsupported shortcut/);
    await windows.setHotkey({ enabled: true, accelerator: "Shift+CommandOrControl+3" });
    expect(new SettingsStore({ filePath, defaultOutputDir: DEFAULT, platform: "win32" }).hotkey).toEqual({ enabled: true, accelerator: "CommandOrControl+Shift+3" });
    expect(new SettingsStore({ filePath, defaultOutputDir: DEFAULT, platform: "darwin" }).hotkey).toEqual(DEFAULT_HOTKEY);
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
  it("keeps the announced version beside the other update fields and refuses one that was never published", async () => {
    const s = store();
    await s.setUpdates({ lastAttempt: 9 }); await s.setUpdates({ notifiedVersion: "1.2.0" });
    expect(store().updates).toEqual({ enabled: true, lastAttempt: 9, notifiedVersion: "1.2.0" });
    await s.setUpdates({ lastAttempt: 10 });
    expect(store().updates).toEqual({ enabled: true, lastAttempt: 10, notifiedVersion: "1.2.0" });
    for (const notifiedVersion of ["1.3.0-rc.1", "v1.3.0", "", 3 as unknown as string]) {
      await expect(s.setUpdates({ notifiedVersion })).rejects.toThrow(/updates/);
    }
    expect(store().updates.notifiedVersion).toBe("1.2.0");
  });
  it("defaults malformed timestamps and flags", () => {
    expect(parseSettings(JSON.stringify({ version: 1, outputDir: "/a", updates: { enabled: "no", lastAttempt: -1 } }))?.settings.updates).toEqual({ enabled: true, lastAttempt: 0 });
    expect(parseSettings(JSON.stringify({ version: 1, outputDir: "/a", updates: { enabled: false, lastAttempt: 5 } }))?.settings.updates).toEqual({ enabled: false, lastAttempt: 5 });
    // The update fields are read from `updates` only, never from the top level.
    expect(parseSettings(JSON.stringify({ version: 1, outputDir: "/a", enabled: false, lastAttempt: 5 }))?.settings.updates).toEqual({ enabled: true, lastAttempt: 0 });
  });
  it("says in the log when a spoiled switch or update record falls back, like every other field", () => {
    const parsed = parseSettings(JSON.stringify({ version: 1, outputDir: "/a", notifications: "no", updates: { enabled: "no", lastAttempt: -1 } }));
    expect(parsed?.settings).toMatchObject({ notifications: true, updates: { enabled: true, lastAttempt: 0 } });
    expect(parsed?.warnings).toEqual(expect.arrayContaining([
      "notifications is not a boolean: using on", "updates.enabled is not a boolean: using on", "updates.lastAttempt is invalid: using 0"]));
    expect(parseSettings(JSON.stringify({ version: 1, outputDir: "/a", updates: "off" }))?.warnings).toContain("updates is not an object: using defaults");
    const told = parseSettings(JSON.stringify({ version: 1, outputDir: "/a", updates: { enabled: true, lastAttempt: 5, notifiedVersion: "1.2.0-rc.1" } }));
    expect(told?.settings.updates).toEqual({ enabled: true, lastAttempt: 5 });
    expect(told?.warnings).toContain("updates.notifiedVersion is invalid: announcing the next newer version");
    // A file from before these fields existed is not spoiled: it takes the defaults silently.
    expect(parseSettings(JSON.stringify({ version: 3, outputDir: "/a", quality: DEFAULT_QUALITY, hotkey: DEFAULT_HOTKEY }))?.warnings).toEqual([]);
  });
});

it("round-trips a canonical custom shortcut and remembers it while Off", async () => {
  const s = store();
  await s.setHotkey({ enabled: true, accelerator: "Shift+Control+F12" });
  expect(store().hotkey).toEqual({ enabled: true, accelerator: "Control+Shift+F12" });
  await s.setHotkey({ ...s.hotkey, enabled: false });
  expect(store().hotkey).toEqual({ enabled: false, accelerator: "Control+Shift+F12" });
});

describe("display preference storage", () => {
  it("round-trips exact and primary selections and preserves them through unrelated saves", async () => {
    const settings = store();
    const display = { kind: "display", id: "999", label: "" } as const;
    await settings.setDisplay(display); await settings.setNotifications(false);
    expect(store().display).toEqual(display);
    await settings.setDisplay({ kind: "primary" }); expect(store().display).toEqual({ kind: "primary" });
  });
  it.each([1, 2, 3])("defaults missing display in version %s", (version) => {
    expect(parseSettings(JSON.stringify({ version, outputDir: DEFAULT }))?.settings.display).toEqual({ kind: "primary" });
  });
  it("warns about invalid data and rejects invalid saves", async () => {
    const result = parseSettings(JSON.stringify({ version: 3, outputDir: DEFAULT, display: { kind: "display", id: "-1", label: "bad" } }));
    expect(result?.settings.display).toEqual({ kind: "primary" });
    expect(result?.warnings).toContain("display is invalid: using primary display");
    const settings = store(); await expect(settings.setDisplay({ kind: "display", id: "", label: "" })).rejects.toThrow();
    expect(settings.display).toEqual({ kind: "primary" });
  });
});


describe("appearance", () => {
  it("defaults old files to system and persists each explicit choice", async () => {
    expect(store().appearance).toBe("system");
    expect(parseSettings('{"version":1,"outputDir":"/a"}')?.settings.appearance).toBe("system");
    for (const appearance of ["dark", "light", "system"] as const) {
      await store().setAppearance(appearance);
      expect(store().appearance).toBe(appearance);
    }
  });
  it("rejects invalid changes and preserves the committed appearance on failed writes", async () => {
    const s = store();
    await s.setAppearance("dark");
    await expect(s.setAppearance("invalid" as "light")).rejects.toThrow();
    await fs.mkdir(`${filePath}.tmp`);
    await expect(s.setAppearance("light")).rejects.toThrow();
    expect(s.appearance).toBe("dark");
    expect(store().appearance).toBe("dark");
    expect(parseSettings('{"version":1,"outputDir":"/a","appearance":"invalid"}')?.settings.appearance).toBe("system");
  });
});

describe("countdown (plan 040)", () => {
  const v3 = { version: 3, outputDir: "/a", quality: DEFAULT_QUALITY, hotkey: DEFAULT_HOTKEY };

  it("reads a file written before the field existed as 3 seconds, silently and without a version bump", async () => {
    expect(parseSettings(JSON.stringify(v3))).toMatchObject({ settings: { countdown: 3, version: 3 }, warnings: [] });
    await fs.writeFile(filePath, JSON.stringify(v3));
    expect(store().countdown).toBe(3);
    expect(logs).toEqual([]);
    expect(store().countdown).toBe(3);
    expect(new SettingsStore({ filePath: path.join(dir, "missing.json"), defaultOutputDir: DEFAULT }).countdown).toBe(3);
  });

  it.each([0, 3, 5, 10])("keeps a stored %i", (countdown) => {
    expect(parseSettings(JSON.stringify({ ...v3, countdown }))).toMatchObject({ settings: { countdown }, warnings: [] });
  });

  it.each([4, "3", null, -1, 3.5])("reads an unsupported %j as 3 with a warning and keeps the other fields", async (countdown) => {
    const parsed = parseSettings(JSON.stringify({ ...v3, countdown }));
    expect(parsed).toMatchObject({ settings: { countdown: 3, outputDir: "/a" }, warnings: ["countdown is unsupported: using 3 seconds"] });
  });

  it("saves a choice atomically with the other fields, and refuses an unsupported one", async () => {
    const first = store();
    await first.setCountdown(10);
    expect(first.countdown).toBe(10);
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toMatchObject({ version: 3, outputDir: DEFAULT, countdown: 10 });
    expect(store().countdown).toBe(10);
    await first.setCountdown(0);
    expect(store().countdown).toBe(0);
    await expect(first.setCountdown(4 as never)).rejects.toThrow("unsupported countdown");
    expect(store().countdown).toBe(0);
  });
});

describe("countdown sound (plan 046)", () => {
  const v3 = { version: 3, outputDir: "/a", quality: DEFAULT_QUALITY, hotkey: DEFAULT_HOTKEY };

  it("reads a file written before the field existed as on, the maintainer's default, silently and without a version bump", async () => {
    expect(parseSettings(JSON.stringify(v3))).toMatchObject({ settings: { countdownSound: true, version: 3 }, warnings: [] });
    await fs.writeFile(filePath, JSON.stringify(v3));
    expect(store().countdownSound).toBe(true);
    expect(logs).toEqual([]);
    expect(new SettingsStore({ filePath: path.join(dir, "missing.json"), defaultOutputDir: DEFAULT }).countdownSound).toBe(true);
  });

  it.each([true, false])("keeps a stored %s, also with the countdown Off", (countdownSound) => {
    expect(parseSettings(JSON.stringify({ ...v3, countdown: 0, countdownSound }))).toMatchObject({ settings: { countdown: 0, countdownSound }, warnings: [] });
  });

  it.each(["off", 0, null, 1])("reads a non-boolean %j as on with a warning and keeps the other fields", (countdownSound) => {
    expect(parseSettings(JSON.stringify({ ...v3, countdown: 5, countdownSound }))).toMatchObject({
      settings: { countdownSound: true, countdown: 5, outputDir: "/a" }, warnings: ["countdownSound is not a boolean: using on"],
    });
  });

  it("saves the switch atomically with the other fields, and refuses a non-boolean", async () => {
    const first = store();
    await first.setCountdown(5);
    await first.setCountdownSound(false);
    expect(first.countdownSound).toBe(false);
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toMatchObject({ version: 3, outputDir: DEFAULT, countdown: 5, countdownSound: false });
    expect(store().countdownSound).toBe(false);
    await first.setCountdownSound(true);
    expect(store().countdownSound).toBe(true);
    await expect(first.setCountdownSound("off" as never)).rejects.toThrow("unsupported countdown sound");
    expect(store().countdownSound).toBe(true);
  });
});

it("snapshots queued inputs and returns detached preferences", async () => {
  const settings = store();
  const quality = { ...DEFAULT_QUALITY };
  const pending = settings.setQuality(quality);
  quality.frameRate = 60;
  await pending;
  const read = settings.quality;
  read.frameRate = 60;
  expect(settings.quality).toEqual(DEFAULT_QUALITY);
  const updates = { enabled: false };
  const saving = settings.setUpdates(updates);
  updates.enabled = true;
  await settings.flush();
  await saving;
  expect(store().updates.enabled).toBe(false);
  settings.updates.enabled = true;
  expect(settings.updates.enabled).toBe(false);
});

it("flush includes a save accepted while the earlier write is draining", async () => {
  const settings = store();
  const first = settings.setOutputDir("/first");
  const flushed = settings.flush();
  const second = settings.setOutputDir("/second");
  await flushed;
  expect(store().outputDir).toBe("/second");
  await Promise.all([first, second]);
});

describe("the icon's left click (2026-10-04)", () => {
  it("opens the menu on a new install, keeps the click that records on an upgrade, and round-trips the choice", async () => {
    expect(defaultSettings("/a").trayClick).toBe("menu");
    expect(parseSettings(JSON.stringify({ version: 3, outputDir: "/a", hotkey: DEFAULT_HOTKEY }))?.settings.trayClick).toBe("record");
    expect(parseSettings(JSON.stringify({ version: 3, outputDir: "/a", hotkey: DEFAULT_HOTKEY, trayClick: "menu" }))?.settings.trayClick).toBe("menu");
    expect(parseSettings(JSON.stringify({ version: 3, outputDir: "/a", quality: DEFAULT_QUALITY, hotkey: DEFAULT_HOTKEY, trayClick: "double" })))
      .toMatchObject({ settings: { trayClick: "record" }, warnings: ["trayClick is unsupported: using record"] });
    const s = store();
    expect(s.trayClick).toBe("menu");
    await s.setTrayClick("record");
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toMatchObject({ trayClick: "record" });
    expect(store().trayClick).toBe("record");
    await expect(s.setTrayClick("double" as never)).rejects.toThrow("unsupported tray click");
  });
});

describe("the file name pattern and the Recordings layout (2026-10-05)", () => {
  it("defaults to the names recordings always had and the grid, and refuses a pattern that cannot name a file", async () => {
    expect(defaultSettings("/a")).toMatchObject({ fileNameTemplate: "{date} {time}", libraryLayout: "grid" });
    // A file from before the choice keeps both defaults, silently.
    expect(parseSettings(JSON.stringify({ version: 3, outputDir: "/a", hotkey: DEFAULT_HOTKEY }))).toMatchObject({ settings: { fileNameTemplate: "{date} {time}", libraryLayout: "grid" } });
    expect(parseSettings(JSON.stringify({ version: 3, outputDir: "/a", quality: DEFAULT_QUALITY, hotkey: DEFAULT_HOTKEY, fileNameTemplate: "Meeting {date}", libraryLayout: "shelf" })))
      .toMatchObject({ settings: { fileNameTemplate: "{date} {time}", libraryLayout: "grid" },
        warnings: ["fileNameTemplate is unsupported: using {date} {time}", "libraryLayout is unsupported: using grid"] });
    const s = store();
    await s.setFileNameTemplate("  Demo {date} {time}  ");
    await s.setLibraryLayout("list");
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toMatchObject({ fileNameTemplate: "Demo {date} {time}", libraryLayout: "list" });
    expect([store().fileNameTemplate, store().libraryLayout]).toEqual(["Demo {date} {time}", "list"]);
    await expect(s.setFileNameTemplate("Demo {date}")).rejects.toThrow("unsupported file name template");
    await expect(s.setFileNameTemplate("a/b {time}")).rejects.toThrow("unsupported file name template");
    await expect(s.setLibraryLayout("shelf" as never)).rejects.toThrow("unsupported library layout");
    expect(s.fileNameTemplate).toBe("Demo {date} {time}");
  });
});
