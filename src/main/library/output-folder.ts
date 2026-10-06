import fs from "node:fs/promises";
import path from "node:path";
import type { MessageBoxOptions } from "electron";
import { translate, type Language } from "../../shared/i18n";
import { APP_NAME } from "../lib/app-name";
import { errnoCode, messageOf } from "../lib/errors";

/**
 * Whether two folder paths name the same folder as written (`~/Movies/RecordStuff/` and `…/RecordStuff`).
 * The default folder is the one RecordStuff may create; recording and Show in Finder both ask with this.
 */
export function isSameFolder(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/** The two filesystem calls opening may make; injectable so tests can refuse them. */
export interface OutputFolderFs {
  stat(dir: string): Promise<{ isDirectory(): boolean }>;
  /** Never recursive: only the known default folder itself is ever created here. */
  mkdir(dir: string): Promise<unknown>;
}

export const nodeOutputFolderFs: OutputFolderFs = {
  stat: dir => fs.stat(dir),
  mkdir: dir => fs.mkdir(dir),
};

type Problem =
  | { kind: "missing" | "notFolder" }
  | { kind: "parentMissing"; parent: string }
  | { kind: "createFailed" | "denied" | "unavailable" | "openFailed"; error: string };

/** ENOTDIR means a path component is a file: the folder does not exist either. */
const isMissing = (cause: unknown): boolean => ["ENOENT", "ENOTDIR"].includes(errnoCode(cause) ?? "");
const isDenied = (cause: unknown): boolean => ["EACCES", "EPERM"].includes(errnoCode(cause) ?? "");

function problemText(problem: Problem, dir: string, language: Language): string {
  const values = { path: dir };
  switch (problem.kind) {
    case "missing":
      return translate("{path} was not found. It may have been moved or deleted, or its drive disconnected. Try again or choose another folder.", language, values);
    case "parentMissing":
      return translate("Could not create {path}: {parent} is missing or not a folder. Restore it and try again, or choose another folder.", language, { ...values, parent: problem.parent });
    case "notFolder":
      return translate("{path} is a file, not a folder. Choose another folder.", language, values);
    case "createFailed":
      return translate("Could not create {path}. Check its parent folder's permissions, or choose another folder.", language, values);
    case "denied":
      return translate("No permission to open {path}. Check the folder's permissions, or choose another folder.", language, values);
    case "unavailable":
      return translate("{path} is unavailable. Check the folder and its drive, or choose another folder.", language, values);
    case "openFailed":
      return translate("{path} could not be opened. Try again, or choose another folder.", language, values);
  }
}

/**
 * Show in Finder for the output folder (plan 033; Settings' Output folder row and the Recordings tab's header
 * since the tray item moved there, 2026-10-04). An existing folder opens as
 * before. The known default folder, which recording creates only when it
 * starts, is created here too, but only itself and only inside an existing
 * parent. A missing custom folder is never recreated: it may live on a
 * disconnected drive, and recreating the path would put recordings on the
 * system disk. Every other outcome is a warning with the path and a route to
 * the existing folder chooser; opening never writes settings.
 *
 * One attempt runs at a time. A repeated click joins it and, while the warning
 * is up, brings that warning forward instead of stacking a second one.
 *
 * The warning is a windowless message box, which holds main's timers, I/O and
 * log until it is answered (plan 055). While recording work is pending, which a
 * saved file's fallback can meet during a later recording, the same text goes
 * to `notify` instead and the chooser stays with Settings once the session has
 * settled (plan 056).
 *
 * Resolves whether the user has been told: true once the folder opened or the warning was answered, false when the
 * problem only waits in a notice held until the recording ends, so the Settings row says at once that it failed.
 */
export function createOutputFolderOpener(deps: {
  outputDir(): string;
  defaultOutputDir: string;
  language(): Language;
  openPath(dir: string): Promise<string>;
  focus(): void;
  show(options: MessageBoxOptions): Promise<{ response: number }>;
  /** The existing choose-folder flow, including its recording locks. */
  chooseFolder(): Promise<void>;
  /** A session or its cleanup is in flight; read when a problem is found. */
  mediaPending(): boolean;
  /** Tells the problem without blocking; must not throw. */
  notify(body: string): void;
  log(message: string): void;
  fs?: OutputFolderFs;
}): () => Promise<boolean> {
  const io = deps.fs ?? nodeOutputFolderFs;
  let active: Promise<boolean> | undefined;
  /** The warning or the folder chooser it leads to is open: a repeated click brings it forward. */
  let prompting = false;

  const open = async (dir: string, deniedBy?: unknown): Promise<Problem | undefined> => {
    let error: string;
    try { error = await deps.openPath(dir); }
    catch (cause) { error = messageOf(cause); }
    if (!error) return undefined;
    deps.log(`output folder: openPath(${dir}) failed: ${error}`);
    return deniedBy === undefined ? { kind: "openFailed", error } : { kind: "denied", error: messageOf(deniedBy) };
  };

  const create = async (dir: string): Promise<Problem | undefined> => {
    const parent = path.dirname(dir);
    try {
      if (!(await io.stat(parent)).isDirectory()) return { kind: "parentMissing", parent };
    } catch (cause) {
      if (isMissing(cause)) return { kind: "parentMissing", parent };
      return { kind: "createFailed", error: messageOf(cause) };
    }
    try {
      await io.mkdir(dir);
      deps.log(`output folder: created default ${dir}`);
    } catch (cause) {
      // A recording start may have created it in the meantime.
      if (errnoCode(cause) !== "EEXIST") return { kind: "createFailed", error: messageOf(cause) };
      try {
        if (!(await io.stat(dir)).isDirectory()) return { kind: "notFolder" };
      } catch (again) { return { kind: "createFailed", error: messageOf(again) }; }
    }
    return open(dir);
  };

  const attempt = async (dir: string): Promise<Problem | undefined> => {
    let stats: { isDirectory(): boolean };
    try { stats = await io.stat(dir); }
    catch (cause) {
      if (isMissing(cause)) {
        return isSameFolder(dir, deps.defaultOutputDir) ? create(dir) : { kind: "missing" };
      }
      // RecordStuff may be refused where Finder is not (macOS privacy folders).
      if (isDenied(cause)) return open(dir, cause);
      return { kind: "unavailable", error: messageOf(cause) };
    }
    return stats.isDirectory() ? open(dir) : { kind: "notFolder" };
  };

  const focus = (): void => {
    try { deps.focus(); }
    catch (cause) { deps.log(`output folder: focus failed: ${String(cause)}`); }
  };

  const run = async (): Promise<boolean> => {
    const dir = deps.outputDir();
    const problem = await attempt(dir);
    if (!problem) return true;
    deps.log(`output folder: cannot open ${dir}: ${problem.kind}${"error" in problem ? `: ${problem.error}` : ""}`);
    const language = deps.language();
    const text = problemText(problem, dir, language);
    if (deps.mediaPending()) {
      deps.log("output folder: recording work is pending; telling the problem in a notification instead of a warning");
      deps.notify(text);
      return false;
    }
    const detail = text
      + ("error" in problem ? `\n\n${translate("Details: {error}", language, { error: problem.error })}` : "");
    prompting = true;
    try {
      focus();
      const { response } = await deps.show({
        type: "warning", title: APP_NAME,
        message: translate("Could not open the output folder", language), detail,
        buttons: [translate("Change output folder", language), translate("Cancel", language)],
        defaultId: 0, cancelId: 1, noLink: true,
      });
      // The chooser is windowless too and can sit behind other apps; a click meanwhile must not look dead.
      if (response === 0) await deps.chooseFolder();
    } finally { prompting = false; }
    return true;
  };

  return () => {
    if (active) {
      if (prompting) focus();
      return active;
    }
    active = Promise.resolve().then(run)
      .catch((cause: unknown) => { deps.log(`output folder: open action failed: ${String(cause)}`); return false; })
      .finally(() => { active = undefined; });
    return active;
  };
}
