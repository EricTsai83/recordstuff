import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MessageBoxOptions } from "electron";
import { createOutputFolderOpener, isSameFolder, nodeOutputFolderFs, type OutputFolderFs } from "./output-folder";
import { SettingsStore } from "../settings/settings";
import type { Language } from "../../shared/i18n";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "recordstuff-output-folder-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const errno = (code: string, message: string): Error => Object.assign(new Error(`${code}: ${message}`), { code });
const exists = (target: string): Promise<boolean> => fs.stat(target).then(() => true, () => false);
const read = (file: string): Promise<string | undefined> => fs.readFile(file, "utf8").catch(() => undefined);

/**
 * The production opener over a real temporary home and a real SettingsStore.
 * `custom` persists a chosen folder first; without it the store is fresh and
 * points at the default `<home>/Movies/RecordStuff`, like a first launch.
 */
async function harness(options: {
  custom?: string; language?: Language; movies?: boolean; fs?: Partial<OutputFolderFs>;
  openPath?: (dir: string) => Promise<string>;
  show?: (options: MessageBoxOptions) => Promise<{ response: number }>;
  mediaPending?: () => boolean;
} = {}) {
  const home = path.join(root, "home");
  await fs.mkdir(home, { recursive: true });
  if (options.movies !== false) await fs.mkdir(path.join(home, "Movies"), { recursive: true });
  const defaultOutputDir = path.join(home, "Movies", "RecordStuff");
  const settingsFile = path.join(root, "settings.json");
  if (options.custom !== undefined || options.language !== undefined) {
    await fs.writeFile(settingsFile, JSON.stringify({ version: 3, outputDir: options.custom ?? defaultOutputDir,
      quality: { videoQuality: "standard", resolutionCap: "source", frameRate: 30 }, language: options.language ?? "en",
      hotkey: { enabled: true, accelerator: "CommandOrControl+Shift+1" } }));
  }
  const settingsBefore = await read(settingsFile);
  const store = new SettingsStore({ filePath: settingsFile, defaultOutputDir });
  const io = { stat: vi.fn(options.fs?.stat ?? nodeOutputFolderFs.stat), mkdir: vi.fn(options.fs?.mkdir ?? nodeOutputFolderFs.mkdir) };
  const openPath = vi.fn(options.openPath ?? (async (_dir: string) => ""));
  const show = vi.fn(options.show ?? (async (_options: MessageBoxOptions) => ({ response: 1 })));
  const chooseFolder = vi.fn(async () => undefined);
  const focus = vi.fn();
  const log = vi.fn();
  const mediaPending = vi.fn(options.mediaPending ?? (() => false));
  const notify = vi.fn();
  const open = createOutputFolderOpener({ outputDir: () => store.outputDir, defaultOutputDir: store.defaultOutputDir, language: () => store.language,
    openPath, focus, show, chooseFolder, mediaPending, notify, log, fs: io });
  const dialog = (call = 0): MessageBoxOptions => show.mock.calls[call]![0];
  return { home, defaultOutputDir, open, io, openPath, show, chooseFolder, focus, log, dialog, notify, mediaPending,
    settingsUnchanged: async () => expect(await read(settingsFile)).toBe(settingsBefore) };
}

it("creates only the fresh default folder, then opens it without writing settings", async () => {
  const h = await harness();
  await h.open();
  expect(h.io.mkdir).toHaveBeenCalledExactlyOnceWith(h.defaultOutputDir);
  expect(await fs.readdir(path.join(h.home, "Movies"))).toEqual(["RecordStuff"]);
  expect(await fs.readdir(h.defaultOutputDir)).toEqual([]);
  expect(h.openPath).toHaveBeenCalledExactlyOnceWith(h.defaultOutputDir);
  expect(h.show).not.toHaveBeenCalled();
  await h.settingsUnchanged();
  // The next click finds the folder and only opens it.
  await h.open();
  expect(h.io.mkdir).toHaveBeenCalledOnce();
  expect(h.openPath).toHaveBeenCalledTimes(2);
});

it("opens an existing folder without creating anything or prompting", async () => {
  const custom = path.join(root, "Recordings");
  await fs.mkdir(custom);
  const h = await harness({ custom });
  await h.open();
  expect(h.openPath).toHaveBeenCalledExactlyOnceWith(custom);
  expect(h.io.mkdir).not.toHaveBeenCalled();
  expect(h.show).not.toHaveBeenCalled();
  await h.settingsUnchanged();
});

