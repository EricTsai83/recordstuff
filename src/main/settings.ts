/**
 * `settings.json` in userData; the only setting is `outputDir` (plans/001-first-version.md §10.1).
 * Writes go to `settings.json.tmp` then rename, so a crash mid-write never
 * leaves a half file. Any read problem falls back to the default and logs.
 */
import fs from "node:fs";
import path from "node:path";

export const SETTINGS_VERSION = 1;

export interface Settings {
  version: typeof SETTINGS_VERSION;
  outputDir: string;
}

export interface SettingsStoreOptions {
  filePath: string;
  defaultOutputDir: string;
  log?: (message: string) => void;
}

export function parseSettings(text: string): Settings | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record["version"] !== SETTINGS_VERSION) return undefined;
  const outputDir = record["outputDir"];
  if (typeof outputDir !== "string" || outputDir.length === 0 || !path.isAbsolute(outputDir)) {
    return undefined;
  }
  return { version: SETTINGS_VERSION, outputDir };
}

export class SettingsStore {
  private settings: Settings;
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

  async setOutputDir(outputDir: string): Promise<void> {
    if (!path.isAbsolute(outputDir)) throw new Error(`outputDir must be absolute: ${outputDir}`);
    const next: Settings = { version: SETTINGS_VERSION, outputDir };
    await this.write(next);
    this.settings = next;
  }

  private load(defaultOutputDir: string): Settings {
    const fallback: Settings = { version: SETTINGS_VERSION, outputDir: defaultOutputDir };
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
    return parsed;
  }

  private async write(settings: Settings): Promise<void> {
    const tmpPath = `${this.filePath}.tmp`;
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.promises.writeFile(tmpPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
    await fs.promises.rename(tmpPath, this.filePath);
  }
}
