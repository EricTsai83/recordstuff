/**
 * What every desktop runner needs to know about the machine it drives: where
 * the app keeps its log and settings, which inherited variables must not
 * reach a child Electron, and how to rewrite settings.json so the app sees
 * either the old or the new file.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

/** `~/Library/Logs/recordstuff/recordstuff.log`: the app's log (docs/system-design/desktop.md#logs). */
export const APP_LOG_PATH = path.join(os.homedir(), "Library/Logs/recordstuff/recordstuff.log");
/** `~/Library/Application Support/recordstuff/settings.json`: the app's preferences. */
export const APP_SETTINGS_PATH = path.join(os.homedir(), "Library/Application Support/recordstuff/settings.json");

/**
 * Variables an outer tool may have set that would change what a launched
 * Electron does: run as plain Node, load a dev server, or record on its own.
 */
export const INHERITED_ELECTRON_KEYS = ["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "RECORDSTUFF_AUTORECORD", "NODE_OPTIONS"] as const;

/** A copy of `process.env` without the inherited Electron variables. */
export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of INHERITED_ELECTRON_KEYS) delete env[key];
  return env;
}

/** The current settings, or undefined when the app has never written them. */
export function readAppSettings(file: string = APP_SETTINGS_PATH): Record<string, unknown> | undefined {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${file}: settings must be a JSON object`);
  return value as Record<string, unknown>;
}

/**
 * Replaces settings.json through a temporary name and a rename, as the app
 * itself does, so a concurrent reader sees the old or the new file, never a
 * partial one. Callers make sure the app is not running.
 */
export function writeAppSettings(settings: Record<string, unknown>, file: string = APP_SETTINGS_PATH): void {
  const temporary = `${file}.${randomUUID()}.runner-tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
