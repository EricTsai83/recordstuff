/**
 * Interruption evidence (docs/system-design/recording.md#file-completion-and-failure):
 * one small file per in-flight session, written before its temporary media file
 * exists and removed on its terminal outcome. A sentinel left at launch names a
 * session whose process ended while recording. The single-instance lock means
 * no other live process owns it. This is not crash recovery or orphan-file scanning:
 * only the named path is checked, and no media is ever changed.
 */
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file";
import { errnoCode } from "./errors";
import type { RecordingFailure } from "../shared/recording-result";

export interface SessionSentinel {
  sessionId: string;
  startedAt: string;
  /** The temporary `.recording.mp4` this session is about to create or has created. */
  recordingPath: string;
  finalizedPath?: string;
}

const SUFFIX = ".json";
const TEMPORARY = `${SUFFIX}.tmp`;
const MAX_BYTES = 64 * 1024;
const VALID_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** The sentinel, `"newer"` for a later format this build cannot read, or undefined for invalid content. */
function parse(sessionId: string, text: string): SessionSentinel | "newer" | undefined {
  const value = JSON.parse(text) as Partial<SessionSentinel> & { version?: unknown };
  if (Number.isInteger(value?.version) && (value.version as number) > 1) return "newer";
  if (value?.version !== 1 || value.sessionId !== sessionId || typeof value.startedAt !== "string" ||
      !Number.isFinite(Date.parse(value.startedAt)) || typeof value.recordingPath !== "string" ||
      !path.isAbsolute(value.recordingPath) || value.recordingPath.includes("\0")) return undefined;
  const finalizedPath = value.finalizedPath;
  if (finalizedPath !== undefined && (typeof finalizedPath !== "string" || !path.isAbsolute(finalizedPath) || finalizedPath.includes("\0"))) return undefined;
  return { sessionId, startedAt: value.startedAt, recordingPath: value.recordingPath, ...(finalizedPath ? { finalizedPath } : {}) };
}

export class SessionSentinels {
  /** Sessions of this process; a launch scan never reports them. */
  private readonly own = new Set<string>();

  constructor(private readonly dir: string, private readonly log: (message: string) => void = () => {}) {}

  private file(sessionId: string): string {
    return path.join(this.dir, `${sessionId}${SUFFIX}`);
  }

  /** Atomic, so a reader sees the previous or the new content; rewritten before each temporary-name attempt. */
  async write(sentinel: SessionSentinel): Promise<void> {
    if (!VALID_ID.test(sentinel.sessionId)) throw new Error(`invalid session id ${JSON.stringify(sentinel.sessionId)}`);
    this.own.add(sentinel.sessionId);
    await writeFileAtomic(this.file(sentinel.sessionId), JSON.stringify({ version: 1, ...sentinel }), { mode: 0o600 });
  }

  /** A durable success checkpoint makes a failed unlink harmless on the next launch. */
  async complete(sessionId: string, finalizedPath: string): Promise<void> {
    if (!VALID_ID.test(sessionId)) throw new Error("invalid session id");
    const sentinel = parse(sessionId, await fs.promises.readFile(this.file(sessionId), "utf8"));
    if (!sentinel || sentinel === "newer") throw new Error("invalid sentinel");
    await this.write({ ...sentinel, finalizedPath });
  }

  /** Never throws: completed checkpoints are safe to leave for the next launch. */
  async remove(sessionId: string): Promise<void> {
    if (!VALID_ID.test(sessionId)) return;
    try {
      await fs.promises.unlink(this.file(sessionId));
    } catch (cause) {
      if (errnoCode(cause) !== "ENOENT") {
        this.log(`sentinel: could not remove ${sessionId}: ${String(cause)}`);
      }
    }
    this.own.delete(sessionId);
  }

