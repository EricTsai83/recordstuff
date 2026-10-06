/**
 * The volume a measurement writes to: its file system and mount point from
 * `df` and `mount`, and its free space. macOS developer tooling only.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

/** File system type and mount point of the volume holding `dir`. */
export function volumeOf(dir: string): { mount: string; type: string } {
  const df = spawnSync("df", ["-P", dir], { encoding: "utf8" }).stdout.trim().split("\n").at(-1) ?? "";
  const mount = df.split(/\s+/).slice(5).join(" ");
  const line = spawnSync("mount", [], { encoding: "utf8" }).stdout.split("\n").find((entry) => entry.includes(` on ${mount} (`));
  return { mount, type: /\(([^,)]+)/.exec(line ?? "")?.[1] ?? "unknown" };
}

export function freeBytes(dir: string): number {
  const stat = fs.statfsSync(dir);
  return stat.bavail * stat.bsize;
}
