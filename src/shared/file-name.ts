/**
 * Recording file names (2026-10-05): the template new recordings are named by, and the rules a name the user types
 * (a template or a rename) must meet. Main validates every value it saves; the page imports the same rules only to
 * preview a draft and to say what is wrong before it is sent.
 */
import { translate as t, type Language } from "./i18n";

/** The name a recording gets when nothing else was chosen: `2026-10-05 14-02-11`, as every recording before the choice. */
export const DEFAULT_FILE_NAME_TEMPLATE = "{date} {time}";
/** Long enough for any sensible pattern; with `MAX_FILE_NAME_BYTES`, short of the 255-byte name limit of APFS, ext4 and others. */
export const MAX_FILE_NAME_LENGTH = 120;
/**
 * The name's own UTF-8 bytes: 255 less a collision suffix and `.recording.mp4`, with room to spare. Characters alone are
 * not enough: 120 Chinese characters are 360 bytes, which no recording could be saved under (review pass 1, F4).
 */
export const MAX_FILE_NAME_BYTES = 200;
const encoder = new TextEncoder();
/** What a template may say, each replaced by local time; only digits and `-` come out, safe on every file system. */
export const FILE_NAME_TOKENS = ["date", "time", "year", "month", "day", "hour", "minute", "second"] as const;
export type FileNameToken = typeof FILE_NAME_TOKENS[number];
/** Tokens that change from one second to the next: a template needs one, or every recording would take the same name. */
const CHANGING_TOKENS: readonly FileNameToken[] = ["time", "second"];

/** Why a name or template cannot be used; `formatFileName` and the rename check return one of these, or nothing. */
export type FileNameProblem = "empty" | "tooLong" | "characters" | "dot" | "edge" | "reserved" | "unknownToken" | "noTime";

/** Separators and characters macOS or Windows refuse in a name, and control characters. */
const FORBIDDEN = /[/\\:*?"<>|\u0000-\u001f\u007f]/;
/** Windows device names, refused there as a base name whatever its extension. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Why `name` (without its extension) cannot name a recording, or nothing when it can. */
export function fileNameProblem(name: string): FileNameProblem | undefined {
  if (!name.trim()) return "empty";
  if (name.length > MAX_FILE_NAME_LENGTH || encoder.encode(name).length > MAX_FILE_NAME_BYTES) return "tooLong";
  if (FORBIDDEN.test(name)) return "characters";
  // A leading dot hides the file, and the library does not list hidden files.
  if (name.startsWith(".")) return "dot";
  // Windows drops a trailing dot or space, and a leading space is easy to miss and hard to type again.
  if (/^\s|[\s.]$/.test(name)) return "edge";
  // Windows reserves a device name before any extension too: `CON.demo` is CON (review pass 2, F2).
  if (RESERVED.test(name.split(".")[0]!.trimEnd()) || /\.recording$/i.test(name)) return "reserved";
  return undefined;
}

/** Why a folder could not be made, renamed or deleted (plan 071). */
export type FolderProblem = FileNameProblem | "extension" | "exists" | "missing" | "notEmpty" | "failed";

/**
 * Why `name` cannot name a folder of recordings, or nothing when it can: a file name's rules, and no extension at its
 * end, since the library takes such a folder for a package (`Foo.app`) and would not offer it.
 */
export function folderNameProblem(name: string): FolderProblem | undefined {
  return fileNameProblem(name) ?? (/\.[a-z][a-z0-9-]*$/i.test(name) ? "extension" : undefined);
}

/** What to tell the user about a folder name, or a folder action that did not happen. */
export function folderProblemText(problem: FolderProblem, language: Language): string {
  switch (problem) {
    case "extension": return t("A category name cannot end in an extension such as .app.", language);
    case "exists": return t("This name is already in use.", language);
    case "missing": return t("This category no longer exists.", language);
    case "notEmpty": return t("Only an empty category can be deleted.", language);
    case "failed": return t("Could not complete this action. Try again.", language);
    default: return fileNameProblemText(problem, language);
  }
}

/** The two-digit (or four-digit year) local value of each token at `date`. */
function tokenValues(date: Date): Record<FileNameToken, string> {
  const two = (n: number): string => String(n).padStart(2, "0");
  const year = String(date.getFullYear()), month = two(date.getMonth() + 1), day = two(date.getDate());
  const hour = two(date.getHours()), minute = two(date.getMinutes()), second = two(date.getSeconds());
  return { date: `${year}-${month}-${day}`, time: `${hour}-${minute}-${second}`, year, month, day, hour, minute, second };
}

/** Why `template` cannot name new recordings, or nothing when it can. */
export function fileNameTemplateProblem(template: string): FileNameProblem | undefined {
  const tokens = [...template.matchAll(/\{([^{}]*)\}/g)].map(match => match[1]!);
  if (tokens.some(token => !(FILE_NAME_TOKENS as readonly string[]).includes(token))) return "unknownToken";
  // A brace that opens no token is left as text: refused, since it reads like a mistyped one.
  if (/[{}]/.test(template.replace(/\{[^{}]*\}/g, ""))) return "unknownToken";
  if (!tokens.some(token => (CHANGING_TOKENS as readonly string[]).includes(token))) return template.trim() ? "noTime" : "empty";
  return fileNameProblem(formatFileName(template, new Date(2026, 11, 31, 23, 59, 59)));
}

/** `template` with each token replaced by its value at `date`; unknown text stays as typed. */
export function formatFileName(template: string, date: Date): string {
  const values = tokenValues(date);
  return template.replace(/\{([a-z]+)\}/g, (whole, token: string) =>
    (FILE_NAME_TOKENS as readonly string[]).includes(token) ? values[token as FileNameToken] : whole);
}

/** A stored or requested template, trimmed, when it can be used. */
export function canonicalFileNameTemplate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const template = value.trim();
  return fileNameTemplateProblem(template) === undefined ? template : undefined;
}

/** The placeholders as typed, `{date} {time} …`, for the explanation and the unknown-placeholder error. */
export const FILE_NAME_TOKEN_LIST = FILE_NAME_TOKENS.map(token => `{${token}}`).join(" ");

/** What to tell the user about a name or template that cannot be used, or about a rename that did not happen. */
export function fileNameProblemText(problem: FileNameProblem | "exists" | "missing" | "failed", language: Language): string {
  switch (problem) {
    case "empty": return t("Enter a name.", language);
    case "tooLong": return t("This name is too long. Shorten it.", language);
    case "characters": return t("A name cannot contain / \\ : * ? \" < > |.", language);
    case "dot": return t("A name cannot start with a dot.", language);
    case "edge": return t("A name cannot start with a space or end with a space or dot.", language);
    case "reserved": return t("This name is reserved by the system. Choose another.", language);
    case "unknownToken": return t("Unknown placeholder. Use {tokens}.", language, { tokens: FILE_NAME_TOKEN_LIST });
    case "noTime": return t("Include {timeToken} or {secondToken} so each recording gets its own name.", language, { timeToken: "{time}", secondToken: "{second}" });
    case "exists": return t("A file with this name is already in the folder.", language);
    case "missing": return t("This recording is no longer in the folder.", language);
    case "failed": return t("Could not rename the recording. Try again.", language);
  }
}