it("never creates the default folder's missing parent", async () => {
  const h = await harness({ movies: false });
  await h.open();
  expect(await fs.readdir(h.home)).toEqual([]);
  expect(h.io.mkdir).not.toHaveBeenCalled();
  expect(h.openPath).not.toHaveBeenCalled();
  expect(h.dialog()).toMatchObject({ type: "warning", title: "RecordStuff", message: "Could not open the output folder",
    detail: expect.stringContaining(`: ${path.join(h.home, "Movies")} is missing or not a folder`),
    buttons: ["Change output folder", "Cancel"], defaultId: 0, cancelId: 1 });
  await h.settingsUnchanged();
});

it("never recreates a deleted custom folder, even inside an existing parent", async () => {
  await fs.mkdir(path.join(root, "external"));
  const custom = path.join(root, "external", "Recordings");
  const h = await harness({ custom });
  await h.open();
  expect(await exists(custom)).toBe(false);
  expect(h.io.mkdir).not.toHaveBeenCalled();
  expect(h.openPath).not.toHaveBeenCalled();
  expect(h.dialog().detail).toBe(`${custom} was not found. It may have been moved or deleted, or its drive disconnected. Try again or choose another folder.`);
  await h.settingsUnchanged();
});

it("never writes onto the system disk for a disconnected volume", async () => {
  const volume = `/Volumes/recordstuff-test-${process.pid}-${Date.now()}`;
  const custom = path.join(volume, "Recordings");
  const h = await harness({ custom });
  await h.open();
  expect(h.io.mkdir).not.toHaveBeenCalled();
  expect(await exists(volume)).toBe(false);
  expect(h.dialog().detail).toContain(`${custom} was not found.`);
  expect(h.dialog().detail).toContain("its drive disconnected");
  await h.settingsUnchanged();
});

it("reports a refused default-folder creation with its error", async () => {
  const h = await harness({ fs: { mkdir: async dir => { throw errno("EACCES", `permission denied, mkdir '${dir}'`); } } });
  await h.open();
  expect(await exists(h.defaultOutputDir)).toBe(false);
  expect(h.openPath).not.toHaveBeenCalled();
  expect(h.dialog().detail).toBe(`Could not create ${h.defaultOutputDir}. Check its parent folder's permissions, or choose another folder.`
    + `\n\nDetails: EACCES: permission denied, mkdir '${h.defaultOutputDir}'`);
});

it("lets Finder try a folder RecordStuff may not inspect, and explains a refusal", async () => {
  const custom = path.join(root, "Private");
  const denied = { stat: async (dir: string) => { throw errno("EPERM", `operation not permitted, stat '${dir}'`); } };
  const allowed = await harness({ custom, fs: denied });
  await allowed.open();
  expect(allowed.openPath).toHaveBeenCalledExactlyOnceWith(custom);
  expect(allowed.show).not.toHaveBeenCalled();

  const refused = await harness({ custom, fs: denied, openPath: async () => "The folder could not be opened." });
  await refused.open();
  expect(refused.io.mkdir).not.toHaveBeenCalled();
  expect(await exists(custom)).toBe(false);
  expect(refused.dialog().detail).toBe(`No permission to open ${custom}. Check the folder's permissions, or choose another folder.`
    + `\n\nDetails: EPERM: operation not permitted, stat '${custom}'`);
  expect(refused.log).toHaveBeenCalledWith(`output folder: openPath(${custom}) failed: The folder could not be opened.`);
});

it("refuses a configured path that is a file without touching it", async () => {
  const custom = path.join(root, "Recordings");
  await fs.writeFile(custom, "not a folder");
  const h = await harness({ custom });
  await h.open();
  expect(await fs.readFile(custom, "utf8")).toBe("not a folder");
  expect(h.io.mkdir).not.toHaveBeenCalled();
  expect(h.openPath).not.toHaveBeenCalled();
  expect(h.dialog().detail).toBe(`${custom} is a file, not a folder. Choose another folder.`);
  await h.settingsUnchanged();
});

it("does not replace a file sitting at the default path", async () => {
  const h = await harness();
  await fs.writeFile(h.defaultOutputDir, "keep");
  await h.open();
  expect(await fs.readFile(h.defaultOutputDir, "utf8")).toBe("keep");
  expect(h.io.mkdir).not.toHaveBeenCalled();
  expect(h.dialog().detail).toContain("is a file, not a folder");
});

