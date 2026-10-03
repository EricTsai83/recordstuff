/**
 * Persistent preferences: output folder, recording display, quality, countdown,
 * shortcut, notifications, update checks, language and appearance.
 * See docs/system-design/desktop.md for the schema and migration rules.
 * Writes replace the file atomically (`writeFileAtomic`), so a crash or power
 * loss mid-write leaves the previous file. Any read problem falls back to the
 * default and logs; a file that exists but cannot be used (unreadable, broken,
 * or from a newer version) is kept as `settings.json.unreadable` (then `.1`,
 * `.2`… when that name is taken) before the first write, so a later save never
 * replaces the user's choices with defaults.
 *
 * Version 1 files (outputDir only) are read as-is and get the default
 * quality; version 2 files get the default shortcut. Both are rewritten as
 * version 3 on the next successful save. Older files without a language
 * field default to English.
 *
 * `updates`, `notifications`, `countdown` and `countdownSound` are read
 * leniently rather than versioned: a file written before any of them existed
 * keeps working and takes the default, so existing users also get the
 * 3-second countdown and its tick.
 */
import { isAppearance, type Appearance } from "../shared/appearance";
import { DEFAULT_DISPLAY_PREFERENCE, isDisplayPreference, type DisplayPreference } from "../shared/display";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_QUALITY, isQualitySettings, type QualitySettings } from "../shared/quality";
import { DEFAULT_COUNTDOWN, DEFAULT_COUNTDOWN_SOUND, isCountdownSeconds, type CountdownSeconds } from "../shared/countdown";
import { DEFAULT_LANGUAGE, isLanguage, type Language } from "../shared/i18n";
import { DEFAULT_HOTKEY, canonicalizeAccelerator, isHotkeySettings, type HotkeySettings } from "../shared/hotkey";
import { writeFileAtomic } from "./atomic-file";
import { drainQueue } from "./drain-queue";
import { errnoCode } from "./errors";

export const SETTINGS_VERSION = 3;

export interface Settings {
  version: typeof SETTINGS_VERSION;
  outputDir: string;
  quality: QualitySettings;
  language: Language;
  appearance: Appearance;
  hotkey: HotkeySettings;
  updates: { enabled: boolean; lastAttempt: number };
  /** Whether the app sends any notification at all; the OS permission is separate. */
  notifications: boolean;
  display: DisplayPreference;
  /** Seconds before capture begins; 0 is Off (plan 040). */
  countdown: CountdownSeconds;
  /** A tick with each countdown digit (plan 046); kept while the countdown is Off. */
  countdownSound: boolean;
}

export interface SettingsStoreOptions {
  filePath: string;
  defaultOutputDir: string;
  log?: (message: string) => void;
  /** Which combinations a saved shortcut may use; tests pin it. */
  platform?: NodeJS.Platform;
}

export interface ParsedSettings {
  settings: Settings;
  /** Fields that were missing or invalid and replaced by defaults. */
  warnings: string[];
}

/** Every default in one place: a fresh or unreadable file, and each field a file lacks or spoils. */
export function defaultSettings(outputDir: string): Settings {
  return {
    version: SETTINGS_VERSION,
    outputDir,
    quality: DEFAULT_QUALITY,
    language: DEFAULT_LANGUAGE,
    appearance: "system",
    hotkey: DEFAULT_HOTKEY,
    updates: { enabled: true, lastAttempt: 0 },
    notifications: true,
    display: DEFAULT_DISPLAY_PREFERENCE,
    countdown: DEFAULT_COUNTDOWN,
    countdownSound: DEFAULT_COUNTDOWN_SOUND,
  };
}

/**
 * `undefined` when the file as a whole is unusable (not an object, unknown
 * version, bad outputDir). A bad `quality` block alone keeps the outputDir
 * and reports a warning: the user's folder choice must survive a broken
 * quality field.
 */
