/**
 * The edit view's owner in main (plan 085): which recording is being edited, its saved edit, the engine's plan for
 * it, and the export: admission, the owned temporary file, publication and clean-up.
 *
 * **The recording is never written.** It is opened only to read its identity (edit-store.ts); the engine opens it
 * read-only. The export goes to an owned temporary file in the same folder (`.<name>.recordstuff-export-<id>.part`,
 * hidden, so the Recordings tab does not list it), whose path is journalled in userData before the worker creates it.
 * It is published under a name nothing holds (`<name> (edited).mp4`, numbered past taken ones) only once the worker
 * finished and synced it, by a hard link that fails rather than replaces (or, on a volume without hard links, an
 * exclusive placeholder renamed over). Cancel, a worker crash, a full disk, a refused rename and quit remove only that
 * temporary file; one left by a crash is removed at the next launch, by its journalled path and owned name.
 *
 * **Admission.** One export at a time, and none while a recording or a Live preview runs, or one is being saved;
 * a session that starts during an export (the recording always wins) cancels it, and quit cancels it within the
 * worker's cancel bound.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../lib/atomic-file";
import { translate, type Language, type PlainMessageKey } from "../../shared/i18n";
import { MAX_EDIT_RANGES, normalizeRanges, type EditorChoice, type EditorExport, type EditorView, type EditRange, type ExportPlan } from "../../shared/editing";
import { EDIT_RECORD_VERSION, sameSource, sourceIdentity, type EditRecord, type EditStore, type SourceIdentity } from "./edit-store";
import { ExportFailure } from "./export-host";

/** Why an export cannot start now. */
export type ExportBlock = "recording" | "preview" | "saving" | "quitting";

/** What the export needs of the worker's supervisor (export-host.ts). */
export interface ExportRunner {
  inspect(request: { source: string; removed: Array<{ from: number; to: number }> }): Promise<ExportPlan>;
  export(request: { source: string; output: string; removed: Array<{ from: number; to: number }> }, progress: (fraction: number) => void): Promise<{ plan: ExportPlan; bytes: number }>;
  cancel(): void;
  closeIdle(): void;
  close(): void;
}

export interface EditingDeps {
  store: EditStore;
  runner: ExportRunner;
  /** A listed recording's path and name, by id. */
  find(id: string): { path: string; name: string } | undefined;
  /** Why an export cannot start now, if it cannot. */
  blocked(): ExportBlock | undefined;
  language(): Language;
  /** The view changed: Settings draws it again. */
  changed(): void;
  /** An export was published at `file`: the Recordings tab lists it. */
  published(file: string): void;
  reveal(file: string): void;
  /** In userData: the paths of exports in flight, removed at the next launch if a crash left them. */
  journal: string;
  log(message: string): void;
  /** File operations, for fault injection in tests. */
  files?: Partial<PublicationFiles>;
}