it("surfaces shell errors, rejected opens and unreadable paths with their context", async () => {
  const custom = path.join(root, "Recordings");
  await fs.mkdir(custom);
  const failures = [async () => "No application knows how to open this.", async () => { throw new Error("launch services unavailable"); }];
  const h = await harness({ custom, openPath: async () => failures.shift()!() });
  await h.open();
  await h.open();
  expect(h.dialog(0).detail).toBe(`${custom} could not be opened. Try again, or choose another folder.\n\nDetails: No application knows how to open this.`);
  expect(h.dialog(1).detail).toContain("Details: launch services unavailable");
  expect(h.log).toHaveBeenCalledWith(`output folder: cannot open ${custom}: openFailed: No application knows how to open this.`);

  const io = await harness({ custom: path.join(root, "Busy"), fs: { stat: async () => { throw errno("EIO", "i/o error"); } } });
  await io.open();
  expect(io.dialog().detail).toBe(`${path.join(root, "Busy")} is unavailable. Check the folder and its drive, or choose another folder.\n\nDetails: EIO: i/o error`);
});

it("opens a folder that appeared while it was being created", async () => {
  const h = await harness({ fs: { mkdir: async dir => { await fs.mkdir(dir); throw errno("EEXIST", "file already exists"); } } });
  await h.open();
  expect(h.openPath).toHaveBeenCalledExactlyOnceWith(h.defaultOutputDir);
  expect(h.show).not.toHaveBeenCalled();
});

it("routes to the existing folder chooser only on request; cancel keeps settings", async () => {
  const custom = path.join(root, "Gone");
  const cancel = await harness({ custom });
  await cancel.open();
  expect(cancel.chooseFolder).not.toHaveBeenCalled();
  await cancel.settingsUnchanged();

  const choose = await harness({ custom, show: async () => ({ response: 0 }) });
  await choose.open();
  expect(choose.chooseFolder).toHaveBeenCalledOnce();
});

it("opens normally after the folder is restored", async () => {
  const custom = path.join(root, "Recordings");
  const h = await harness({ custom });
  await h.open();
  expect(h.show).toHaveBeenCalledOnce();
  await fs.mkdir(custom);
  await h.open();
  expect(h.openPath).toHaveBeenCalledExactlyOnceWith(custom);
  expect(h.show).toHaveBeenCalledOnce();
});

it("joins repeated clicks: one warning, brought forward, and a fresh attempt afterwards", async () => {
  let answer!: (value: { response: number }) => void;
  const h = await harness({ custom: path.join(root, "Gone"), show: () => new Promise(resolve => { answer = resolve; }) });
  const first = h.open();
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.open()).toBe(first);
  expect(h.open()).toBe(first);
  expect(h.show).toHaveBeenCalledOnce();
  expect(h.focus).toHaveBeenCalledTimes(3);
  answer({ response: 1 });
  await first;
  const second = h.open();
  expect(second).not.toBe(first);
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(2));
  answer({ response: 1 });
  await second;
});

it("brings the folder chooser forward when a click joins while it is open", async () => {
  const h = await harness({ custom: path.join(root, "Gone"), show: async () => ({ response: 0 }) });
  let chosen!: () => void;
  h.chooseFolder.mockImplementation(() => new Promise<undefined>(resolve => { chosen = () => resolve(undefined); }));
  const first = h.open();
  await vi.waitFor(() => expect(h.chooseFolder).toHaveBeenCalledOnce());
  const before = h.focus.mock.calls.length;
  expect(h.open()).toBe(first);
  expect(h.focus).toHaveBeenCalledTimes(before + 1);
  chosen();
  await first;
  expect(h.chooseFolder).toHaveBeenCalledOnce();
});

it("joins clicks while Finder is still opening without stealing focus", async () => {
  const custom = path.join(root, "Recordings");
  await fs.mkdir(custom);
  let opened!: (error: string) => void;
  const h = await harness({ custom, openPath: () => new Promise(resolve => { opened = resolve; }) });
  const first = h.open();
  await vi.waitFor(() => expect(h.openPath).toHaveBeenCalledOnce());
  expect(h.open()).toBe(first);
  expect(h.focus).not.toHaveBeenCalled();
  opened("");
  await first;
  expect(h.openPath).toHaveBeenCalledOnce();
});

