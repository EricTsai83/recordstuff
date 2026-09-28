/**
 * Finding the running RecordStuff and building safe `pgrep` patterns. Every
 * runner that must not rebuild, replace or quit a foreign copy goes through
 * here rather than spelling the pattern out.
 */
import { spawnSync } from "node:child_process";

/** Escapes a literal for use inside a RegExp or an extended `pgrep -f` pattern. */
export function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The `pgrep -f` pattern for a RecordStuff bundle's main process: the
 * executable path, with or without arguments, and never a helper process.
 * With `bundleDir` only that bundle matches; without it, any RecordStuff.app.
 */
export function recordStuffPattern(bundleDir?: string): string {
  const executable = bundleDir
    ? `${escapeRegExp(bundleDir.replace(/\/$/, ""))}/Contents/MacOS/RecordStuff`
    : "(^|/)RecordStuff\\.app/Contents/MacOS/RecordStuff";
  return `${bundleDir ? "^" : ""}${executable}($| )`;
}

/** Pids of RecordStuff main processes; throws when `pgrep` itself fails (exit 1 is "none"). */
export function recordStuffPids(bundleDir?: string): number[] {
  const result = spawnSync("pgrep", ["-f", recordStuffPattern(bundleDir)], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) throw new Error(`pgrep failed (${result.status}): ${result.stderr.trim()}`);
  return result.stdout.split("\n").filter(Boolean).map(Number).filter(Number.isInteger);
}
