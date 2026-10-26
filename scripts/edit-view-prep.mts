/**
 * `pnpm prep:edit-view [-- --cleanup]` (2026-10-26): the setup a computer-use round of the edit view needs, which the
 * rounds of that day did by hand before each delegation, and the cleanup after it. macOS only; never shipped.
 *
 * Setup: opens this checkout's bundle when it is not running (`pnpm open:app`, which refuses a stale one), opens its
 * window by its registered shortcut, places it on a display other than the main one when there is one, 1060×1400 at
 * most (`roundWindowFrame`: the main display keeps the user's work, and a window straddling two displays was half out of
 * the computer-use tool's sight on 2026-10-26), and copies the newest editable recording of the output folder under a
 * new recording's name, so the round edits a recording no edit record holds. It prints one JSON line: the window's
 * frame, the display to screenshot (`screencapture -x -D <n>`) and the copy's name, for the round's prompt. Moving the
 * window moves no pointer; opening it brings RecordStuff to the front.
 *
 * Cleanup: every copy the setups made since the last cleanup, the exports a round made of it (「（已編輯）」 or "(edited)",
 * numbered or not) and their edit records go to the Trash, recoverable. Nothing else is touched.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { APP_SETTINGS_PATH } from "./lib/runner/runner-env.mts";
import { readEditableDescription } from "./lib/acceptance/editor-acceptance.mts";
import { exportsOf, recordingName, roundWindowFrame, type CocoaScreen } from "./lib/acceptance/edit-view-prep.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXECUTABLE = path.join(root, "dist/mac-arm64/RecordStuff.app/Contents/MacOS/RecordStuff");
const EDITS = path.join(path.dirname(APP_SETTINGS_PATH), "edits");
/** The copies made since the last cleanup. */
const MANIFEST = path.join(os.tmpdir(), "recordstuff-edit-view-prep.json");
const BUNDLE_ID = "com.ericts.record";

const run = (command: string, args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const done = spawnSync(command, args, { encoding: "utf8", cwd: root });
  return { status: done.status, stdout: done.stdout ?? "", stderr: done.stderr ?? "" };
};
const osascript = (script: string, javascript = false): string => {
  const done = run("osascript", [...(javascript ? ["-l", "JavaScript"] : []), "-e", script]);
  if (done.status !== 0) throw new Error(`osascript: ${done.stderr.trim()}`);
  return done.stdout.trim();
};
const running = (): boolean => run("pgrep", ["-f", EXECUTABLE]).status === 0;
const windowCount = (): number => Number(osascript(`tell application "System Events" to tell (first process whose bundle identifier is "${BUNDLE_ID}") to count windows`) || 0);

function outputFolder(): string {
  const settings = JSON.parse(fs.readFileSync(APP_SETTINGS_PATH, "utf8")) as { outputDir?: unknown };
  if (typeof settings.outputDir !== "string") throw new Error(`no output folder in ${APP_SETTINGS_PATH}`);
  return settings.outputDir;
}

function trash(file: string): void {
  osascript(`tell application "Finder" to delete POSIX file ${JSON.stringify(file)}`);
}

const editRecord = (file: string): string => path.join(EDITS, `${createHash("sha256").update(path.resolve(file)).digest("hex").slice(0, 32)}.json`);

async function setup(): Promise<Record<string, unknown>> {
  if (!running()) {
    const opened = run("pnpm", ["-s", "open:app"]);
    if (opened.status !== 0) throw new Error(`pnpm open:app: ${(opened.stderr || opened.stdout).trim()}`);
    for (let i = 0; i < 40 && !running(); i++) await delay(250);
  }
  if (windowCount() === 0) {
    const sent = run("pnpm", ["-s", "native:input", "--", "shortcut", "settings"]);
    if (sent.status !== 0) throw new Error(`native:input shortcut settings: ${sent.stdout.trim() || sent.stderr.trim()}`);
    for (let i = 0; i < 40 && windowCount() === 0; i++) await delay(250);
    if (windowCount() === 0) throw new Error("the window did not open");
  }
  const screens = JSON.parse(osascript(`ObjC.import("AppKit"); const s = $.NSScreen.screens; const main = $.NSScreen.mainScreen.frame; const out = [];
for (let i = 0; i < s.count; i++) { const f = s.objectAtIndex(i).frame; out.push({ x: f.origin.x, y: f.origin.y, width: f.size.width, height: f.size.height, main: f.origin.x === 0 && f.origin.y === 0 }); }
JSON.stringify(out)`, true)) as CocoaScreen[];
  const frame = roundWindowFrame(screens);
  osascript(`tell application "System Events" to tell (first process whose bundle identifier is "${BUNDLE_ID}") to tell window 1
set position to {${Math.round(frame.x)}, ${Math.round(frame.y)}}
set size to {${Math.round(frame.width)}, ${Math.round(frame.height)}}
end tell`);
  // screencapture -D counts displays from 1, the main one first.
  const display = screens.some((s) => !s.main) ? 2 : 1;

  const folder = outputFolder();
  const newest = fs.readdirSync(folder).filter((name) => name.endsWith(".mp4") && exportsOf(name.slice(0, -4), [name]).length === 0)
    .map((name) => ({ name, at: fs.statSync(path.join(folder, name)).mtimeMs })).sort((a, b) => b.at - a.at)
    .find(({ name }) => !/（已編輯|\(edited/.test(name) && readEditableDescription(fs.readFileSync(path.join(folder, name))) !== undefined);
  if (!newest) throw new Error(`no editable recording in ${folder}: record one first (the tray's Start editable recording)`);
  let at = new Date();
  let copy = recordingName(at);
  while (fs.existsSync(path.join(folder, copy))) { at = new Date(at.getTime() + 1000); copy = recordingName(at); }
  fs.copyFileSync(path.join(folder, newest.name), path.join(folder, copy), fs.constants.COPYFILE_EXCL);
  const made = fs.existsSync(MANIFEST) ? (JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as string[]) : [];
  fs.writeFileSync(MANIFEST, JSON.stringify([...made, path.join(folder, copy)]));
  return { command: "setup", window: frame, screenshot: `screencapture -x -D ${display} <path>`, copy: copy.slice(0, -4), from: newest.name };
}

function cleanup(): Record<string, unknown> {
  const made = fs.existsSync(MANIFEST) ? (JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as string[]) : [];
  const trashed: string[] = [];
  for (const copy of made) {
    const folder = path.dirname(copy);
    const names = fs.existsSync(folder) ? fs.readdirSync(folder) : [];
    for (const file of [copy, ...exportsOf(path.basename(copy, ".mp4"), names).map((name) => path.join(folder, name))]) {
      if (fs.existsSync(file)) { trash(file); trashed.push(path.basename(file)); }
      if (fs.existsSync(editRecord(file))) { trash(editRecord(file)); trashed.push(`edit record of ${path.basename(file)}`); }
    }
  }
  fs.rmSync(MANIFEST, { force: true });
  return { command: "cleanup", trashed };
}

const cleaning = process.argv.slice(2).includes("--cleanup");
if (process.platform !== "darwin") { console.error("BLOCKED: macOS only"); process.exit(2); }
try {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...(cleaning ? cleanup() : await setup()) }));
} catch (cause) {
  console.error(`FAILED: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(1);
}
