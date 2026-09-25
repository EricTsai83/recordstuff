import fs from "node:fs/promises";
import path from "node:path";
import type { MessageBoxOptions } from "electron";
import { translate, type Language } from "../shared/i18n";
import { APP_NAME } from "./ui-model";

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

function errnoCode(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { code: unknown }).code) : undefined;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** ENOTDIR means a path component is a file: the folder does not exist either. */
const isMissing = (cause: unknown): boolean => ["ENOENT", "ENOTDIR"].includes(errnoCode(cause) ?? "");
const isDenied = (cause: unknown): boolean => ["EACCES", "EPERM"].includes(errnoCode(cause) ?? "");

function problemText(problem: Problem, dir: string, language: Language): string {
  const values = { path: dir };
  switch (problem.kind) {
    case "missing":
      return translate("{path} was not found. It may have been moved or deleted, or its drive may be disconnected. Reconnect the drive and try again, or choose another folder.", language, values);
    case "parentMissing":
      return translate("{path} could not be created because its parent folder {parent} is missing or is not a folder. Restore that folder and try again, or choose another folder.", language, { ...values, parent: problem.parent });
    case "notFolder":
      return translate("{path} is a file, not a folder. Choose another folder.", language, values);
    case "createFailed":
      return translate("{path} could not be created. Check the permissions of its parent folder and try again, or choose another folder.", language, values);
    case "denied":
      return translate("RecordStuff does not have permission to open {path}. Check the folder's permissions and try again, or choose another folder.", language, values);
    case "unavailable":
      return translate("{path} is unavailable. Check the folder and its drive, then try again, or choose another folder.", language, values);
    case "openFailed":
      return translate("{path} could not be opened. Try again, or choose another folder.", language, values);
  }
}

/**
 * The tray's output-folder action (plan 033). An existing folder opens as
 * before. The known default folder, which recording creates only when it
 * starts, is created here too, but only itself and only inside an existing
 * parent. A missing custom folder is never recreated: it may live on a
 * disconnected drive, and recreating the path would put recordings on the
 * system disk. Every other outcome is a warning with the path and a route to
 * the existing folder chooser; opening never writes settings.
 *
 * One attempt runs at a time. A repeated click joins it and, while the warning
 * is up, brings that warning forward instead of stacking a second one.
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
  log(message: string): void;
  fs?: OutputFolderFs;
}): () => Promise<void> {
  const io = deps.fs ?? nodeOutputFolderFs;
  let active: Promise<void> | undefined;
  let prompting = false;

  const open = async (dir: string, deniedBy?: unknown): Promise<Problem | undefined> => {
    let error: string;
    try { error = await deps.openPath(dir); }
    catch (cause) { error = describe(cause); }
    if (!error) return undefined;
    deps.log(`output folder: openPath(${dir}) failed: ${error}`);
    return deniedBy === undefined ? { kind: "openFailed", error } : { kind: "denied", error: describe(deniedBy) };
  };

  const create = async (dir: string): Promise<Problem | undefined> => {
    const parent = path.dirname(dir);
    try {
      if (!(await io.stat(parent)).isDirectory()) return { kind: "parentMissing", parent };
    } catch (cause) {
      if (isMissing(cause)) return { kind: "parentMissing", parent };
      return { kind: "createFailed", error: describe(cause) };
    }
    try {
      await io.mkdir(dir);
      deps.log(`output folder: created default ${dir}`);
    } catch (cause) {
      // A recording start may have created it in the meantime.
      if (errnoCode(cause) !== "EEXIST") return { kind: "createFailed", error: describe(cause) };
      try {
        if (!(await io.stat(dir)).isDirectory()) return { kind: "notFolder" };
      } catch (again) { return { kind: "createFailed", error: describe(again) }; }
    }
    return open(dir);
  };

  const attempt = async (dir: string): Promise<Problem | undefined> => {
    let stats: { isDirectory(): boolean };
    try { stats = await io.stat(dir); }
    catch (cause) {
      if (isMissing(cause)) {
        return path.resolve(dir) === path.resolve(deps.defaultOutputDir) ? create(dir) : { kind: "missing" };
      }
      // RecordStuff may be refused where Finder is not (macOS privacy folders).
      if (isDenied(cause)) return open(dir, cause);
      return { kind: "unavailable", error: describe(cause) };
    }
    return stats.isDirectory() ? open(dir) : { kind: "notFolder" };
  };

  const focus = (): void => {
    try { deps.focus(); }
    catch (cause) { deps.log(`output folder: focus failed: ${String(cause)}`); }
  };

  const run = async (): Promise<void> => {
    const dir = deps.outputDir();
    const problem = await attempt(dir);
    if (!problem) return;
    deps.log(`output folder: cannot open ${dir}: ${problem.kind}${"error" in problem ? `: ${problem.error}` : ""}`);
    const language = deps.language();
    const detail = problemText(problem, dir, language)
      + ("error" in problem ? `\n\n${translate("Details: {error}", language, { error: problem.error })}` : "");
    prompting = true;
    let response: number;
    try {
      focus();
      ({ response } = await deps.show({
        type: "warning", title: APP_NAME,
        message: translate("Could not open the output folder", language), detail,
        buttons: [translate("Change output folder", language), translate("Cancel", language)],
        defaultId: 0, cancelId: 1, noLink: true,
      }));
    } finally { prompting = false; }
    if (response === 0) await deps.chooseFolder();
  };

  return () => {
    if (active) {
      if (prompting) focus();
      return active;
    }
    active = Promise.resolve().then(run)
      .catch((cause: unknown) => deps.log(`output folder: open action failed: ${String(cause)}`))
      .finally(() => { active = undefined; });
    return active;
  };
}