  /**
   * Sentinels left by earlier processes. Never throws. An interrupted atomic
   * write names no media file yet (the sentinel precedes the temporary file),
   * so it and invalid content are logged and removed instead of reported. A
   * sentinel that cannot be read right now, or that a newer version wrote, is
   * kept for a later launch.
   */
  async leftovers(): Promise<SessionSentinel[]> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch (cause) {
      if (errnoCode(cause) !== "ENOENT") this.log(`sentinel: could not read ${this.dir}: ${String(cause)}`);
      return [];
    }
    const found: SessionSentinel[] = [];
    for (const name of names.sort()) {
      const temporary = name.endsWith(TEMPORARY);
      if (!temporary && !name.endsWith(SUFFIX)) continue;
      const sessionId = name.slice(0, name.length - (temporary ? TEMPORARY : SUFFIX).length);
      if (!VALID_ID.test(sessionId) || this.own.has(sessionId)) continue;
      const file = path.join(this.dir, name);
      let sentinel: SessionSentinel | "newer" | undefined;
      if (!temporary) {
        let text: string | undefined;
        try {
          const handle = await fs.promises.open(file, "r");
          try {
            if ((await handle.stat()).size <= MAX_BYTES) text = await handle.readFile("utf8");
          } finally { await handle.close(); }
        } catch (cause) {
          // A read failure says nothing about the content; deleting it would lose the evidence.
          this.log(`sentinel: could not read ${name}; kept for a later launch: ${String(cause)}`);
          continue;
        }
        try { sentinel = text === undefined ? undefined : parse(sessionId, text); }
        catch { sentinel = undefined; }
      }
      if (sentinel === "newer") {
        // Like newer settings and history, evidence a later version wrote is left for that version to report.
        this.log(`sentinel: kept ${name} from a newer version`);
        continue;
      }
      if (sentinel?.finalizedPath) {
        await this.remove(sessionId);
        continue;
      }
      if (sentinel) { found.push(sentinel); continue; }
      this.log(`sentinel: discarding ${temporary ? "interrupted write" : "invalid sentinel"} ${name}`);
      await fs.promises.unlink(file).catch(() => undefined);
    }
    return found;
  }
}

/** Launch-time evidence as one failure-history entry. The ID is derived from the session, so a retried launch cannot add it twice. */
function interruptionFailure(sentinel: SessionSentinel): RecordingFailure {
  return {
    id: `interrupted-${sentinel.sessionId}`,
    occurredAt: sentinel.startedAt,
    code: "app_terminated",
    detail: `session ${sentinel.sessionId} started ${sentinel.startedAt} had no confirmed terminal checkpoint when RecordStuff last ended; ` +
      "completion is unknown (a final file may already exist); the temporary file may be incomplete; no recovery or repair was attempted",
    // A lookup hint rechecked like a restored partial: partial only while the file exists.
    outcome: "unknown", recordingPath: sentinel.recordingPath, previouslyPartial: true,
  };
}

/** The part of the failure history that launch reporting needs. */
export interface InterruptionHistory {
  restore(interrupted: RecordingFailure[]): Promise<boolean>;
  saved(ids: readonly string[]): Promise<void>;
}

/**
 * Launch: each leftover sentinel becomes one failure-history entry before the
 * restore recheck. A sentinel is removed only once its entry has been saved,
 * including by a later automatic retry, so the history owns the evidence before
 * the sentinel goes. An unsaved history keeps the sentinel for the next launch,
 * where the derived ID prevents a duplicate entry.
 */
export async function reportInterruptions(
  sentinels: SessionSentinels,
  history: InterruptionHistory,
  log: (message: string) => void,
): Promise<void> {
  const leftovers = await sentinels.leftovers();
  if (leftovers.length) log(`start: ${leftovers.length} recording session(s) did not finish before the previous exit`);
  const entries = leftovers.map(interruptionFailure);
  if (!await history.restore(entries) && leftovers.length) log("start: interruption sentinels kept until the failure history is saved");
  await history.saved(entries.map(entry => entry.id));
  for (const sentinel of leftovers) await sentinels.remove(sentinel.sessionId);
}