/** The file operations publication uses. */
export interface PublicationFiles {
  link(from: string, to: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
  exists(file: string): Promise<boolean>;
  /** Creates `file` empty, failing with EEXIST when anything holds the name; its inode, to know it again. */
  reserve(file: string): Promise<FileMark>;
  /** A file's inode and size, or none when nothing is there. */
  mark(file: string): Promise<FileMark | undefined>;
}

/** Which file a name holds, and how large it is. */
export interface FileMark { ino: number; dev: number; size: number }

const markOf = (stat: fs.Stats): FileMark => ({ ino: stat.ino, dev: stat.dev, size: stat.size });

const defaultFiles: PublicationFiles = {
  link: (from, to) => fs.promises.link(from, to),
  rename: (from, to) => fs.promises.rename(from, to),
  unlink: (file) => fs.promises.unlink(file),
  exists: (file) => fs.promises.lstat(file).then(() => true, () => false),
  reserve: async (file) => {
    const handle = await fs.promises.open(file, "wx");
    try { return markOf(await handle.stat()); } finally { await handle.close(); }
  },
  // Nothing there only when the system says so: any other failure is thrown, so nothing is taken as gone that is not.
  mark: (file) => fs.promises.lstat(file).then(markOf, (cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return undefined;
    throw cause;
  }),
};

/** Removes `file` only while it is still the empty placeholder `mark` names: never a file someone put there since. */
async function removePlaceholder(file: string, mark: FileMark, files: PublicationFiles, log: (message: string) => void): Promise<void> {
  const now = await files.mark(file).catch((cause: unknown) => {
    log(`editing: could not check the placeholder ${file}; left for the next launch: ${String(cause)}`);
    return mark;
  });
  if (!now) return;
  if (now.ino !== mark.ino || now.dev !== mark.dev || now.size !== 0) {
    log(`editing: ${file} is no longer the placeholder this export reserved; left alone`);
    return;
  }
  await files.unlink(file).catch((cause: unknown) => log(`editing: could not remove the placeholder ${file}: ${String(cause)}`));
}

/** An export's temporary file: hidden, in the recording's folder, named so only RecordStuff's own are ever removed. */
export const OWNED_PART = /^\..*\.recordstuff-export-[0-9a-f]{12}\.part$/;

export function partName(title: string): string {
  return `.${title}.recordstuff-export-${randomBytes(6).toString("hex")}.part`;
}

/** `<title> (edited).mp4`, then `<title> (edited 2).mp4` and on. */
export function editedName(title: string, attempt: number): string {
  return attempt <= 1 ? `${title} (edited).mp4` : `${title} (edited ${attempt}).mp4`;
}

const PUBLISH_ATTEMPTS = 100;
/** How long quit waits for a cancelled export to end: the worker's 1 s cancel bound and its clean-up. */
export const SHUTDOWN_BOUND_MS = 2000;

/**
 * Publishes `part` as the first free `<title> (edited…).mp4` beside it, never replacing a file: a hard link takes the
 * name only if it is free; a volume without hard links takes it with an exclusive create, then the file is renamed
 * over that empty placeholder. Returns the published path; on failure `part` is left for the caller to remove.
 */
export async function publish(
  part: string,
  title: string,
  files: PublicationFiles,
  log: (message: string) => void,
  /** Called with a placeholder's path before it is made, then with the inode made, so a crash's leftover can be found. */
  reserving: (target: string, mark?: FileMark) => Promise<void> = async () => undefined,
  /** Whether the export was cancelled meanwhile: nothing is published then. */
  cancelled: () => boolean = () => false,
): Promise<string> {
  const dir = path.dirname(part);
  const stop = (): never => { throw Object.assign(new Error("the export was cancelled before it was published"), { code: "ECANCELED" }); };
  for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt++) {
    const target = path.join(dir, editedName(title, attempt));
    if (await files.exists(target)) continue;
    if (cancelled()) stop();
    try {
      await files.link(part, target);
      await files.unlink(part).catch((cause: unknown) => log(`editing: ${part} stays beside ${target}: ${String(cause)}`));
      return target;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue;
      if (code === "ENOENT") throw cause;
      // No hard links on this volume (exFAT, some network shares): reserve the name, then move onto it.
      // Node has no rename that refuses to replace; the placeholder narrows the name's exposure to the instant between
      // the two calls, and only a file this export made is ever removed again.
      log(`editing: no hard link for ${part} (${code ?? String(cause)}); reserving ${target} first`);
      await reserving(target);
      let mark: FileMark;
      try {
        mark = await files.reserve(target);
      } catch (reserve) {
        if ((reserve as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw reserve;
      }
      try {
        await reserving(target, mark);
        if (cancelled()) stop();
        await files.rename(part, target);
        return target;
      } catch (move) {
        await removePlaceholder(target, mark, files, log);
        throw move;
      }
    }
  }
  throw Object.assign(new Error(`no free name for ${title} (edited) after ${PUBLISH_ATTEMPTS} tries`), { code: "EEXIST" });
}

/**
 * One thing an export in flight may leave: its temporary file (a path), or a placeholder it reserved on a volume without
 * hard links, with the inode it made once known. A placeholder whose inode is not recorded is never removed: it may be
 * someone else's file.
 */
export type JournalEntry = string | { placeholder: string; ino?: number; dev?: number };

const entryPath = (entry: JournalEntry): string => (typeof entry === "string" ? entry : entry.placeholder);

/** The journal of exports in flight. */
async function readJournal(file: string): Promise<JournalEntry[]> {
  try {
    const text = await fs.promises.readFile(file, "utf8");
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is JournalEntry => typeof entry === "string"
      || (typeof entry === "object" && entry !== null && typeof (entry as { placeholder?: unknown }).placeholder === "string")).slice(0, 64);
  } catch {
    return [];
  }
}

/**
 * At launch: removes what an export in flight left when RecordStuff ended (a crash or a forced quit), by the journal's
 * paths: a temporary file with an export's own name, or an empty placeholder (`<name> (edited…).mp4`) an export reserved
 * on a volume without hard links. Anything else is left alone. A path that could not be removed now (a drive away) stays
 * in the journal for the next launch; the rest leave it.
 */
export async function removeLeftovers(journal: string, log: (message: string) => void, files: Pick<PublicationFiles, "unlink" | "mark"> = defaultFiles): Promise<number> {
  const listed = await readJournal(journal);
  let removed = 0;
  const kept: JournalEntry[] = [];
  for (const entry of listed) {
    const file = entryPath(entry);
    if (!path.isAbsolute(file) || (typeof entry === "string" && !OWNED_PART.test(path.basename(file)))) {
      log(`editing: the journal names ${file}, which is not an export's own file; left alone`);
      continue;
    }
    if (typeof entry !== "string") {
      if (entry.ino === undefined || entry.dev === undefined) {
        log(`editing: ${file} was to be reserved when RecordStuff ended, so whose it is cannot be known; left alone`);
        continue;
      }
      let mark: FileMark | undefined;
      try {
        mark = await files.mark(file);
      } catch (cause) {
        log(`editing: could not check ${file} now; it stays in the journal for the next launch: ${String(cause)}`);
        kept.push(entry);
        continue;
      }
      // Published (it holds the export), gone, or another file now: nothing to do.
      if (!mark || mark.size !== 0 || mark.ino !== entry.ino || mark.dev !== entry.dev) continue;
    }
    try {
      await files.unlink(file);
      removed++;
      log(`editing: removed ${file}, left by an export that did not finish`);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
      log(`editing: could not remove ${file} now; it stays in the journal for the next launch: ${String(cause)}`);
      kept.push(entry);
    }
  }
  if (listed.length) {
    await writeFileAtomic(journal, `${JSON.stringify(kept)}\n`).catch((cause: unknown) => log(`editing: could not write the export journal: ${String(cause)}`));
  }
  return removed;
}

/** What the export leaves out, as the engine planned it: the requested ranges, and what fell back or was dropped. */
export function skippedRanges(plan: ExportPlan): EditRange[] {
  const out: EditRange[] = [];
  let at = 0;
  for (const part of [...plan.parts].sort((a, b) => a.start - b.start)) {
    if (part.start > at) out.push([at, part.start]);
    at = Math.max(at, part.stop);
  }
  if (at < plan.duration) out.push([at, plan.duration]);
  return out;
}

interface Open {
  id: string;
  path: string;
  name: string;
  state: EditorView["state"];
  reason?: string;
  identity?: SourceIdentity;
  /** The saved edit, or a stale or unreadable one kept as found. */
  record?: EditRecord;
  plan?: ExportPlan;
  saveFailure?: string;
  export: EditorExport;
}

/** An export from Export to its end: `started` once the worker has it; until then a cancel only stops it starting. */
interface ExportRun { part: string; promise: Promise<void>; cancelled: boolean; started: boolean }

export class Editing {
  private open: Open | undefined;
  /** Increases with each open, so an answer for an earlier one is dropped. */
  private generation = 0;
  private exportRun: ExportRun | undefined;
  private saving: Promise<void> = Promise.resolve();
  private readonly files: PublicationFiles;

