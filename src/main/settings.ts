/**
 * Persistent preferences: output folder, recording display, quality, countdown
 * and its tick, shortcut, the menu bar icon's left click, notifications, update
 * checks, language and appearance, the recordings' file name pattern and the Recordings tab's layout.
 * See docs/system-design/desktop.md for the schema and migration rules.
 * Writes replace the file atomically (`writeFileAtomic`), so a crash or power
 * loss mid-write leaves the previous file. Any read problem falls back to the
 * default and logs; a file that exists but cannot be used (unreadable, broken,
 * or from a newer version) is kept as `settings.json.unreadable` (then `.1`,
 * `.2`… when that name is taken) before the first write, so a later save never
 * replaces the user's choices with defaults.
 *
 * Version 1 files (outputDir only) are read as-is and get the default
 * quality; version 1 and 2 files get the default shortcut. Both are rewritten
 * as version 3 on the next successful save.
 *
 * Every other field is read leniently rather than versioned: a file written
 * before it existed, or holding a value this version does not support, keeps
 * working and takes the default (a present but unsupported value also logs a
 * warning). So older files without a language read as English, and existing
 * users also get the 3-second countdown and its tick. `trayClick` is the one
 * exception: a new install opens the menu, while a file from before the choice
 * keeps the click that records, so an existing user's click does not change
 * under them.
 */
import { isAppearance, isLibraryLayout, isTrayClick, type Appearance, type LibraryLayout, type TrayClick } from "../shared/appearance";
import { DEFAULT_FILE_NAME_TEMPLATE, canonicalFileNameTemplate } from "../shared/file-name";
import { DEFAULT_DISPLAY_PREFERENCE, isDisplayPreference, type DisplayPreference } from "../shared/display";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_QUALITY, isQualitySettings, type QualitySettings } from "../shared/quality";
import { DEFAULT_COUNTDOWN, DEFAULT_COUNTDOWN_SOUND, isCountdownSeconds, type CountdownSeconds } from "../shared/countdown";
import { DEFAULT_LANGUAGE, isLanguage, type Language } from "../shared/i18n";
import { DEFAULT_HOTKEY, canonicalHotkeySettings, type HotkeySettings } from "../shared/hotkey";
import { stableVersion } from "../shared/version";
import { writeFileAtomic } from "./atomic-file";
import { drainQueue } from "./drain-queue";
import { errnoCode } from "./errors";

export const SETTINGS_VERSION = 3;
/** Names tried for keeping an unusable file aside: `.unreadable`, then `.unreadable.1` and on. */
export const KEPT_UNUSABLE_NAMES = 100;

