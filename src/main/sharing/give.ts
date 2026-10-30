/**
 * Giving the versions Share… hands out (plan 100 step 3): what a copy puts on the clipboard, and what Save to… writes.
 *
 * - **Copy (D7)** gives files, never a folder: most chat and mail apps refuse one, so Sources are their files. They are
 *   clones in a folder of their own (`clipboardFiles`), never the cache's links: Finder's ⌘V on the same volume moves a
 *   file the pasteboard names rather than copying it (plan 100 step 5), which would leave the person's file sharing the
 *   cache entry's data.
 * - **Save to…** writes each version into the folder chosen under the name it leaves with, a number added when the
 *   name is taken there (`Meeting 2.mp4`), never over another file; Sources stay a folder of their own. A copy is the
 *   system's own (a clone on APFS, so it costs no space until either side changes), independent of the cache.
 */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/** The files a copy gives for one handed-out version: the file itself, or a folder's files (Sources, D7). */
export async function copiedFiles(handed: string): Promise<string[]> {
  const stat = await fs.stat(handed);
  if (!stat.isDirectory()) return [handed];
  const names = (await fs.readdir(handed)).filter((name) => !name.startsWith(".")).sort();
  return names.map((name) => path.join(handed, name));
}

/** The folder under the cache's `root` that holds what the pasteboard names: the last copy only. */
export const COPIED_FOLDER = ".copied";

/**
 * What a copy puts on the pasteboard for `files`: a clone of each (no space on APFS until either side changes), under
 * its own name, in a fresh folder of `COPIED_FOLDER`, the previous copy's folder removed, since the pasteboard holds one
 * copy. A paste may then move it anywhere, and the cache keeps its own files. A file named twice is given once.
 */
export async function clipboardFiles(root: string, files: readonly string[]): Promise<string[]> {
  const copied = path.join(root, COPIED_FOLDER);
  await fs.rm(copied, { recursive: true, force: true });
  const folder = path.join(copied, randomBytes(6).toString("hex"));
  await fs.mkdir(folder, { recursive: true });
  const given: string[] = [];
  for (const file of new Set(files)) {
    const target = path.join(folder, path.basename(file));
    await fs.copyFile(file, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    given.push(target);
  }
  return given;
}

/** `name` in `folder` if free, else `name 2`, `name 3`… before its extension (a folder has none). */
async function freeName(folder: string, name: string, isFolder: boolean): Promise<string> {
  const extension = isFolder ? "" : path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let n = 1; n < 1000; n++) {
    const target = path.join(folder, n === 1 ? name : `${stem} ${n}${extension}`);
    const taken = await fs.lstat(target).then(() => true, () => false);
    if (!taken) return target;
  }
  throw Object.assign(new Error(`no free name for ${name} in ${folder}`), { code: "EEXIST" });
}

/** Copies `from` (a file, or a folder of files) to `to`, which must not exist. */
async function copyInto(from: string, to: string): Promise<void> {
  const stat = await fs.stat(from);
  if (!stat.isDirectory()) {
    await fs.copyFile(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    return;
  }
  await fs.mkdir(to);
  for (const name of await fs.readdir(from)) if (!name.startsWith(".")) await copyInto(path.join(from, name), path.join(to, name));
}

/** Save to…: each handed-out version into `folder`, under its own name or the next free one. The paths written. */
export async function saveInto(folder: string, handed: readonly string[]): Promise<string[]> {
  const written: string[] = [];
  for (const file of handed) {
    const isFolder = (await fs.stat(file)).isDirectory();
    const target = await freeName(folder, path.basename(file), isFolder);
    await copyInto(file, target);
    written.push(target);
  }
  return written;
}

/** What macOS's pasteboard takes for files (NSFilenamesPboardType): a property list of their paths. */
export function filesPropertyList(files: readonly string[]): string {
  const escape = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n`
    + `<plist version="1.0"><array>${files.map((file) => `<string>${escape(file)}</string>`).join("")}</array></plist>\n`;
}