  constructor(private readonly deps: EditingDeps) {
    this.files = { ...defaultFiles, ...deps.files };
  }

  /** Whether an export runs. */
  get exporting(): boolean {
    return this.exportRun !== undefined;
  }

  /** The edit view, while a recording is being edited. */
  view(): EditorView | undefined {
    const open = this.open;
    if (!open) return undefined;
    const language = this.deps.language();
    const plan = open.plan;
    const timescale = plan?.timescale ?? open.record?.timescale ?? 90_000;
    const duration = plan?.duration ?? 0;
    const block = this.blockReason();
    const message = open.state === "stale" ? translate("This recording has changed since it was edited, so its edit no longer fits it. Discard the edit to start again.", language)
      : open.state === "unreadable" ? translate("This recording's edit could not be read, or was saved by a newer version of RecordStuff. It is kept as it is; discard it to start again.", language)
        : open.state === "unsupported" ? translate("This recording cannot be cut: {reason}", language, { reason: open.reason ?? "" })
          : open.state === "missing" ? translate("This recording is no longer in the output folder.", language) : undefined;
    const seconds = (ticks: number): string => (ticks / timescale).toFixed(1);
    const notes: EditorView["notes"] = [];
    for (const part of plan?.parts ?? []) {
      if (part.fellBack) notes.push({ at: part.start / timescale, text: translate("Resumes {seconds} s later than marked, at the next key frame.", language, { seconds: seconds(part.start - part.requested) }) });
    }
    for (const dropped of plan?.dropped ?? []) {
      notes.push({ at: dropped.from / timescale, text: translate("A kept part of {seconds} s has no key frame to resume at and is left out.", language, { seconds: seconds(dropped.to - dropped.from) }) });
    }
    return {
      id: open.id,
      state: open.state,
      ...(message ? { message } : {}),
      timescale,
      duration,
      seconds: duration / timescale,
      frameRate: plan && duration > 0 ? plan.frames / (duration / timescale) : 30,
      removed: open.record && open.state === "ready" ? open.record.removed : [],
      skipped: open.state === "ready" && plan ? skippedRanges(plan) : [],
      revision: open.record?.revision ?? 0,
      notes,
      outputSeconds: (plan?.outputDuration ?? 0) / timescale,
      exportable: open.state === "ready" && !block && !this.exportRun && (open.record?.removed.length ?? 0) > 0,
      ...(block ? { blocked: block } : {}),
      export: open.export,
      ...(open.saveFailure ? { saveFailure: open.saveFailure } : {}),
    };
  }