it("contains native dialog failures and still shows the warning when focus fails", async () => {
  const shows = [async () => { throw new Error("dialog refused"); }, async () => ({ response: 1 })];
  const h = await harness({ custom: path.join(root, "Gone"), show: () => shows.shift()!() });
  // A warning that could not be shown told nothing: the row says it failed.
  await expect(h.open()).resolves.toBe(false);
  expect(h.log).toHaveBeenCalledWith("output folder: open action failed: Error: dialog refused");
  h.focus.mockImplementation(() => { throw new Error("no focus"); });
  await h.open();
  expect(h.show).toHaveBeenCalledTimes(2);
  expect(h.log).toHaveBeenCalledWith("output folder: focus failed: Error: no focus");
});

it("speaks the current language", async () => {
  const custom = path.join(root, "外接", "錄影");
  const h = await harness({ custom, language: "zh-TW", fs: { stat: async () => { throw errno("EIO", "i/o error"); } } });
  await h.open();
  expect(h.dialog()).toMatchObject({ message: "無法開啟儲存位置", buttons: ["更改儲存位置", "取消"],
    detail: `${custom} 無法使用。請檢查資料夾與所在磁碟，或選擇其他位置。\n\n詳細資訊：EIO: i/o error` });
});

it("tells a problem found while recording work is pending in a notification, never the modal warning", async () => {
  // Opening the folder while recording work is pending (plan 056): a warning now would hold its writes.
  const custom = path.join(root, "外接", "錄影");
  const h = await harness({ custom, language: "zh-TW", mediaPending: () => true });
  // Only held for later: the row is told now that it failed.
  expect(await h.open()).toBe(false);
  expect(h.show).not.toHaveBeenCalled();
  expect(h.focus).not.toHaveBeenCalled();
  expect(h.chooseFolder).not.toHaveBeenCalled();
  expect(h.notify).toHaveBeenCalledExactlyOnceWith(`找不到 ${custom}，可能已被移動、刪除，或所在磁碟未連接。請再試一次或選擇其他位置。`);
  expect(h.log).toHaveBeenCalledWith(`output folder: cannot open ${custom}: missing`);
  expect(h.log).toHaveBeenCalledWith("output folder: recording work is pending; telling the problem in a notification instead of a warning");
  await h.settingsUnchanged();
});

it("reads pending work when the problem is found, and keeps the settled warning and its chooser", async () => {
  let pending = true;
  let opened!: (error: string) => void;
  const custom = path.join(root, "Recordings");
  await fs.mkdir(custom);
  const h = await harness({ custom, mediaPending: () => pending, show: async () => ({ response: 0 }),
    openPath: () => new Promise(resolve => { opened = resolve; }) });
  const first = h.open();
  await vi.waitFor(() => expect(h.openPath).toHaveBeenCalledOnce());
  // The work settled while Finder was answering: the warning is safe again.
  pending = false;
  opened("Finder refused");
  // The warning told it, so the row adds nothing.
  expect(await first).toBe(true);
  expect(h.notify).not.toHaveBeenCalled();
  expect(h.dialog()).toMatchObject({ message: "Could not open the output folder", buttons: ["Change output folder", "Cancel"] });
  expect(h.chooseFolder).toHaveBeenCalledOnce();
});

it("opens a working folder while recording work is pending without telling anything", async () => {
  const custom = path.join(root, "Recordings");
  await fs.mkdir(custom);
  const h = await harness({ custom, mediaPending: () => true });
  expect(await h.open()).toBe(true);
  expect(h.openPath).toHaveBeenCalledExactlyOnceWith(custom);
  expect(h.notify).not.toHaveBeenCalled();
  expect(h.show).not.toHaveBeenCalled();
});

it("treats the default folder written another way as the default, and nothing else (recording and the opener share the rule)", () => {
  expect(isSameFolder("/Users/me/Movies/RecordStuff/", "/Users/me/Movies/RecordStuff")).toBe(true);
  expect(isSameFolder("/Users/me/Movies/./RecordStuff", "/Users/me/Movies/RecordStuff")).toBe(true);
  expect(isSameFolder("/Users/me/Movies/RecordStuff 2", "/Users/me/Movies/RecordStuff")).toBe(false);
});