export function parseSettings(text: string, platform: NodeJS.Platform = process.platform): ParsedSettings | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const version = record["version"];
  if (version !== 1 && version !== 2 && version !== SETTINGS_VERSION) return undefined;
  const outputDir = record["outputDir"];
  if (typeof outputDir !== "string" || outputDir.length === 0 || !path.isAbsolute(outputDir)) {
    return undefined;
  }
  const warnings: string[] = [];
  /** A missing value falls back silently; a present but unsupported one also warns. */
  const field = <T>(key: string, valid: (value: unknown) => value is T, fallback: T, warning: string, source: Record<string, unknown> = record): T => {
    const value = source[key];
    if (valid(value)) return value;
    if (value !== undefined) warnings.push(warning);
    return fallback;
  };
  const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
  let quality: QualitySettings = DEFAULT_QUALITY;
  if (version === 1) {
    warnings.push("version 1 file: quality set to defaults");
  } else if (isQualitySettings(record["quality"])) {
    quality = {
      videoQuality: record["quality"].videoQuality,
      resolutionCap: record["quality"].resolutionCap,
      frameRate: record["quality"].frameRate,
    };
  } else {
    warnings.push("quality is missing or has unsupported values: using defaults");
  }
  const defaults = defaultSettings(outputDir);
  const appearance = field("appearance", isAppearance, defaults.appearance, `appearance is unsupported: using ${defaults.appearance}`);
  const language = field("language", isLanguage, DEFAULT_LANGUAGE, "language is unsupported: using English");
  let hotkey: HotkeySettings = DEFAULT_HOTKEY;
  if (version !== SETTINGS_VERSION) {
    warnings.push(`version ${version} file: shortcut set to default`);
  } else if (isHotkeySettings(record["hotkey"], platform)) {
    hotkey = { enabled: record["hotkey"].enabled, accelerator: canonicalizeAccelerator(record["hotkey"].accelerator, platform)! };
  } else {
    warnings.push("hotkey is missing or has unsupported values: using the default shortcut");
  }
  const rawUpdates = record["updates"];
  const isRecord = typeof rawUpdates === "object" && rawUpdates !== null && !Array.isArray(rawUpdates);
  if (rawUpdates !== undefined && !isRecord) warnings.push("updates is not an object: using defaults");
  const u = isRecord ? rawUpdates as Record<string, unknown> : {};
  const isTimestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const updates = {
    enabled: field("enabled", isBoolean, defaults.updates.enabled, `updates.enabled is not a boolean: using ${defaults.updates.enabled ? "on" : "off"}`, u),
    lastAttempt: field("lastAttempt", isTimestamp, defaults.updates.lastAttempt, `updates.lastAttempt is invalid: using ${defaults.updates.lastAttempt}`, u),
  };
  const notifications = field("notifications", isBoolean, defaults.notifications, `notifications is not a boolean: using ${defaults.notifications ? "on" : "off"}`);
  const display = field("display", isDisplayPreference, DEFAULT_DISPLAY_PREFERENCE, "display is invalid: using primary display");
  const countdown = field("countdown", isCountdownSeconds, DEFAULT_COUNTDOWN, `countdown is unsupported: using ${DEFAULT_COUNTDOWN} seconds`);
  const countdownSound = field("countdownSound", isBoolean, DEFAULT_COUNTDOWN_SOUND, `countdownSound is not a boolean: using ${DEFAULT_COUNTDOWN_SOUND ? "on" : "off"}`);
  return { settings: { appearance, display, version: SETTINGS_VERSION, outputDir, quality, language, hotkey, updates, notifications, countdown, countdownSound }, warnings };
}

export class SettingsStore {
  private settings: Settings;
  /** Writes are serialized: each next value is built from the last committed one (review F2). */
  private queue: Promise<void> = Promise.resolve();
  private readonly filePath: string;
  private readonly log: (message: string) => void;
  private readonly platform: NodeJS.Platform;
  /** The folder a fresh or unreadable file falls back to; the one folder opening may create (plan 033). */
  readonly defaultOutputDir: string;
  /** The file on disk exists but could not be used; the first write moves it aside instead of replacing it. */
  private unusableOnDisk = false;

  constructor(options: SettingsStoreOptions) {
    this.filePath = options.filePath;
    this.log = options.log ?? (() => undefined);
    this.platform = options.platform ?? process.platform;
    this.defaultOutputDir = options.defaultOutputDir;
    this.settings = this.load(options.defaultOutputDir);
  }

  get display(): DisplayPreference { return { ...this.settings.display }; }

  setDisplay(display: DisplayPreference): Promise<void> {
    if (!isDisplayPreference(display)) return Promise.reject(new Error("invalid display preference"));
    const snapshot = { ...display };
    return this.save((current) => ({ ...current, display: snapshot }));
  }

  get outputDir(): string {
    return this.settings.outputDir;
  }

  get quality(): QualitySettings {
    return { ...this.settings.quality };
  }

  get countdown(): CountdownSeconds { return this.settings.countdown; }

  setCountdown(countdown: CountdownSeconds): Promise<void> {
    if (!isCountdownSeconds(countdown)) return Promise.reject(new Error(`unsupported countdown: ${JSON.stringify(countdown)}`));
    return this.save((current) => ({ ...current, countdown }));
  }

  get countdownSound(): boolean { return this.settings.countdownSound; }

  setCountdownSound(enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") return Promise.reject(new Error(`unsupported countdown sound: ${JSON.stringify(enabled)}`));
    return this.save((current) => ({ ...current, countdownSound: enabled }));
  }

  get appearance(): Appearance { return this.settings.appearance; }

  setAppearance(appearance: Appearance): Promise<void> {
    if (!isAppearance(appearance)) return Promise.reject(new Error("unsupported appearance"));
    return this.save(current => ({ ...current, appearance }));
  }

  get language(): Language {
    return this.settings.language;
  }