  private blockReason(): string | undefined {
    const language = this.deps.language();
    switch (this.deps.blocked()) {
      case "recording": return translate("Export is unavailable while recording.", language);
      case "preview": return translate("Export is unavailable while the Recording Studio's Live preview runs.", language);
      case "saving": return translate("Export is unavailable while a recording is being saved.", language);
      case "quitting": return translate("RecordStuff is quitting.", language);
      default: return undefined;
    }
  }

  /** An edit view action for the recording `id`. */
  async choose(id: string, choice: EditorChoice): Promise<boolean> {
    switch (choice.action) {
      case "open": return this.openEditor(id);
      case "close": this.close(id); return true;
      case "save": return this.save(id, choice.removed, choice.revision);
      case "export": return this.startExport(id);
      case "cancelExport": return this.cancelExport(id);
      case "discard": return this.discard(id);
      case "reveal": return this.revealExport(id);
    }
  }

  private async openEditor(id: string): Promise<boolean> {
    const file = this.deps.find(id);
    if (!file) return false;
    if (this.exportRun && this.open?.id !== id) return false;
    if (this.open?.id === id) return true;
    const generation = ++this.generation;
    this.open = { id, path: file.path, name: file.name, state: "loading", export: { phase: "idle" } };
    this.deps.changed();
    const current = (): Open | undefined => (generation === this.generation && this.open?.id === id ? this.open : undefined);
    let identity: SourceIdentity;
    try {
      identity = await sourceIdentity(file.path);
    } catch (cause) {
      const open = current();
      if (!open) return false;
      open.state = (cause as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsupported";
      open.reason = String((cause as Error).message ?? cause);
      this.deps.changed();
      return true;
    }
    const loaded = await this.deps.store.load(file.path, identity);
    let open = current();
    if (!open) return this.abandoned();
    open.identity = identity;
    if (loaded.kind === "stale" || loaded.kind === "unreadable") {
      open.state = loaded.kind;
      if (loaded.kind === "stale") open.record = loaded.record;
      else this.deps.log(`editing: the edit of ${file.path} is unreadable: ${loaded.reason}`);
      this.deps.changed();
      return true;
    }
    const removed = loaded.kind === "ok" ? loaded.record.removed : [];
    try {
      const plan = await this.deps.runner.inspect({ source: file.path, removed: removed.map(([from, to]) => ({ from, to })) });
      open = current();
      if (!open) return this.abandoned();
      open.plan = plan;
      open.record = loaded.kind === "ok" ? loaded.record : { version: EDIT_RECORD_VERSION, source: identity, timescale: plan.timescale, removed: [], revision: 0 };
      open.state = "ready";
    } catch (cause) {
      open = current();
      if (!open) return this.abandoned();
      const failure = cause instanceof ExportFailure ? cause : undefined;
      open.state = "unsupported";
      open.reason = this.failureText(failure, "inspect");
      this.deps.log(`editing: ${file.path} cannot be edited: ${String(cause)}`);
    }
    this.deps.changed();
    return true;
  }

  /** An answer for a view closed meanwhile: the worker it kept busy goes, unless something else uses it. */
  private abandoned(): false {
    if (!this.open && !this.exportRun) this.deps.runner.closeIdle();
    return false;
  }

  /**
   * Whether the open recording is still the file its edit was made for; when it is not, the view shows its edit as
   * stale (offering Discard) and nothing is saved or exported against it.
   */
  private async stillSame(open: Open): Promise<boolean> {
    const now = await sourceIdentity(open.path).catch(() => undefined);
    if (now && open.identity && sameSource(now, open.identity)) return true;
    if (this.open === open) {
      this.deps.log(`editing: ${open.path} changed while its edit view was open`);
      open.state = now ? "stale" : "missing";
      this.deps.changed();
    }
    return false;
  }

  private close(id: string): void {
    if (this.open?.id !== id) return;
    // An export goes on to its end with the view closed; its outcome is in the log and the listing.
    if (this.exportRun) return;
    this.open = undefined;
    this.generation++;
    this.deps.runner.closeIdle();
    this.deps.changed();
  }

  private save(id: string, requested: EditRange[], revision: number): Promise<boolean> {
    // A save asked for after Export would change the edit the export takes: refused. One asked for before it runs
    // first, and the export waits for it.
    if (this.exportRun) return Promise.resolve(false);
    const run = this.saving.then(() => this.saveNow(id, requested, revision));
    this.saving = run.then(() => undefined, () => undefined);
    return run;
  }

  private async saveNow(id: string, requested: EditRange[], revision: number): Promise<boolean> {
    const open = this.open;
    if (!open || open.id !== id || open.state !== "ready" || !open.record || !open.identity || this.exportRun?.started) return false;
    if (revision !== open.record.revision) return false;
    if (!(await this.stillSame(open))) return false;
    const language = this.deps.language();
    const removed = normalizeRanges(requested).slice(0, MAX_EDIT_RANGES);
    let plan: ExportPlan;
    try {
      plan = await this.deps.runner.inspect({ source: open.path, removed: removed.map(([from, to]) => ({ from, to })) });
    } catch (cause) {
      if (this.open !== open) return this.abandoned();
      open.saveFailure = cause instanceof ExportFailure && cause.code === "nothing_kept"
        ? translate("At least one part of the recording must be kept.", language)
        : this.failureText(cause instanceof ExportFailure ? cause : undefined, "inspect");
      this.deps.changed();
      return false;
    }
    if (this.open !== open) return this.abandoned();
    const snapped: EditRange[] = plan.removed.map(({ from, to }) => [from, to]);
    const record: EditRecord = { version: EDIT_RECORD_VERSION, source: open.identity, timescale: plan.timescale, removed: snapped, revision: open.record.revision + 1 };
    try {
      await this.deps.store.save(record);
    } catch (cause) {
      this.deps.log(`editing: the edit of ${open.path} could not be saved: ${String(cause)}`);
      if (this.open !== open) return false;
      open.saveFailure = translate("The edit could not be saved. Check free disk space, then try again.", language);
      this.deps.changed();
      return false;
    }
    if (this.open !== open) return true;
    open.record = record;
    open.plan = plan;
    delete open.saveFailure;
    if (open.export.phase !== "exporting") open.export = { phase: "idle" };
    this.deps.changed();
    return true;
  }

  private async discard(id: string): Promise<boolean> {
    const open = this.open;
    if (!open || open.id !== id || this.exportRun) return false;
    try {
      await this.deps.store.discard(open.path);
    } catch (cause) {
      this.deps.log(`editing: the edit of ${open.path} could not be discarded: ${String(cause)}`);
      return false;
    }
    this.deps.log(`editing: discarded the edit of ${open.path}`);
    // Opened again from nothing.
    this.open = undefined;
    return this.openEditor(id);
  }

  private async startExport(id: string): Promise<boolean> {
    const open = this.open;
    if (!open || open.id !== id || open.state !== "ready" || !open.record || this.exportRun) return false;
    if (this.deps.blocked() || open.record.removed.length === 0) return false;
    const title = open.name.replace(/\.[^.]+$/, "");
    const part = path.join(path.dirname(open.path), partName(title));
    // Claimed before the first wait, so a second Export, a starting recording or quit all see it.
    const run: ExportRun = { part, cancelled: false, started: false, promise: Promise.resolve() };
    this.exportRun = run;
    const refuse = (): false => {
      if (this.exportRun === run) this.exportRun = undefined;
      this.deps.changed();
      return false;
    };
    // After the saves already asked for: the export takes the edit as saved, never one a save is replacing.
    await this.saving;
    if (this.open !== open || open.state !== "ready" || !open.record || run.cancelled || this.deps.blocked() || open.record.removed.length === 0) return refuse();
    if (!(await this.stillSame(open))) return refuse();
    if (run.cancelled || this.deps.blocked()) return refuse();
    const removed = open.record.removed.map(([from, to]) => ({ from, to }));
    try {
      await this.journal((entries) => [...entries, part]);
    } catch (cause) {
      this.deps.log(`editing: the export journal could not be written: ${String(cause)}`);
      open.export = { phase: "failed", message: translate("The export could not start. Check free disk space, then try again.", this.deps.language()) };
      return refuse();
    }
    if (run.cancelled) {
      await this.journal((entries) => entries.filter((entry) => entry !== part)).catch(() => undefined);
      return refuse();
    }
    run.started = true;
    open.export = { phase: "exporting", progress: 0, cancelling: false };
    this.deps.log(`editing: exporting ${open.path} without ${removed.length} range(s) into ${part}`);
    this.deps.changed();
    let lastShown = 0;
    const reserved: string[] = [];
    run.promise = (async () => {
      let outcome: EditorExport;
      let settledPaths: string[] = [];
      try {
        const result = await this.deps.runner.export({ source: open.path, output: part, removed }, (fraction) => {
          if (open.export.phase !== "exporting" || fraction - lastShown < 0.01) return;
          lastShown = fraction;
          open.export = { ...open.export, progress: fraction };
          this.deps.changed();
        });
        // Cancelled after the worker finished (a recording starting, quit): nothing is published.
        if (run.cancelled) throw new ExportFailure("cancelled", "the export was cancelled before it was published");
        const published = await publish(part, title, this.files, this.deps.log, async (target, mark) => {
          if (!reserved.includes(target)) reserved.push(target);
          const entry: JournalEntry = mark ? { placeholder: target, ino: mark.ino, dev: mark.dev } : { placeholder: target };
          await this.journal((entries) => [...entries.filter((e) => entryPath(e) !== target), entry]);
        }, () => run.cancelled);
        this.deps.log(`editing: exported ${open.path} as ${published} (${result.bytes} bytes)`);
        this.lastExport = published;
        this.deps.published(published);
        const name = path.basename(published);
        outcome = { phase: "done", name, message: translate("Exported as {name}.", this.deps.language(), { name }) };
        // The temporary name went with the link, unless its removal failed: then it stays journalled for the next launch.
        settledPaths = [...reserved, ...((await this.files.exists(part)) ? [] : [part])];
      } catch (cause) {
        let gone = true;
        await this.files.unlink(part).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          gone = false;
          this.deps.log(`editing: could not remove ${part} now; it stays in the journal for the next launch: ${String(error)}`);
        });
        // A placeholder was removed by publish, or holds someone else's file now: the journal forgets it either way
        // only when it is not an empty file this export left.
        for (const target of reserved) {
          const mark = await this.files.mark(target).catch(() => ({ size: 0 }) as FileMark);
          if (mark?.size !== 0) settledPaths.push(target);
        }
        if (gone) settledPaths.push(part);
        const failure = cause instanceof ExportFailure ? cause : undefined;
        this.deps.log(`editing: the export of ${open.path} ${failure?.code === "cancelled" ? "was cancelled" : `failed: ${String(cause)}`}`);
        const stopped = failure?.code === "cancelled" || run.cancelled || (cause as NodeJS.ErrnoException).code === "ECANCELED";
        outcome = stopped ? { phase: "idle" } : { phase: "failed", message: this.failureText(failure, "export") };
      }
      await this.journal((entries) => entries.filter((entry) => !settledPaths.includes(entryPath(entry)))).catch((cause: unknown) => this.deps.log(`editing: the export journal could not be written: ${String(cause)}`));
      this.exportRun = undefined;
      if (this.open === open) open.export = outcome;
      else this.deps.runner.closeIdle();
      this.deps.changed();
    })();
    return true;
  }

