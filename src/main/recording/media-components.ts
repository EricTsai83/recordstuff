/**
 * Windows's media components (plan 078): the engine encodes with Media Foundation, which a Windows N edition lacks
 * until the Media Feature Pack is installed. Main checks for its libraries at launch, as it checks the screen
 * permission on macOS, so Start recording says why it is unavailable instead of failing; the engine's
 * `media_components_missing` stays as the last line for what this check cannot see.
 */
import fs from "node:fs";
import path from "node:path";

/** Media Foundation itself, its H.264 encoder and its AAC encoder: everything the engine loads from it. */
const MEDIA_FOUNDATION_LIBRARIES = ["mfplat.dll", "mfh264enc.dll", "mfaacenc.dll"] as const;

/** The libraries missing from System32; none outside Windows. */
export function missingMediaComponents(
  platform: NodeJS.Platform,
  systemRoot: string | undefined,
  exists: (file: string) => boolean = fs.existsSync,
): string[] {
  if (platform !== "win32") return [];
  const system32 = path.win32.join(systemRoot ?? "C:\\Windows", "System32");
  return MEDIA_FOUNDATION_LIBRARIES.filter((library) => !exists(path.win32.join(system32, library)));
}