  get updates(): Settings["updates"] { return { ...this.settings.updates }; }

  setUpdates(patch: Partial<Settings["updates"]>): Promise<void> {
    patch = { ...patch };
    if ((patch.enabled !== undefined && typeof patch.enabled !== "boolean") ||
        (patch.lastAttempt !== undefined && !(Number.isFinite(patch.lastAttempt) && patch.lastAttempt >= 0))) {
      return Promise.reject(new Error(`unsupported updates setting: ${JSON.stringify(patch)}`));
    }
    return this.save((current) => ({ ...current, updates: { ...current.updates, ...patch } }));
  }

  get notifications(): boolean { return this.settings.notifications; }

  setNotifications(enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") return Promise.reject(new Error(`unsupported notifications setting: ${JSON.stringify(enabled)}`));
    return this.save((current) => ({ ...current, notifications: enabled }));
  }

  get hotkey(): HotkeySettings {
    return { ...this.settings.hotkey };
  }

  /** Rejects (and keeps the previous choice) when the accelerator is not a valid shortcut or the write fails. */
  setHotkey(hotkey: HotkeySettings): Promise<void> {
    hotkey = { ...hotkey };
    if (!isHotkeySettings(hotkey, this.platform)) return Promise.reject(new Error(`unsupported shortcut: ${JSON.stringify(hotkey)}`));
    return this.save((current) => ({ ...current, hotkey: { enabled: hotkey.enabled, accelerator: canonicalizeAccelerator(hotkey.accelerator, this.platform)! } }));
  }

  setLanguage(language: Language): Promise<void> {
    if (!isLanguage(language)) return Promise.reject(new Error("unsupported language"));
    return this.save((current) => ({ ...current, language }));
  }

  setOutputDir(outputDir: string): Promise<void> {
    if (!path.isAbsolute(outputDir)) return Promise.reject(new Error(`outputDir must be absolute: ${outputDir}`));
    return this.save((current) => ({ ...current, outputDir }));
  }

  /** Rejects (and keeps the previous choice) when the value is unsupported or the write fails. */
  setQuality(patch: Partial<QualitySettings>): Promise<void> {
    patch = { ...patch };
    const quality = { ...this.settings.quality, ...patch };
    if (!isQualitySettings(quality)) {
      return Promise.reject(new Error(`unsupported quality setting: ${JSON.stringify(patch)}`));
    }
    return this.save((current) => ({ ...current, quality: { ...current.quality, ...patch } }));
  }

  /**
   * Overlapping saves (two quick menu clicks, or a folder pick during a
   * quality write) would otherwise both derive from the same stale value and
   * race on the same `.tmp` path. A failed save rejects its own caller only;
   * later saves still run from the last committed settings.
   */
  private save(update: (current: Settings) => Settings): Promise<void> {
    const run = this.queue.then(async () => {
      const next = update(this.settings);
      await this.write(next);
      this.settings = next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Wait for every previously accepted save before quitting. */
  async flush(): Promise<void> {
    await drainQueue(() => this.queue);
  }

  private load(defaultOutputDir: string): Settings {
    const fallback = defaultSettings(defaultOutputDir);
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, "utf8");
    } catch (cause) {
      if (errnoCode(cause) !== "ENOENT") {
        this.log(`settings: cannot read ${this.filePath}: ${String(cause)}; using defaults`);
        this.unusableOnDisk = true;
      }
      return fallback;
    }
    const parsed = parseSettings(text, this.platform);
    if (!parsed) {
      this.log(`settings: ${this.filePath} is invalid or has an unknown version; using defaults`);
      this.unusableOnDisk = true;
      return fallback;
    }
    for (const warning of parsed.warnings) this.log(`settings: ${warning}`);
    return parsed.settings;
  }

  /**
   * The first write after an unusable load happens without the user asking
   * (the launch update check stamps its attempt), so it keeps the old file
   * first. A failed keep rejects the save and leaves the file in place.
   */
  private async write(settings: Settings): Promise<void> {
    if (this.unusableOnDisk) {
      await this.keepUnusable();
      this.unusableOnDisk = false;
    }
    await writeFileAtomic(this.filePath, JSON.stringify(settings, null, 2) + "\n");
  }

  /**
   * Links the unusable file under the first free `.unreadable` name. Unlike
   * `rename`, `link` never replaces an existing name, so a copy kept by an
   * earlier launch survives a second unusable load; the atomic write then
   * replaces only the original name.
   */
  private async keepUnusable(): Promise<void> {
    for (let index = 0; ; index++) {
      const kept = `${this.filePath}.unreadable${index ? `.${index}` : ""}`;
      try {
        await fs.promises.link(this.filePath, kept);
        this.log(`settings: kept the unusable file as ${kept}`);
        return;
      } catch (cause) {
        const code = errnoCode(cause);
        if (code === "ENOENT") return;
        if (code !== "EEXIST") throw cause;
      }
    }
  }
}