  private lastExport: string | undefined;

  private revealExport(id: string): boolean {
    if (this.open?.id !== id || !this.lastExport) return false;
    this.deps.reveal(this.lastExport);
    return true;
  }

  private cancelExport(id: string): boolean {
    const open = this.open;
    if (!this.exportRun || open?.id !== id || open.export.phase !== "exporting") return false;
    this.cancelRunning("the edit view");
    return true;
  }

  private cancelRunning(why: string): void {
    const run = this.exportRun;
    if (!run || run.cancelled) return;
    run.cancelled = true;
    this.deps.log(`editing: cancelling the export (${why})`);
    if (this.open?.export.phase === "exporting") this.open.export = { ...this.open.export, cancelling: true };
    if (run.started) this.deps.runner.cancel();
    this.deps.changed();
  }

  /** A recording or a Live preview is starting: it wins, and a running export is cancelled. */
  yieldToCapture(): void {
    this.cancelRunning("a recording or Live preview started");
  }

  /** Quit: cancels a running export and waits for it to end (the worker's cancel bound), then ends the worker. */
  async shutdown(): Promise<void> {
    const run = this.exportRun;
    if (run) {
      this.cancelRunning("quitting");
      // The worker ends within its own bound; a publication held up by a slow volume is not waited for longer than
      // this: its temporary file stays journalled, and the next launch removes it.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<void>((resolve) => { timer = setTimeout(resolve, SHUTDOWN_BOUND_MS); });
      await Promise.race([run.promise, bound]);
      if (timer) clearTimeout(timer);
    }
    this.deps.runner.close();
  }

