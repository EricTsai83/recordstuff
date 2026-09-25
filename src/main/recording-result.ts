import type { PersistenceIssue, RecordingFailure, RecordingResult } from "../shared/recording-result";
import { translate as t, type Language, type PlainMessageKey } from "../shared/i18n";
import type { ErrorCode } from "../shared/state";
import { HistoryStorageError, sliced, type ResultStorage } from "./recording-result-store";
import type { RecordingResultAction } from "./ui-model";

const OUTPUT_FOLDER_FAILURES: readonly ErrorCode[] = ["disk_full", "output_open_failed", "output_write_failed"];
/** `no_audio_track` belongs here: macOS withholds system audio without the capture grant. */
const PERMISSION_FAILURES: readonly ErrorCode[] = ["permission_denied", "permission_needs_relaunch", "no_audio_track"];

/** Recovered by freeing space or choosing another output folder. */
export const isOutputFolderFailure = (code: ErrorCode): boolean => OUTPUT_FOLDER_FAILURES.includes(code);
/** Recovered through capture permission in System Settings, possibly followed by a relaunch. */
export const isPermissionFailure = (code: ErrorCode): boolean => PERMISSION_FAILURES.includes(code);

/** Delay before each automatic retry of a failed history save; the last value repeats while unsaved. */
export const RETRY_DELAYS_MS: readonly number[] = [2000, 5000, 15_000, 30_000];
/** `safe`: nothing the user would lose; `writing`: a save is still in flight, so exit is not offered. */
export type FlushOutcome = "safe" | "unsaved" | "writing";

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
interface PendingAction {
  kind: "acknowledge" | "remove";
  at?: string;
  revision: number;
  promise: Promise<boolean>;
  settle(ok: boolean): void;
}

/**
 * Newest first; never evict unread failures. Media files are never changed here.
 *
 * One persistence owner with at most one write in flight and one coalesced
 * follow-up: every snapshot is the whole history, so a later snapshot carries
 * every failure and action outcome of an earlier one. `revision` counts
 * changes the file should hold; a completion settles only what its snapshot
 * contained. Acknowledgement and removal become visible only once durable.
 */
