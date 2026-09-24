import type { RecordingFailure, RecordingResult } from "../shared/recording-result";
import { translate as t, type Language, type MessageKey } from "../shared/i18n";
import type { ErrorCode } from "../shared/state";
import type { ResultStorage } from "./recording-result-store";
import type { RecordingResultAction } from "./ui-model";

const OUTPUT_FOLDER_FAILURES: readonly ErrorCode[] = ["disk_full", "output_open_failed", "output_write_failed"];
/** `no_audio_track` belongs here: macOS withholds system audio without the capture grant. */
const PERMISSION_FAILURES: readonly ErrorCode[] = ["permission_denied", "permission_needs_relaunch", "no_audio_track"];

/** Recovered by freeing space or choosing another output folder. */
export const isOutputFolderFailure = (code: ErrorCode): boolean => OUTPUT_FOLDER_FAILURES.includes(code);
/** Recovered through capture permission in System Settings, possibly followed by a relaunch. */
export const isPermissionFailure = (code: ErrorCode): boolean => PERMISSION_FAILURES.includes(code);

type Stat = (path: string) => Promise<{ isFile(): boolean; size: number }>;
interface ResultEffects {
  stat: Stat;
  refresh(): void;
  notify(code: ErrorCode): void;
}
interface ResultActions {
  stat: Stat;
  refresh(): void;
  settled(): boolean;
  platform: NodeJS.Platform;
  reveal(path: string): void;
  folder(): Promise<void>;
  permission(): Promise<void>;
  relaunch(): Promise<void>;
  needsRelaunch?(): boolean;
}

