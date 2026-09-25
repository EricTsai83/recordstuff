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
import type { RecordingFailure } from "../shared/recording-result";

export interface SessionSentinel {
  sessionId: string;
  startedAt: string;
  /** The temporary `.recording.mp4` this session is about to create or has created. */
  recordingPath: string;
}

const SUFFIX = ".json";
const TEMPORARY = `${SUFFIX}.tmp`;
const MAX_BYTES = 64 * 1024;
const VALID_ID = /^[A-Za-z0-9_-]{1,100}$/;

function parse(sessionId: string, text: string): SessionSentinel | undefined {
  const value = JSON.parse(text) as Partial<SessionSentinel> & { version?: unknown };
  if (value?.version !== 1 || value.sessionId !== sessionId || typeof value.startedAt !== "string" ||
      !Number.isFinite(Date.parse(value.startedAt)) || typeof value.recordingPath !== "string" ||
      !path.isAbsolute(value.recordingPath) || value.recordingPath.includes("\0")) return undefined;
  return { sessionId, startedAt: value.startedAt, recordingPath: value.recordingPath };
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

  /** Never throws: a sentinel that cannot be removed only produces a spurious entry at the next launch. */
  async remove(sessionId: string): Promise<void> {
    if (!VALID_ID.test(sessionId)) return;
    try {
      await fs.promises.unlink(this.file(sessionId));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log(`sentinel: could not remove ${sessionId}: ${String(cause)}`);
      }
    }
    this.own.delete(sessionId);
  }

  /**
   * Sentinels left by earlier processes. Never throws. An interrupted atomic
   * write names no media file yet (the sentinel precedes the temporary file),
   * so it and invalid content are logged and removed instead of reported. A
   * sentinel that cannot be read right now is kept for a later launch.
   */
  async leftovers(): Promise<SessionSentinel[]> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") this.log(`sentinel: could not read ${this.dir}: ${String(cause)}`);
      return [];
    }
    const found: SessionSentinel[] = [];
    for (const name of names.sort()) {
      const temporary = name.endsWith(TEMPORARY);
      if (!temporary && !name.endsWith(SUFFIX)) continue;
      const sessionId = name.slice(0, name.length - (temporary ? TEMPORARY : SUFFIX).length);
      if (!VALID_ID.test(sessionId) || this.own.has(sessionId)) continue;
      const file = path.join(this.dir, name);
      let sentinel: SessionSentinel | undefined;
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
      if (sentinel) { found.push(sentinel); continue; }
      this.log(`sentinel: discarding ${temporary ? "interrupted write" : "invalid sentinel"} ${name}`);
      await fs.promises.unlink(file).catch(() => undefined);
    }
    return found;
  }
}

/** Launch-time evidence as one failure-history entry. The ID is derived from the session, so a retried launch cannot add it twice. */
export function interruptionFailure(sentinel: SessionSentinel): RecordingFailure {
  return {
    id: `interrupted-${sentinel.sessionId}`,
    occurredAt: sentinel.startedAt,
    code: "app_terminated",
    detail: `session ${sentinel.sessionId} started ${sentinel.startedAt} was still recording when RecordStuff last ended; ` +
      "the temporary file was not finalized and may be incomplete; no recovery or repair was attempted",
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