export class RecordingResults {
  private results: RecordingResult[] = [];
  private restored: RecordingResult[] = [];
  private readonly seen = new Set<string>();
  /** Fingerprints of the saved file in order; undefined until known, including a pending migration. */
  private persisted: string[] | undefined;
  private savedRows = new Map<string, string>();
  /** Records are replaced, never mutated, so a fingerprint is computed once per record. */
  private readonly fingerprints = new WeakMap<RecordingResult, string>();
  private readonly flagged = new Map<string, PersistenceIssue>();
  private readonly pending = new Map<string, PendingAction>();
  private readonly waiters: Array<{ revision: number; settle(ok: boolean): void }> = [];
  /** IDs that were in a saved file at some point in this process; a later removal does not undo that. */
  private readonly everSaved = new Set<string>();
  private readonly savedWatchers: Array<{ ids: readonly string[]; settle(): void }> = [];
  private revision = 0;
  private inflight = 0;
  private writing: Promise<void> | undefined;
  private queued = false;
  private failures = 0;
  private issue: PersistenceIssue | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private loaded = false;
  private loadFailed = false;
  private quitting = false;
  private closed = false;
  /** Settles when the saved history has been read and merged. */
  readonly ready: Promise<void>;
  private fingerprint(result: RecordingResult): string {
    let value = this.fingerprints.get(result);
    if (value === undefined) {
      value = JSON.stringify([result.id, result.occurredAt, result.code, result.detail, result.outcome,
        result.acknowledged, result.acknowledgedAt, result.partialPath, result.outcome === "partial" ? null : result.recordingPath,
        result.outcome === "partial" ? false : Boolean(result.previouslyPartial)]);
      this.fingerprints.set(result, value);
    }
    return value;
  }
  constructor(private readonly storage?: ResultStorage, private readonly log: (message: string) => void = () => {},
    private readonly changed: () => void = () => {}, private readonly retryDelaysMs: readonly number[] = RETRY_DELAYS_MS) {
    if (storage) this.ready = this.load(storage);
    else { this.loaded = true; this.persisted = []; this.ready = Promise.resolve(); }
  }
  /** Reads without blocking main; failures arriving meanwhile stay visible and are merged by ID. */
  private async load(storage: ResultStorage): Promise<void> {
    let saved: RecordingResult[] = [];
    try { saved = await storage.load(); }
    catch (error) { this.loadFailed = true; this.log(`recording history: load failed: ${String(error)}`); }
    if (!storage.requiresMigration && !this.loadFailed) {
      const persisted: string[] = [];
      for (const result of saved) persisted.push(await sliced(() => this.fingerprint(result)));
      this.persisted = persisted;
      this.savedRows = new Map(saved.map((r, index) => [r.id, persisted[index]!]));
      for (const result of saved) this.everSaved.add(result.id);
    }
    const arrived = new Set(this.results.map(r => r.id));
    saved = saved.filter(result => !arrived.has(result.id));
    this.restored = saved;
    for (const result of saved) this.seen.add(result.id);
    // Startup normalization alone is rewritten by `restore`, which can undo it.
    const normalized = saved.map(result => {
      const current = { ...result, restored: true };
      if (result.outcome === "pending" || result.outcome === "partial") return { ...this.unknown(current), restored: true, acknowledged: result.acknowledged };
      // `restored` is not fingerprinted, so the copy reuses the saved record's value.
      const known = this.fingerprints.get(result);
      if (known !== undefined) this.fingerprints.set(current, known);
      return current;
    });
    const requested = arrived.size > 0 || storage.requiresMigration || this.waiters.length > 0 || this.pending.size > 0;
    this.results = [...this.results, ...normalized];
    this.loaded = true;
    if (requested) { this.revision++; this.schedule(); }
    this.changed();
  }
  get current(): RecordingResult | undefined { return this.all[0]; }
  get all(): readonly RecordingResult[] {
    return this.results.map(result => {
      const saving = this.pending.get(result.id)?.kind;
      const failed = this.flagged.get(result.id);
      return saving || failed ? { ...result, ...(saving ? { saving } : {}), ...(failed ? { persistenceFailed: failed } : {}) } : result;
    });
  }
  get loading(): boolean { return !this.loaded; }
  get busy(): boolean { return this.writing !== undefined; }
  private trim(results: RecordingResult[]): RecordingResult[] {
    const keep = new Set(results.filter(r => r.acknowledged)
      .sort((a, b) => Date.parse(b.acknowledgedAt ?? b.occurredAt) - Date.parse(a.acknowledgedAt ?? a.occurredAt))
      .slice(0, 20).map(r => r.id));
    return results.filter(result => !result.acknowledged || keep.has(result.id));
  }
  /** Every change the file should hold goes through here. */
  private set(results: RecordingResult[]): void {
    this.results = results;
    this.revision++;
    this.schedule();
  }
  /** Visible history plus actions that wait for this save. */
  private snapshot(): RecordingResult[] {
    return this.trim(this.results.flatMap(result => {
      const action = this.pending.get(result.id);
      if (!action) return [result];
      return action.kind === "remove" ? [] : [{ ...result, acknowledged: true, acknowledgedAt: action.at! }];
    }));
  }
  private schedule(): void {
    if (!this.loaded || this.closed) return;
    if (this.writing) { if (this.revision > this.inflight) this.queued = true; return; }
    this.start();
  }
  private start(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.closed) return;
    // Changes made before the snapshot is taken join it.
    this.inflight = Number.POSITIVE_INFINITY;
    this.writing = Promise.resolve().then(() => this.write()).then(({ revision, ok, actions, refresh }) => {
      // Release the writer and pick waiters in one step: a waiter added after `write` returned
      // has no newer change, so this attempt answers it; later changes set `queued`.
      this.writing = undefined;
      const waiters = this.waiters.filter(waiter => waiter.revision <= revision);
      this.waiters.splice(0, this.waiters.length, ...this.waiters.filter(waiter => waiter.revision > revision));
      if (this.queued) { this.queued = false; this.start(); }
      else if (this.failures && this.issue === "io") this.retryLater();
      // Settle after the release, so an awaiting caller sees the true state.
      for (const action of actions) action.settle(ok);
      for (const waiter of waiters) waiter.settle(ok);
      if (refresh) this.changed();
    });
  }
  private retryLater(): void {
    if (this.quitting || this.closed || this.retryTimer) return;
    const delay = this.retryDelaysMs[Math.min(this.failures, this.retryDelaysMs.length) - 1]!;
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; if (!this.writing) this.start(); }, delay);
  }
  private async write(): Promise<{ revision: number; ok: boolean; actions: PendingAction[]; refresh: boolean }> {
    const revision = this.inflight = this.revision;
    const actions = [...this.pending].filter(([, action]) => action.revision <= revision);
    let snapshot: RecordingResult[] = [];
    const fingerprints: string[] = [];
    let failed = false, error: unknown;
    // Any failure, including an unexpected one, settles this attempt instead of wedging the writer.
    try {
      snapshot = this.snapshot();
      for (const result of snapshot) fingerprints.push(await sliced(() => this.fingerprint(result)));
      if (this.loadFailed) throw new HistoryStorageError("Existing recording history could not be read; refusing to overwrite it", "blocked");
      const persisted = this.persisted;
      if (!persisted || persisted.length !== fingerprints.length || fingerprints.some((value, index) => value !== persisted[index]))
        await this.storage?.save(snapshot);
    } catch (cause) { failed = true; error = cause; }
    let flagsChanged = false;
    if (!failed) {
      this.persisted = fingerprints;
      this.savedRows = new Map(snapshot.map((result, index) => [result.id, fingerprints[index]!]));
      for (const result of snapshot) this.everSaved.add(result.id);
      for (const watcher of this.savedWatchers.filter(w => w.ids.every(id => this.everSaved.has(id)))) {
        this.savedWatchers.splice(this.savedWatchers.indexOf(watcher), 1);
        watcher.settle();
      }
      if (this.failures) this.log(`recording history: saved after ${this.failures} failed attempt(s)`);
      this.failures = 0;
      this.issue = undefined;
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      if (actions.length) {
        const committed = new Map(actions);
        const saved = new Map(snapshot.map(result => [result.id, result]));
        this.results = this.trim(this.results.flatMap(r => {
          const action = committed.get(r.id);
          if (!action) return [r];
          if (action.kind === "remove") return [];
          const next = { ...r, acknowledged: true, acknowledgedAt: action.at! }, stored = saved.get(r.id);
          // Reuse the saved object unless a late update changed the row meanwhile.
          return [stored && this.fingerprint(stored) === this.fingerprint(next) ? stored : next];
        }));
        for (const [id] of actions) this.pending.delete(id);
      }
      // An older snapshot never clears the warning of a newer unsaved change.
      if (this.flagged.size) {
        const rows = new Map(this.results.map(r => [r.id, r]));
        for (const id of [...this.flagged.keys()]) {
          const row = rows.get(id);
          if (!row || this.savedRows.get(id) === this.fingerprint(row)) { this.flagged.delete(id); flagsChanged = true; }
        }
      }
    } else {
      const issue: PersistenceIssue = error instanceof HistoryStorageError ? error.issue : "io";
      if (!this.failures || issue !== this.issue) this.log(`recording history: save failed: ${String(error)}`);
      this.failures++;
      this.issue = issue;
      for (const [id] of actions) this.pending.delete(id);
      for (const row of this.results) {
        if (this.savedRows.get(row.id) !== this.fingerprint(row)) {
          if (this.flagged.get(row.id) !== issue) { this.flagged.set(row.id, issue); flagsChanged = true; }
        } else if (this.flagged.delete(row.id)) flagsChanged = true;
      }
    }
    return { revision, ok: !failed, actions: actions.map(([, action]) => action), refresh: actions.length > 0 || flagsChanged };
  }
  /**
   * Resolves once every ID has been in a saved file, including through a later
   * automatic retry or before a removal saved since; never starts a save.
   * Pending while history cannot be saved.
   */
  saved(ids: readonly string[]): Promise<void> {
    if (ids.every(id => this.everSaved.has(id))) return Promise.resolve();
    return new Promise(settle => this.savedWatchers.push({ ids, settle }));
  }
  /** Resolves once everything changed so far is durable (true), or when that attempt fails (false). */
  persist(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return new Promise(settle => {
      this.waiters.push({ revision: this.revision, settle });
      this.schedule();
    });
  }
  private request(id: string, kind: PendingAction["kind"], at?: string): Promise<boolean> {
    const existing = this.pending.get(id);
    if (existing) return existing.kind === kind ? existing.promise : Promise.resolve(false);
    let settle!: (ok: boolean) => void;
    const promise = new Promise<boolean>(resolve => { settle = resolve; });
    this.revision++;
    this.pending.set(id, { kind, ...(at ? { at } : {}), revision: this.revision, promise, settle });
    this.schedule();
    return promise;
  }
  /** Rows whose current state is not in the saved file, as the user sees them. */
  unsaved(): RecordingResult[] {
    return this.all.filter((_, index) => {
      const row = this.results[index]!;
      return !this.loaded || this.savedRows.get(row.id) !== this.fingerprint(row);
    });
  }
  /**
   * Quit: suspend automatic retry and attempt the latest save with a bounded wait.
   * The deadline never cancels OS I/O and never starts a competing writer.
   */
  async flush(timeoutMs: number): Promise<FlushOutcome> {
    this.quitting = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (!this.loaded && !this.results.length) return "safe";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); });
    let saved: boolean | undefined;
    // A follow-up write (a change made meanwhile) is awaited within the same deadline.
    do saved = await Promise.race([this.ready.then(() => this.persist()), deadline]);
    while (saved !== undefined && this.writing && !this.closed);
    clearTimeout(timer);
    if (this.writing) return "writing";
    return saved || !this.unsaved().length ? "safe" : "unsaved";
  }
  /** The user stayed after quit: resume automatic retries. */
  resume(): void {
    this.quitting = false;
    if (this.failures && this.issue === "io" && !this.writing) this.retryLater();
  }
  /** Exit is admitted: no later write may start. */
  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
  /**
   * One OS request at a time; after timeout leave the rest unknown without issuing more I/O.
   * `interrupted` entries come from an earlier process (launch sentinels) and join the
   * restored rows, rechecked the same way; an ID already in history is not added again.
   * Resolves whether this attempt saved the history; `saved` follows later retries.
   */
  async restore(stat: Stat, refresh: () => void, interrupted: readonly RecordingFailure[] = []): Promise<boolean> {
    await this.ready;
    const adopted = interrupted.filter(result => !this.seen.has(result.id))
      .map(result => ({ ...result, acknowledged: false, restored: true }));
    for (const result of adopted) this.seen.add(result.id);
    if (adopted.length) {
      // Older than anything this process reported, newer than the saved rows.
      const at = this.results.findIndex(result => result.restored);
      this.results = at < 0 ? [...this.results, ...adopted] : [...this.results.slice(0, at), ...adopted, ...this.results.slice(at)];
    }
    const saved = [...adopted, ...this.restored];
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
    if (!saved.length) return true;
    this.set(this.trim(this.results)); refresh();
    return this.persist();
  }
  update(result: RecordingFailure): boolean {
    const previous = this.results.find(r => r.id === result.id);
    if (!previous && result.outcome !== "pending" && (this.results.length || this.seen.has(result.id))) return false;
    this.seen.add(result.id);
    const next = { ...result, acknowledged: previous?.acknowledged ?? false,
      ...(previous?.restored ? { restored: true } : {}),
      ...(previous?.acknowledgedAt ? { acknowledgedAt: previous.acknowledgedAt } : {}) };
    this.set(previous ? this.results.map(r => r === previous ? next : r) : [next, ...this.results]);
    return true;
  }
  /** Resolves true once the acknowledgement is durable; until then the row stays unread. */
  acknowledge(id: string): Promise<boolean> {
    const result = this.results.find(r => r.id === id);
    if (!result || result.outcome === "pending") return Promise.resolve(false);
    if (result.acknowledged) return this.persist();
    const times = [...this.results.map(r => r.acknowledgedAt), ...[...this.pending.values()].map(a => a.at)];
    return this.request(id, "acknowledge", new Date(Math.max(Date.now(),
      ...times.map(time => time ? Date.parse(time) + 1 : 0))).toISOString());
  }
  /** Removes reviewed metadata once durable; the recording file is never touched. */
  remove(id: string): Promise<boolean> {
    const result = this.results.find(r => r.id === id);
    if (!result?.acknowledged || result.outcome === "pending") return Promise.resolve(false);
    return this.request(id, "remove");
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
    if (action === "acknowledge" || action === "remove" || action === "retry") {
      // Manual retry joins an active write instead of starting another.
      const applied = action === "acknowledge" ? this.acknowledge(id) : action === "remove" ? this.remove(id) : this.persist();
      effects.refresh();
      const done = await applied;
      effects.refresh();
      return done;
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

const reasons: Record<ErrorCode, PlainMessageKey> = {
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
  app_terminated: "RecordStuff did not exit normally while recording.",
};
export const failureReason = (code: ErrorCode, language: Language): string => t(reasons[code], language);
export function failureGuidance(code: ErrorCode, language: Language, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "darwin" && isPermissionFailure(code))
    return t("Check capture permissions and audio devices before recording again.", language);
  return t(code === "disk_full" ? "Free disk space or choose another output folder before recording again."
    : isOutputFolderFailure(code) ? "Check the output folder, its permissions and the connected drive before recording again."
    : isPermissionFailure(code) ? "Check recording permissions in System Settings. Relaunch if access was recently granted."
    : code === "display_unavailable" || code === "no_display" ? "Choose Primary display or another available screen."
    : code === "app_terminated" ? "The recording file may be incomplete. RecordStuff does not repair it, and starting again does not recover missing content."
    : "Check your recording settings before trying again. Starting again does not recover missing content.", language);
}
const persistenceWarnings: Record<PersistenceIssue, PlainMessageKey> = {
  io: "This reminder is not saved yet. RecordStuff keeps it and retries automatically. If this continues, check free disk space and access to the app's data folder. A force-quit loses unsaved reminders.",
  blocked: "The saved failure history could not be read or comes from a newer version, so RecordStuff will not overwrite it. This reminder is kept only until RecordStuff quits.",
  tooLarge: "The failure history is too large to save. Remove reviewed failures, then retry. Until then this reminder is kept only until RecordStuff quits.",
};
/** Only `io` promises automatic retry; freeing disk space does not fix every storage error. */
export const persistenceWarning = (issue: PersistenceIssue, language: Language): string => t(persistenceWarnings[issue], language);
export function failureOutcome(result: RecordingFailure, language: Language): string {
  return t(result.outcome === "pending" ? "Processing the recorded data… The file result is not yet confirmed."
    : result.outcome === "partial" ? "A partial recording was kept. It may not be playable."
    : result.outcome === "empty" ? "No recording content was kept."
    : "Could not confirm whether recording content was kept. Check the output folder.", language);
}