  /**
   * A recording was renamed or moved to a category: its edit follows it. (Neither can happen while its edit view is
   * open, which is modal; a recording moved in Finder leaves the listing, and the page closes its view.)
   */
  moved(from: string, to: string): void {
    void this.deps.store.moved(from, to).catch((cause: unknown) => this.deps.log(`editing: the edit of ${from} did not follow it to ${to}: ${String(cause)}`));
  }

  private journalling: Promise<void> = Promise.resolve();

  /**
   * At launch, before anything else touches the journal: what a crash left is removed, in the journal's own queue, so
   * an export started meanwhile is journalled after it and never lost from it.
   */
  removeLeftovers(): Promise<void> {
    const cleaning = this.journalling.then(async () => { await removeLeftovers(this.deps.journal, this.deps.log, this.files); });
    this.journalling = cleaning.catch((cause: unknown) => this.deps.log(`editing: leftover exports not checked: ${String(cause)}`));
    return this.journalling;
  }

  private journal(change: (entries: JournalEntry[]) => JournalEntry[]): Promise<void> {
    const write = this.journalling.then(async () => {
      const entries = change(await readJournal(this.deps.journal));
      await writeFileAtomic(this.deps.journal, `${JSON.stringify(entries)}\n`, { syncDirectory: true });
    });
    this.journalling = write.catch(() => undefined);
    return write;
  }

  /** What the view says about a failed inspection or export, by its code. */
  private failureText(failure: ExportFailure | undefined, during: "inspect" | "export"): string {
    const language = this.deps.language();
    const t = (key: PlainMessageKey): string => translate(key, language);
    switch (failure?.code) {
      case "unsupported": return t("only recordings made by this version of RecordStuff can be cut.");
      case "malformed": return t("its index is damaged.");
      case "read_failed": return t("it could not be read.");
      case "disk_full": return t("The export stopped: the disk is full. Free some space, then export again.");
      case "output_write_failed": return t("The export could not be written to the recording's folder. Check the folder and the drive, then export again.");
      case "output_exists": return t("The export's file name was taken. Export again.");
      case "export_worker_crashed": case "export_worker_unresponsive":
        return during === "inspect" ? t("the export process stopped. Close the editor and try again.") : t("The export process stopped. The recording is unchanged; export again.");
      case "export_engine_missing": return t("the export engine could not be loaded.");
      case "encode_failed": return t("The export failed while encoding a join. The recording is unchanged; export again.");
      default: return during === "inspect" ? t("it could not be read.") : t("The export failed. The recording is unchanged; export again.");
    }
  }
}
