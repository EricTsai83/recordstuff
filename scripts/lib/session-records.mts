/**
 * Reads the app's versioned session records (src/shared/session-record.ts,
 * plan 029). Only a well-formed record of a known version is returned: a
 * malformed, truncated or future record is not guessed at.
 */
import { isCaptureReport, isQualitySettings } from "../../src/shared/quality.ts";
import { isErrorCode } from "../../src/shared/state.ts";
import { SESSION_RECORD_PREFIX, SESSION_RECORD_VERSION, type SessionRecord } from "../../src/shared/session-record.ts";

const TIMESTAMP = /^\[[^\]]*\]\s*/;

/** The message after the `[timestamp] ` of a log line. */
export function logMessage(line: string): string {
  return line.replace(TIMESTAMP, "");
}

/** The session-record line of a message, whether or not it carries a timestamp. */
export function isSessionRecordLine(line: string): boolean {
  return logMessage(line).startsWith(SESSION_RECORD_PREFIX);
}

const optionalString = (value: unknown): boolean => value === undefined || typeof value === "string";

export function parseSessionRecord(line: string): SessionRecord | undefined {
  const message = logMessage(line);
  if (!message.startsWith(SESSION_RECORD_PREFIX)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(message.slice(SESSION_RECORD_PREFIX.length));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Record<string, unknown>;
  if (r["v"] !== SESSION_RECORD_VERSION || typeof r["run"] !== "string" || r["run"] === "") return undefined;
  const session = typeof r["session"] === "string" && r["session"] !== "";
  const timing = optionalString(r["recordingAt"]) && optionalString(r["stoppingAt"]);
  switch (r["kind"]) {
    case "capture":
      return session && isQualitySettings(r["requested"]) && isCaptureReport(r["capture"]) ? value as SessionRecord : undefined;
    case "saved":
      return session && timing && typeof r["path"] === "string" && r["path"] !== ""
        && (r["stoppedEarly"] === undefined || r["stoppedEarly"] === "lowDisk") ? value as SessionRecord : undefined;
    case "failed":
      return session && timing && isErrorCode(r["code"]) && typeof r["detail"] === "string"
        && (r["outcome"] === "partial" || r["outcome"] === "empty" || r["outcome"] === "unknown")
        && optionalString(r["partialPath"]) && optionalString(r["recordingPath"]) ? value as SessionRecord : undefined;
    case "refused":
      return isErrorCode(r["code"]) && typeof r["detail"] === "string" ? value as SessionRecord : undefined;
    default:
      return undefined;
  }
}

/**
 * A `start:` line of a process that went on to run. A second launch refused
 * by the single-instance lock logs one too, in the middle of the running
 * process's lines, and exits at once; it starts nothing and is skipped.
 */
export function isProcessStart(line: string): boolean {
  const message = logMessage(line);
  return message.startsWith("start: ") && !message.startsWith("start: another instance already holds the userData lock");
}

/** The run id in a `start:` line (`…; run <id>; …`); undefined for builds before plan 029. */
export function startLineRun(line: string): string | undefined {
  if (!isProcessStart(line)) return undefined;
  return /; run (\S+?);/.exec(logMessage(line))?.[1];
}
