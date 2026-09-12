/**
 * `settings.json` in userData: `outputDir` (plans/001-first-version.md §10.1)
 * and the recording `quality` (plans/007-recording-quality-settings.md).
 * Writes go to `settings.json.tmp` then rename, so a crash mid-write never
 * leaves a half file. Any read problem falls back to the default and logs.
 *
 * Version 1 files (outputDir only) are read as-is and get the default
 * quality; they are rewritten as version 2 on the next successful save.
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_QUALITY, isQualitySettings, type QualitySettings } from "../shared/quality";

export const SETTINGS_VERSION = 2;

export interface Settings {
  version: typeof SETTINGS_VERSION;
  outputDir: string;
  quality: QualitySettings;
}

export interface SettingsStoreOptions {
  filePath: string;
  defaultOutputDir: string;
  log?: (message: string) => void;
}

export interface ParsedSettings {
  settings: Settings;
  /** Fields that were missing or invalid and replaced by defaults. */
  warnings: string[];
}

/**
 * `undefined` when the file as a whole is unusable (not an object, unknown
 * version, bad outputDir). A bad `quality` block alone keeps the outputDir
 * and reports a warning: the user's folder choice must survive a broken
 * quality field.
 */
export function parseSettings(text: string): ParsedSettings | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const version = record["version"];
  if (version !== 1 && version !== SETTINGS_VERSION) return undefined;
  const outputDir = record["outputDir"];
  if (typeof outputDir !== "string" || outputDir.length === 0 || !path.isAbsolute(outputDir)) {
    return undefined;
  }
  const warnings: string[] = [];
  let quality: QualitySettings = DEFAULT_QUALITY;
  if (version === 1) {
    warnings.push("version 1 file: quality set to defaults");
  } else if (isQualitySettings(record["quality"])) {
    quality = {
      videoQuality: record["quality"].videoQuality,
      resolutionCap: record["quality"].resolutionCap,
      frameRate: record["quality"].frameRate,
      audioQuality: record["quality"].audioQuality,
    };
  } else {
    warnings.push("quality is missing or has unsupported values: using defaults");
  }
  return { settings: { version: SETTINGS_VERSION, outputDir, quality }, warnings };
}

export class SettingsStore {
  private settings: Settings;
  /** Writes are serialized: each next value is built from the last committed one (review F2). */
  private queue: Promise<void> = Promise.resolve();
  private readonly filePath: string;
  private readonly log: (message: string) => void;

  constructor(options: SettingsStoreOptions) {
    this.filePath = options.filePath;
    this.log = options.log ?? (() => undefined);
    this.settings = this.load(options.defaultOutputDir);
  }

  get outputDir(): string {
    return this.settings.outputDir;
  }

  get quality(): QualitySettings {
    return this.settings.quality;
  }

  setOutputDir(outputDir: string): Promise<void> {
    if (!path.isAbsolute(outputDir)) return Promise.reject(new Error(`outputDir must be absolute: ${outputDir}`));
    return this.save((current) => ({ ...current, outputDir }));
  }

  /** Rejects (and keeps the previous choice) when the value is unsupported or the write fails. */
  setQuality(patch: Partial<QualitySettings>): Promise<void> {
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

  private load(defaultOutputDir: string): Settings {
    const fallback: Settings = { version: SETTINGS_VERSION, outputDir: defaultOutputDir, quality: DEFAULT_QUALITY };
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log(`settings: cannot read ${this.filePath}: ${String(cause)}; using defaults`);
      }
      return fallback;
    }
    const parsed = parseSettings(text);
    if (!parsed) {
      this.log(`settings: ${this.filePath} is invalid or has an unknown version; using defaults`);
      return fallback;
    }
    for (const warning of parsed.warnings) this.log(`settings: ${warning}`);
    return parsed.settings;
  }

  private async write(settings: Settings): Promise<void> {
    const tmpPath = `${this.filePath}.tmp`;
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.promises.writeFile(tmpPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
    await fs.promises.rename(tmpPath, this.filePath);
  }
}