/** Newest first; never evict unread failures. Media files are never changed here. */
export class RecordingResults {
  private results: RecordingResult[];
  private restored: RecordingResult[];
  private readonly seen = new Set<string>();
  private persisted: string | undefined;
  private savedRows = new Map<string, string>();
  private fingerprint(results: readonly RecordingResult[]): string {
    return JSON.stringify(results.map(result => [result.id, result.occurredAt, result.code, result.detail, result.outcome,
      result.acknowledged, result.acknowledgedAt, result.partialPath, result.outcome === "partial" ? null : result.recordingPath,
      result.outcome === "partial" ? false : Boolean(result.previouslyPartial)]));
  }
  constructor(private readonly storage?: ResultStorage, private readonly log: (message: string) => void = () => {}) {
    const saved = storage?.load() ?? [];
    this.restored = saved;
    for (const result of saved) this.seen.add(result.id);
    if (!storage?.requiresMigration) {
      this.persisted = this.fingerprint(saved);
      this.savedRows = new Map(saved.map(r => [r.id, this.fingerprint([r])]));
    }
    // A legacy record must also be written to the history file on restore.
    this.results = saved.map(result => {
      const current = { ...result, restored: true };
      if (result.outcome === "pending" || result.outcome === "partial") return { ...this.unknown(current), restored: true, acknowledged: result.acknowledged };
      return current;
    });
  }
  get current(): RecordingResult | undefined { return this.results[0]; }
  get all(): readonly RecordingResult[] { return this.results; }
  private trim(results: RecordingResult[]): RecordingResult[] {
    const keep = new Set(results.filter(r => r.acknowledged)
      .sort((a, b) => Date.parse(b.acknowledgedAt ?? b.occurredAt) - Date.parse(a.acknowledgedAt ?? a.occurredAt))
      .slice(0, 20).map(r => r.id));
    return results.filter(result => !result.acknowledged || keep.has(result.id));
  }
  private persist(results = this.results): boolean {
    const fingerprint = this.fingerprint(results);
    try {
      if (fingerprint !== this.persisted) this.storage?.save(results);
      this.persisted = fingerprint;
      this.savedRows = new Map(results.map(r => [r.id, this.fingerprint([r])]));
      for (const result of results) delete result.persistenceFailed;
      return true;
    } catch (error) {
      for (const result of this.results) {
        if (this.savedRows.get(result.id) !== this.fingerprint([result])) result.persistenceFailed = true;
        else delete result.persistenceFailed;
      }
      this.log(`recording history: save failed: ${String(error)}`);
      return false;
    }
  }
  /** One OS request at a time; after timeout leave the rest unknown without issuing more I/O. */
  async restore(stat: Stat, refresh: () => void): Promise<void> {
    const saved = this.restored;
    this.restored = [];
    for (const original of saved) {
      const candidate = original.partialPath ?? original.recordingPath;
      if (!candidate) continue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let confirmed = false;
      let timedOut = false;
      try {
        confirmed = await Promise.race([
          this.exists({ ...original, partialPath: candidate }, stat),
          new Promise<false>(resolve => { timer = setTimeout(() => { timedOut = true; resolve(false); }, 2000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
      const current = this.results.find(r => r.id === original.id);
      if (timedOut) break;
      if (!current?.restored || current.outcome !== "unknown") continue;
      if ((original.outcome === "partial" || original.previouslyPartial) && confirmed) {
        this.results = this.results.map(r => r === current ? { ...r, outcome: "partial", partialPath: candidate } : r);
        refresh();
      }
    }
    if (saved.length) { this.results = this.trim(this.results); this.persist(); refresh(); }
  }
  update(result: RecordingFailure): boolean {
    const previous = this.results.find(r => r.id === result.id);
    if (!previous && result.outcome !== "pending" && (this.results.length || this.seen.has(result.id))) return false;
    this.seen.add(result.id);
    const next = { ...result, acknowledged: previous?.acknowledged ?? false,
      ...(previous?.restored ? { restored: true } : {}),
      ...(previous?.acknowledgedAt ? { acknowledgedAt: previous.acknowledgedAt } : {}) };
    this.results = previous ? this.results.map(r => r === previous ? next : r) : [next, ...this.results];
    this.persist();
    return true;
  }
  acknowledge(id: string): boolean {
    const result = this.results.find(r => r.id === id);
    if (!result || result.outcome === "pending") return false;
    const reviewedAt = result.acknowledgedAt ?? new Date(Math.max(Date.now(),
      ...this.results.map(r => r.acknowledgedAt ? Date.parse(r.acknowledgedAt) + 1 : 0))).toISOString();
    const next = this.trim(this.results.map(r => r === result ? { ...r, acknowledged: true, acknowledgedAt: reviewedAt } : r));
    if (!this.persist(next)) return false;
    this.results = next;
    return true;
  }
  private unknown(result: RecordingFailure): RecordingFailure {
    const { partialPath: _path, ...base } = result;
    return { ...base, ...(_path ? { recordingPath: _path, previouslyPartial: true } : {}), outcome: "unknown" };
  }
  private async exists(result: RecordingFailure, stat: Stat): Promise<boolean> {
    if (!result.partialPath) return false;
    try {
      const file = await stat(result.partialPath);
      return file.isFile() && file.size > 0;
    } catch { return false; }
  }
  async receive(result: RecordingFailure, effects: ResultEffects): Promise<void> {
    const confirmed = result.outcome === "partial"
      ? await this.exists(result, effects.stat) : true;
    if (!this.update(confirmed ? result : this.unknown(result))) return;
    effects.refresh();
    if (result.outcome === "pending") effects.notify(result.code);
  }
  async act(id: string, action: RecordingResultAction, effects: ResultActions): Promise<boolean> {
    const result = this.results.find(r => r.id === id);
    if (!result || result.id !== id) return false;
    if (action === "acknowledge") {
      const applied = this.acknowledge(id);
      effects.refresh();
      return applied;
    }
    if (action === "retry") {
      const applied = this.persist(); effects.refresh(); return applied;
    }
    if (action === "remove") {
      if (!result.acknowledged || result.outcome === "pending") return false;
      const next = this.results.filter(r => r.id !== id);
      const applied = this.persist(next);
      if (applied) this.results = next;
      effects.refresh(); return applied;
    }
    if (action === "reveal") {
      if (result.outcome !== "partial" || !result.partialPath) return false;
      const confirmed = await this.exists(result, effects.stat);
      if (!this.results.some(r => r.id === id)) return false;
      if (!confirmed) {
        this.update(this.unknown(result));
        effects.refresh();
        return false;
      }
      effects.reveal(result.partialPath);
      return true;
    }
    if (!effects.settled() || (action !== "permission" && result.outcome === "pending")) return false;
    if (action === "relaunch" && result.restored && !effects.needsRelaunch?.()) return false;
    if (action === "folder") {
      if (!isOutputFolderFailure(result.code)) return false;
      await effects.folder();
    } else {
      if (effects.platform !== "darwin" || !isPermissionFailure(result.code)) return false;
      await effects[action]();
    }
    return true;
  }
}

const reasons: Record<ErrorCode, MessageKey> = {
  permission_denied: "Screen recording permission required",
  permission_needs_relaunch: "Screen recording access was granted, but RecordStuff needs to relaunch. Use the tray menu.",
  unsupported_os_version: "This system version does not support system audio capture. macOS 13 or newer is required on Mac.",
  display_unavailable: "Selected display is unavailable. Choose another screen.",
  no_display: "No display is available for recording.",
  no_audio_track: "System audio is unavailable. On macOS, allow RecordStuff in System Settings > Privacy & Security > Screen & System Audio Recording.",
  mp4_unsupported: "MP4 recording is not supported on this computer.",
  capture_start_failed: "Could not start recording.",
  capture_failed: "Recording was interrupted.",
  capture_host_crashed: "The recording process crashed.",
  capture_host_unresponsive: "The recording process is not responding.",
  output_open_failed: "The output folder could not be written.",
  output_write_failed: "Could not write the recording.",
  disk_full: "The disk is full.",
  stop_timeout: "Stopping the recording timed out.",
};
export const failureReason = (code: ErrorCode, language: Language): string => t(reasons[code], language);
export function failureGuidance(code: ErrorCode, language: Language, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "darwin" && isPermissionFailure(code))
    return t("Check capture permissions and audio devices before recording again.", language);
  return t(code === "disk_full" ? "Free disk space or choose another output folder before recording again."
    : isOutputFolderFailure(code) ? "Check the output folder, its permissions and the connected drive before recording again."
    : isPermissionFailure(code) ? "Check recording permissions in System Settings. Relaunch if access was recently granted."
    : code === "display_unavailable" || code === "no_display" ? "Choose Primary display or another available screen."
    : "Check your recording settings before trying again. Starting again does not recover missing content.", language);
}
export function failureOutcome(result: RecordingFailure, language: Language): string {
  return t(result.outcome === "pending" ? "Processing the recorded data… The file result is not yet confirmed."
    : result.outcome === "partial" ? "A partial recording was kept. It may not be playable."
    : result.outcome === "empty" ? "No recording content was kept."
    : "Could not confirm whether recording content was kept. Check the output folder.", language);
}