/** Only a published stable version can have been announced. */
function isNotifiedVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && stableVersion(value) !== undefined;
}
/** When an update check was last attempted, in epoch milliseconds; read from the file and accepted by `setUpdates` alike. */
function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export interface Settings {
  version: typeof SETTINGS_VERSION;
  outputDir: string;
  quality: QualitySettings;
  language: Language;
  appearance: Appearance;
  hotkey: HotkeySettings;
  /** `notifiedVersion`: the newest version the user was told about, so a launch announces each version once. */
  updates: { enabled: boolean; lastAttempt: number; notifiedVersion?: string };
  /** Whether the app sends any notification at all; the OS permission is separate. */
  notifications: boolean;
  display: DisplayPreference;
  /** Seconds before capture begins; 0 is Off (plan 040). */
  countdown: CountdownSeconds;
  /** A tick with each countdown digit (plan 046); kept while the countdown is Off. */
  countdownSound: boolean;
  /** The icon's left click; a file from before the choice keeps the click that records. */
  trayClick: TrayClick;
  /** How new recordings are named (file-name.ts); the default gives the names every recording had before the choice. */
  fileNameTemplate: string;
  /** The Recordings tab's grid or list. */
  libraryLayout: LibraryLayout;
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
    // A new install opens the menu, as menu bar icons do; recording is one choice away or on the shortcut.
    trayClick: "menu",
    fileNameTemplate: DEFAULT_FILE_NAME_TEMPLATE,
    libraryLayout: "grid",
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
  const storedHotkey = canonicalHotkeySettings(record["hotkey"], platform);
  if (version !== SETTINGS_VERSION) {
    warnings.push(`version ${version} file: shortcut set to default`);
  } else if (storedHotkey) {
    hotkey = storedHotkey;
  } else {
    warnings.push("hotkey is missing or has unsupported values: using the default shortcut");
  }
  const rawUpdates = record["updates"];
  const isRecord = typeof rawUpdates === "object" && rawUpdates !== null && !Array.isArray(rawUpdates);
  if (rawUpdates !== undefined && !isRecord) warnings.push("updates is not an object: using defaults");
  const u = isRecord ? rawUpdates as Record<string, unknown> : {};
  const updates = {
    enabled: field("enabled", isBoolean, defaults.updates.enabled, `updates.enabled is not a boolean: using ${defaults.updates.enabled ? "on" : "off"}`, u),
    lastAttempt: field("lastAttempt", isTimestamp, defaults.updates.lastAttempt, `updates.lastAttempt is invalid: using ${defaults.updates.lastAttempt}`, u),
  };
  const notifiedVersion = field<string | undefined>("notifiedVersion", isNotifiedVersion, undefined, "updates.notifiedVersion is invalid: announcing the next newer version", u);
  const notifications = field("notifications", isBoolean, defaults.notifications, `notifications is not a boolean: using ${defaults.notifications ? "on" : "off"}`);
  const display = field("display", isDisplayPreference, DEFAULT_DISPLAY_PREFERENCE, "display is invalid: using primary display");
  const countdown = field("countdown", isCountdownSeconds, DEFAULT_COUNTDOWN, `countdown is unsupported: using ${DEFAULT_COUNTDOWN} seconds`);
  const countdownSound = field("countdownSound", isBoolean, DEFAULT_COUNTDOWN_SOUND, `countdownSound is not a boolean: using ${DEFAULT_COUNTDOWN_SOUND ? "on" : "off"}`);
  // Everyone who used the app before the choice existed learned a click that records; an upgrade keeps it.
  const trayClick = field("trayClick", isTrayClick, "record", "trayClick is unsupported: using record");
  // Only a pattern stored as it would be saved: trimmed and usable.
  const isTemplate = (value: unknown): value is string => typeof value === "string" && canonicalFileNameTemplate(value) === value;
  const fileNameTemplate = field("fileNameTemplate", isTemplate, defaults.fileNameTemplate, `fileNameTemplate is unsupported: using ${defaults.fileNameTemplate}`);
  const libraryLayout = field("libraryLayout", isLibraryLayout, defaults.libraryLayout, `libraryLayout is unsupported: using ${defaults.libraryLayout}`);
  return { settings: { appearance, display, version: SETTINGS_VERSION, outputDir, quality, language, hotkey,
    updates: notifiedVersion === undefined ? updates : { ...updates, notifiedVersion }, notifications, countdown, countdownSound, trayClick,
    fileNameTemplate, libraryLayout }, warnings };
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

  get trayClick(): TrayClick { return this.settings.trayClick; }

  setTrayClick(trayClick: TrayClick): Promise<void> {
    if (!isTrayClick(trayClick)) return Promise.reject(new Error(`unsupported tray click: ${JSON.stringify(trayClick)}`));
    return this.save((current) => ({ ...current, trayClick }));
  }

  get fileNameTemplate(): string { return this.settings.fileNameTemplate; }

  setFileNameTemplate(template: string): Promise<void> {
    const canonical = canonicalFileNameTemplate(template);
    if (canonical === undefined) return Promise.reject(new Error(`unsupported file name template: ${JSON.stringify(template)}`));
    return this.save((current) => ({ ...current, fileNameTemplate: canonical }));
  }

  get libraryLayout(): LibraryLayout { return this.settings.libraryLayout; }

  setLibraryLayout(libraryLayout: LibraryLayout): Promise<void> {
    if (!isLibraryLayout(libraryLayout)) return Promise.reject(new Error(`unsupported library layout: ${JSON.stringify(libraryLayout)}`));
    return this.save((current) => ({ ...current, libraryLayout }));
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
        (patch.lastAttempt !== undefined && !isTimestamp(patch.lastAttempt)) ||
        (patch.notifiedVersion !== undefined && !isNotifiedVersion(patch.notifiedVersion))) {
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
    const canonical = canonicalHotkeySettings(hotkey, this.platform);
    if (!canonical) return Promise.reject(new Error(`unsupported shortcut: ${JSON.stringify(hotkey)}`));
    return this.save((current) => ({ ...current, hotkey: canonical }));
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
   * replaces only the original name. A volume that answers EEXIST for every name
   * ends the keep as a failure after `KEPT_UNUSABLE_NAMES` names, as FileWriter's
   * publication does, instead of holding the save queue forever.
   */
  private async keepUnusable(): Promise<void> {
    for (let index = 0; index < KEPT_UNUSABLE_NAMES; index++) {
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
    throw new Error(`every name up to ${path.basename(this.filePath)}.unreadable.${KEPT_UNUSABLE_NAMES - 1} is taken`);
  }
}
