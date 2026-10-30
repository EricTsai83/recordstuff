/**
 * Sharing a recording (plan 100): which file leaves when a card is dragged, and the versions prepared ahead so the drag
 * has its file the moment the pointer goes down (macOS asks for it then).
 *
 * **What leaves.** A drag gives the Video, what the card plays: for a plain recording never edited, the file itself; for
 * an edited or editable one, a file made from the recording and its edit into the cache (version-cache.ts). ⌥-drag gives
 * the Original. Every version is made from the recording and its edit as they are when it is made, keyed by both, so a
 * version never goes stale: an edit makes the next one.
 *
 * **Preparing (D2).** The Video is prepared when the edit view closes and when an editable recording is saved, and on a
 * drag that finds it not ready (D1: the drag waits, the card shows the progress). One version at a time, in the export
 * worker, under the system's background policy. The edit view and quit cancel a running one (`paused`), taken up again
 * from the start once they are over; a recording, a Live preview, a save and the system's heat or Low Power Mode hold it
 * at its next picture instead, where it goes on from (plan 100 step 4, governor.ts, which during a recording follows the
 * recording's health where the Mac's class passed the gate).
 *
 * **Making a version.** A Video that needs no rendering is not rendered: an editable recording with no cut, the camera
 * absent and every sound as recorded is its screen and the sound players play copied without re-encoding. An edited
 * plain recording's Video is 085's remux; an editable one's 087's render. Sound only is the Video's sound copied; the
 * Sources are each track copied (D7); a plain recording's Original is a hard link to it under its outgoing name.
 */
import fs from "node:fs";
import path from "node:path";
import type { Language } from "../../shared/i18n";
import type { CopyTrack, CopyTracksRequest, ExportPlan, ExportRequest } from "../../shared/editing";
import { defaultScene, exportRender, fitScene, parseEditableDescription, VOLUME_INPUTS, volumeStretchesOf, type EditableDescription, type EditScene } from "../../shared/editable";
import { offeredVersions, recordingTitle, sourceFileName, sourceFiles, versionName, videoIsOriginal, type SourceRole, type VersionKind, type VersionSubject } from "../../shared/versions";
import { sourceIdentity, type EditRecord, type LoadedEdit, type SourceIdentity } from "../editing/edit-store";
import { ExportFailure } from "../editing/export-host";
import { versionKey, type CacheEntry, type VersionCache } from "./version-cache";

/** What preparing needs of the export worker's supervisor (export-host.ts). */
export interface SharingRunner {
  inspect(request: { source: string; removed: Array<{ from: number; to: number }> }): Promise<ExportPlan>;
  export(request: ExportRequest & { output: string }, progress: (fraction: number) => void): Promise<{ bytes: number }>;
  copyTracks(request: CopyTracksRequest, progress: (fraction: number) => void): Promise<number>;
  cancel(): void;
  closeIdle(): void;
  /** How a version being made runs now (plan 100 step 4): held at its next picture, one picture in the encoder at a time. */
  pace(held: boolean, careful: boolean): void;
}

export interface SharingDeps {
  cache: VersionCache;
  store: { load(source: string, identity: SourceIdentity): Promise<LoadedEdit> };
  runner: SharingRunner;
  /** Whether a file is an editable recording, by the description inside it (never by its name). */
  editable(source: string): Promise<boolean>;
  /**
   * Why preparing yields now (the edit view, quit), or undefined: a version being made is cancelled, to be made again.
   * A recording, a Live preview, a save and the system's conditions hold it instead (`pace`).
   */
  paused(): string | undefined;
  language(): Language;
  /** The cards' state changed: Settings draws again. */
  changed(): void;
  log(message: string): void;
  /** A hard link; tests make it fail as a volume without hard links does. */
  link?(from: string, to: string): Promise<void>;
}

/** `whenReady`'s answer when the version could not be made, as against the recording moving or going away. */
export class VersionFailed extends Error {}

/** What a card's Video is doing, for the Recordings tab: preparing (a fraction done) or failed. Absent: ready or not asked. */
export type VideoState = { state: "preparing"; progress: number } | { state: "failed" };

/** What a drag or a hand-out gives: a file to drag, or why there is none yet. */
export type HandOut = { file: string } | { preparing: true } | { failed: true };

interface Job {
  source: string;
  kind: VersionKind;
  progress: number;
  /** The recording's invalidation when it was asked for: one deleted since is not made again. */
  generation?: number;
}

/** The recording as a version is made from it: its bytes, its edit, and what it holds. */
interface Described {
  identity: SourceIdentity;
  /** An edit is held that cannot be read or was made for another file: what it removed is not known. */
  unknownEdit?: true;
  record?: EditRecord;
  subject: VersionSubject;
  description?: EditableDescription;
  scene?: EditScene;
  plan?: ExportPlan;
}

const jobId = (source: string, kind: VersionKind): string => `${kind}\n${source}`;

/** The edit a version is made from, as its key counts it: the cuts, and an editable recording's scene. */
function editOf(record: EditRecord | undefined): string {
  return record ? JSON.stringify({ removed: record.removed, scene: record.scene ?? null }) : "";
}

/** Every sound as recorded: each input at 100% and no stretch at a volume of its own. */
function soundsAsRecorded(scene: EditScene): boolean {
  return scene.volumes.system === 100 && scene.volumes.microphone === 100 && VOLUME_INPUTS.every((input) => volumeStretchesOf(scene, input).length === 0);
}

/**
 * Whether the picture and sound a version shows are the file's own screen and the sound players play, so it is those
 * two tracks copied: no cut, the camera left out, every sound as recorded, and the played track holding every input
 * (a mix, or one input alone).
 */
function copiable(described: Described, camera: boolean): boolean {
  const { description, scene, record } = described;
  if (!description || !scene || (record?.removed.length ?? 0) > 0 || !soundsAsRecorded(scene)) return false;
  if (camera && description.camera && scene.camera?.shown) return false;
  return description.mix === true || description.sounds.filter((sound) => sound !== "silent").length <= 1;
}

export class Sharing {
  private readonly queue: Job[] = [];
  private running: { job: Job; cancelled: boolean; done: Promise<void> } | undefined;
  /** Why the governor holds versions now (`pace`); none starts meanwhile. */
  private held: string | undefined;
  /** Versions that could not be made, by job, until asked again. */
  private readonly failed = new Set<string>();
  /** Renames and moves in the Recordings tab still under way: drags and listings wait for them (Codex pass 2). */
  private readonly moving = new Set<Promise<unknown>>();
  /** Bumped when a recording is deleted or leaves: a version made from it meanwhile is not kept (Codex F3). */
  private readonly invalidated = new Map<string, number>();

  constructor(private readonly deps: SharingDeps) {}

  /** The card's Video for the recording at `source`, when it is being prepared or could not be. */
  videoState(source: string): VideoState | undefined {
    const id = jobId(source, "video");
    if (this.running && jobId(this.running.job.source, this.running.job.kind) === id) return { state: "preparing", progress: this.running.job.progress };
    // Sound only waits on the Video: preparing it is preparing the Video too.
    if (this.queue.some((job) => job.source === source && (job.kind === "video" || job.kind === "sound"))) return { state: "preparing", progress: 0 };
    if (this.running?.job.source === source && this.running.job.kind === "sound") return { state: "preparing", progress: 0 };
    return this.failed.has(id) ? { state: "failed" } : undefined;
  }

  /**
   * Each version of the recording at `source` being prepared, or that could not be (plan 100 step 3, Share…): absent for
   * one ready or not asked for. Sound only waits on the Video it is made from, so it shows the Video's progress.
   */
  versionStates(source: string): Partial<Record<VersionKind, VideoState>> {
    const states: Partial<Record<VersionKind, VideoState>> = {};
    for (const job of this.queue) if (job.source === source) states[job.kind] = { state: "preparing", progress: 0 };
    if (this.running?.job.source === source) states[this.running.job.kind] = { state: "preparing", progress: this.running.job.progress };
    for (const id of this.failed) {
      const at = id.indexOf("\n");
      if (id.slice(at + 1) === source && !states[id.slice(0, at) as VersionKind]) states[id.slice(0, at) as VersionKind] = { state: "failed" };
    }
    return states;
  }

  /**
   * Share… opened for the recording at `source` (plan 100 step 3): every version it offers that is a file of its own
   * and not made yet is prepared, a clear sign it will be wanted.
   */
  async openShare(source: string): Promise<void> {
    await this.movesSettled();
    const described = await this.describeQuickly(source);
    if (described.unknownEdit) return;
    for (const kind of offeredVersions(described.subject)) {
      if (!needsMaking(described.subject, kind) || kind === "original") continue;
      if (!this.deps.cache.get(this.keyOf(described, kind))) this.prepare(source, kind);
    }
  }

  /**
   * The file `kind` of the recording at `source` leaves as, once it is ready: prepared first if it is not, waiting as
   * long as that takes (a recording in progress pauses it). Rejects when it could not be made.
   */
  async whenReady(source: string, kind: VersionKind): Promise<string> {
    for (;;) {
      const given = await this.handOut(source, kind);
      if ("file" in given) return given.file;
      if ("failed" in given) throw new VersionFailed(`the ${kind} of ${source} could not be made`);
      await new Promise<void>((resolve, reject) => {
        const id = jobId(source, kind);
        this.waiters.set(id, [...(this.waiters.get(id) ?? []), { resolve, reject }]);
      });
      if (this.failed.has(jobId(source, kind))) throw new VersionFailed(`the ${kind} of ${source} could not be made`);
    }
  }

  /** Those waiting for a version (`whenReady`), by job, told when it ends however it ends. */
  private readonly waiters = new Map<string, Array<{ resolve: () => void; reject: (cause: Error) => void }>>();

  private wake(id: string): void {
    const waiting = this.waiters.get(id);
    this.waiters.delete(id);
    for (const { resolve } of waiting ?? []) resolve();
  }

  /** Every recording with a version being prepared or that could not be, by path, with each version's state. */
  shareStates(): ReadonlyMap<string, Partial<Record<VersionKind, VideoState>>> {
    const sources = new Set([...this.queue.map((job) => job.source), ...(this.running ? [this.running.job.source] : []),
      ...[...this.failed].map((id) => id.slice(id.indexOf("\n") + 1))]);
    return new Map([...sources].map((source) => [source, this.versionStates(source)]));
  }

  /** Every recording whose Video is being prepared or could not be, by path. */
  videoStates(): ReadonlyMap<string, VideoState> {
    const states = new Map<string, VideoState>();
    const sources = new Set([...this.queue.map((job) => job.source), ...(this.running ? [this.running.job.source] : []),
      ...[...this.failed].map((id) => id.slice(id.indexOf("\n") + 1))]);
    for (const source of sources) {
      const state = this.videoState(source);
      if (state) states.set(source, state);
    }
    return states;
  }

  /** Prepares `kind` of the recording at `source` when it is not ready, after what is already waiting. */
  prepare(source: string, kind: VersionKind = "video"): void {
    const id = jobId(source, kind);
    this.failed.delete(id);
    if (this.running && jobId(this.running.job.source, this.running.job.kind) === id) return;
    if (this.queue.some((job) => jobId(job.source, job.kind) === id)) return;
    this.queue.push({ source, kind, progress: 0, generation: this.invalidated.get(source) ?? 0 });
    this.deps.changed();
    this.pump();
  }

  /** Whether a version is being made or waits to be: what makes Low Power Mode worth reading (plan 100 step 4). */
  get working(): boolean {
    return this.running !== undefined || this.queue.length > 0;
  }

  /** Settles once nothing is being made and nothing can start now (tests; quit). */
  async idle(): Promise<void> {
    while (this.running) await this.running.done;
  }

  /** Something that paused preparing has ended: the next version starts, if nothing else pauses it. */
  resume(): void {
    this.pump();
  }

  /**
   * The governor's pace (governor.ts, plan 100 step 4): while `held`, the version being made waits at its next picture,
   * keeping what it made, and none starts; `careful` while a recording runs. Let go, it goes on where it stopped.
   */
  pace(pace: { held?: string; careful: boolean }): void {
    this.held = pace.held;
    this.deps.runner.pace(pace.held !== undefined, pace.careful);
    if (!pace.held) this.pump();
  }

  /**
   * Something that pauses preparing has begun (a recording, a Live preview, the edit view, quit): the version being
   * made is cancelled and waits at the front of the queue to be made again.
   */
  yield(why: string): void {
    const running = this.running;
    if (!running || running.cancelled) return;
    running.cancelled = true;
    this.deps.log(`versions: pausing the ${running.job.kind} of ${running.job.source} (${why})`);
    this.deps.runner.cancel();
  }

  /** Quit: the version being made is cancelled and its unfinished files removed, within the worker's cancel bound. */
  async shutdown(boundMs = 2000): Promise<void> {
    this.queue.length = 0;
    const running = this.running;
    if (!running) return;
    this.yield("quitting");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([running.done, new Promise<void>((resolve) => { timer = setTimeout(resolve, boundMs); })]);
    if (timer) clearTimeout(timer);
  }

  /** A recording deleted, or gone from the folder: its versions go, held or not, and none is made for it. */
  async removed(source: string, why = "its recording was deleted"): Promise<void> {
    this.invalidated.set(source, (this.invalidated.get(source) ?? 0) + 1);
    this.drop(source);
    await this.deps.cache.removeSource(source, why);
  }

  /**
   * A rename or move in the Recordings tab, from before the file moves until its edit and versions have followed it:
   * the listing shows the new card before then, so a drag of it, or a listing that would take the old path for a deleted
   * recording, waits for it.
   */
  async during<T>(work: () => Promise<T>): Promise<T> {
    const running = work();
    this.moving.add(running);
    try { return await running; } finally { this.moving.delete(running); }
  }

  private async movesSettled(): Promise<void> {
    while (this.moving.size) await Promise.allSettled([...this.moving]);
  }

  /** A category folder renamed: the versions of the recordings directly in it follow them. */
  async folderMoved(from: string, to: string): Promise<void> {
    const folder = path.resolve(from);
    const inside = new Set([...this.queue.map((job) => job.source), ...this.deps.cache.sources()].filter((source) => path.dirname(source) === folder));
    for (const source of inside) await this.moved(source, path.join(to, path.basename(source)));
  }

  /**
   * Keeps versions only of recordings in the Recordings tab (plan 100): one gone from its path loses them at once, held
   * or not; one still on disk but outside the output folder `dir` (a folder changed, a drive's recording moved out) keeps
   * only those handed out in the last day, which a page may still be reading.
   */
  async sweep(dir: string): Promise<void> {
    await this.movesSettled();
    // Versions made, waiting or being made alike: one made after its recording left would stay (Codex review).
    const sources = new Set([...this.deps.cache.sources(), ...this.queue.map((job) => job.source), ...(this.running ? [this.running.job.source] : [])]);
    for (const source of sources) {
      const gone = await fs.promises.stat(source).then(() => false, (cause: NodeJS.ErrnoException) => cause.code === "ENOENT" || cause.code === "ENOTDIR");
      if (gone) await this.removed(source, "its recording is gone");
      else if (!inOutputFolder(dir, source)) {
        // Not made again: its jobs end for good, and what was handed out in the last day stays for a page still reading.
        this.invalidated.set(source, (this.invalidated.get(source) ?? 0) + 1);
        this.drop(source);
        await this.deps.cache.removeSource(source, "its recording is no longer in the output folder", true);
      }
    }
  }

  /** A recording renamed or moved in the Recordings tab: its versions follow it. */
  async moved(from: string, to: string): Promise<void> {
    for (const job of this.queue) if (job.source === from) job.source = to;
    // A Copy or Save waiting for one of its versions ends now: it asked for the file at a path the recording has left,
    // and nothing is ever given from that path again (Codex review: a running job wakes only its old id, and another
    // recording may come to the old path). Asked again, it is the recording at its new path.
    for (const [id, waiting] of [...this.waiters]) {
      if (!id.endsWith(`\n${from}`)) continue;
      this.waiters.delete(id);
      for (const { reject } of waiting) reject(new Error(`the recording moved from ${from} to ${to}`));
    }
    for (const id of [...this.failed]) if (id.endsWith(`\n${from}`)) { this.failed.delete(id); this.failed.add(id.replace(`\n${from}`, `\n${to}`)); }
    await this.deps.cache.moved(from, to);
  }

  private drop(source: string): void {
    let dropped = false;
    for (let index = this.queue.length - 1; index >= 0; index--) {
      const job = this.queue[index]!;
      if (job.source !== source) continue;
      this.queue.splice(index, 1);
      this.wake(jobId(job.source, job.kind));
      dropped = true;
    }
    // Its card no longer says it is being prepared, and what follows the work hears it ended (Codex F2).
    if (dropped) this.deps.changed();
    for (const id of [...this.failed]) if (id.endsWith(`\n${source}`)) this.failed.delete(id);
    if (this.running?.job.source === source) this.yield("its recording left the folder");
  }

  /**
   * The file `kind` of the recording at `source` leaves as, ready to drag: the recording itself where the version is it,
   * else a link to its cache entry under its outgoing name. One not made yet is prepared (D1) and the answer says so.
   */
  async handOut(source: string, kind: VersionKind): Promise<HandOut> {
    // A card just renamed or moved is offered before its edit has followed it: without it, it would read as unedited.
    await this.movesSettled();
    const described = await this.describeQuickly(source);
    const { subject } = described;
    // The recording as made: an editable original, or a plain recording never edited, whose Original is its Video.
    if (kind === "original" && (subject.editable || videoIsOriginal(subject))) return { file: source };
    // An edit that cannot be read, or one made for another file at this path, says the recording was edited but not
    // how: nothing made from it can be trusted to leave out what was removed, so only the Original leaves (Codex F1).
    if (described.unknownEdit) return { failed: true };
    if (!offeredVersions(subject).includes(kind)) return { failed: true };
    if (kind === "video" && videoIsOriginal(subject)) return { file: source };
    const entry = this.deps.cache.get(this.keyOf(described, kind));
    if (!entry) {
      // A plain recording's Original is a link, made now: there is nothing to wait for.
      if (kind === "original") {
        const made = await this.make({ source, kind, progress: 0 }, described).catch((cause: unknown) => {
          this.deps.log(`versions: no link to ${source} for its Original (${String(cause)}); giving the recording itself`);
          return undefined;
        });
        if (!made) return { file: source };
        return { file: await this.deps.cache.handOut(made, versionName(kind, subject, this.deps.language())) };
      }
      // Not ready (or failed before: asked again, it is tried again).
      this.prepare(source, kind);
      return { preparing: true };
    }
    const language = this.deps.language();
    // Each source was saved under what it holds (`screen.mp4`, `system.m4a`…), named now in the app's language.
    const files = kind === "sources"
      ? (await fs.promises.readdir(this.deps.cache.contentPath(entry))).flatMap((from) => {
        const role = from.replace(/\.[^.]+$/, "") as SourceRole;
        return ["screen", "camera", "system", "microphone"].includes(role) ? [{ from, name: sourceFileName(role, recordingTitle(subject.fileName), language) }] : [];
      })
      : undefined;
    return { file: await this.deps.cache.handOut(entry, versionName(kind, subject, language), files) };
  }

  /**
   * What a hand-out needs, without the export worker: the recording's identity, its edit, and whether it is editable.
   * Only the key and the subject's kind depend on it; the description is read when the version is made.
   */
  private async describeQuickly(source: string): Promise<Described> {
    const identity = await sourceIdentity(source);
    const loaded = await this.deps.store.load(source, identity);
    const record = loaded.kind === "ok" ? loaded.record : undefined;
    const unknownEdit = loaded.kind === "stale" || loaded.kind === "unreadable";
    const editable = await this.deps.editable(source);
    const subject: VersionSubject = {
      fileName: path.basename(source),
      edited: record !== undefined,
      // The camera and sounds only matter to which versions are offered; Sources and Video without the camera are
      // offered to every editable recording until its description is read.
      ...(editable ? { editable: { camera: true, sounds: [] } } : {}),
    };
    return { identity, ...(record ? { record } : {}), subject, ...(unknownEdit ? { unknownEdit: true as const } : {}) };
  }

  /** Reads the recording's description and plan through the worker, as making a version needs them. */
  private async describe(source: string): Promise<Described> {
    const quick = await this.describeQuickly(source);
    const removed = (quick.record?.removed ?? []).map(([from, to]) => ({ from, to }));
    const plan = await this.deps.runner.inspect({ source, removed });
    const description = plan.editable ? parseEditableDescription(plan.editable) : undefined;
    if (plan.editable && !description) throw new ExportFailure("malformed", "its editable description could not be read");
    if (!description) {
      const { editable: _none, ...plain } = quick.subject;
      return { ...quick, subject: plain, plan };
    }
    const scene = quick.record?.scene ? fitScene(quick.record.scene, description) : defaultScene(description);
    return {
      ...quick, plan, description, scene,
      subject: { ...quick.subject, editable: { camera: description.camera !== null, sounds: description.sounds, ...(description.mix ? { mix: true as const } : {}) } },
    };
  }

  private keyOf(described: Described, kind: VersionKind): string {
    const { identity, record } = described;
    return versionKey({ size: identity.size, mtimeMs: identity.mtimeMs, hash: identity.hash, edit: editOf(record), kind });
  }

  private pump(): void {
    if (this.running) return;
    const why = this.deps.paused() ?? this.held;
    if (why) return;
    const job = this.queue.shift();
    if (!job) return;
    const running = { job, cancelled: false, done: Promise.resolve() };
    this.running = running;
    running.done = this.run(running).finally(() => {
      if (this.running === running) this.running = undefined;
      // Requeued after a pause, it is still awaited; otherwise those waiting look again.
      if (!this.queue.some((queued) => jobId(queued.source, queued.kind) === jobId(job.source, job.kind))) this.wake(jobId(job.source, job.kind));
      this.deps.changed();
      if (this.queue.length) this.pump();
      // Nothing left: the worker goes, unless the edit view or anything else keeps it (closeIdle ends only an idle one).
      else if (!this.deps.paused()) this.deps.runner.closeIdle();
    });
  }

  private async run(running: { job: Job; cancelled: boolean }): Promise<void> {
    const { job } = running;
    const started = Date.now();
    try {
      const described = await this.describe(job.source);
      if (running.cancelled) throw new ExportFailure("cancelled", "paused before it began");
      if (described.unknownEdit) throw new ExportFailure("unsupported", "its edit cannot be read or was made for another file");
      // Nothing to make: the version is the recording itself. One it does not offer (a camera-free Video of a recording
      // without a camera) is refused for good, so whoever waits for it hears so (Codex review).
      if (!offeredVersions(described.subject).includes(job.kind)) throw new ExportFailure("unsupported", `the recording does not offer ${job.kind}`);
      if (!needsMaking(described.subject, job.kind)) return;
      if (this.deps.cache.get(this.keyOf(described, job.kind))) return;
      await this.make(job, described, () => running.cancelled);
      this.deps.log(`versions: prepared the ${job.kind} of ${job.source} in ${Date.now() - started} ms`);
    } catch (cause) {
      const cancelled = running.cancelled || (cause instanceof ExportFailure && cause.code === "cancelled");
      if (cancelled) {
        // Paused, not failed: it is made again, first, once nothing pauses it; a dropped recording's is not.
        if (running.cancelled && this.stillWanted(job)) this.queue.unshift({ ...job, progress: 0 });
        return;
      }
      this.failed.add(jobId(job.source, job.kind));
      this.deps.log(`versions: the ${job.kind} of ${job.source} could not be prepared: ${String(cause)}`);
    }
  }

  /** A paused job is taken up again unless its recording was dropped meanwhile. */
  private stillWanted(job: Job): boolean {
    return (this.invalidated.get(job.source) ?? 0) === (job.generation ?? 0) && fs.existsSync(job.source);
  }

  /** Makes `job`'s version into a new cache entry. */
  private async make(job: Job, described: Described, cancelled: () => boolean = () => false): Promise<CacheEntry> {
    const { source, kind } = job;
    const cache = this.deps.cache;
    const generation = this.invalidated.get(source) ?? 0;
    const pending = await cache.begin(this.keyOf(described, kind));
    let lastShown = 0;
    const progress = (fraction: number): void => {
      if (fraction - lastShown < 0.01) return;
      lastShown = fraction;
      job.progress = fraction;
      this.deps.changed();
    };
    try {
      let content: string;
      switch (kind) {
        case "video": case "screenOnly": {
          content = "content.mp4";
          await this.picture(described, kind === "video", path.join(pending.dir, content), progress);
          break;
        }
        case "sound": {
          content = "content.m4a";
          const output = path.join(pending.dir, content);
          // The Video's sound: the recording's own where the Video's sound is it, else the Video made first.
          if (videoIsOriginal(described.subject) || copiable(described, false)) {
            await this.deps.runner.copyTracks({ source, tracks: ["sound0"], output, background: true }, progress);
          } else {
            const video = cache.get(this.keyOf(described, "video")) ?? await this.make({ source, kind: "video", progress: 0 }, described, cancelled);
            if (cancelled()) throw new ExportFailure("cancelled", "paused");
            await this.deps.runner.copyTracks({ source: cache.contentPath(video), tracks: ["sound0"], output, background: true }, progress);
          }
          break;
        }
        case "original": {
          content = `content${path.extname(source) || ".mp4"}`;
          await (this.deps.link ?? ((from, to) => fs.promises.link(from, to)))(source, path.join(pending.dir, content));
          break;
        }
        case "sources": {
          content = "sources";
          const dir = path.join(pending.dir, content);
          await fs.promises.mkdir(dir);
          for (const file of sourceFiles(described.subject)) {
            if (cancelled()) throw new ExportFailure("cancelled", "paused");
            await this.deps.runner.copyTracks({ source, tracks: [file.track], output: path.join(dir, `${file.role}${trackExtension(file.track)}`), background: true }, () => undefined);
          }
          break;
        }
      }
      if (cancelled()) throw new ExportFailure("cancelled", "paused");
      const entry = await cache.commit(pending, { source, kind, content });
      // Deleted while it was being put into place: what was made from it goes with it.
      if ((this.invalidated.get(source) ?? 0) !== generation) {
        await cache.remove(entry.key, "its recording was deleted while it was made");
        throw new ExportFailure("cancelled", "its recording was deleted");
      }
      return entry;
    } catch (cause) {
      await cache.abandon(pending);
      throw cause;
    }
  }

  /**
   * The Video (with the camera where the edit shows it) or the Video without the camera, into `output`: the two tracks
   * copied where nothing changes them, else the edited plain recording's remux or the editable one's render.
   */
  private async picture(described: Described, withCamera: boolean, output: string, progress: (fraction: number) => void): Promise<void> {
    const source = described.identity.path;
    const removed = (described.record?.removed ?? []).map(([from, to]) => ({ from, to }));
    const { description, scene } = described;
    if (!description || !scene) {
      if (!withCamera) throw new ExportFailure("unsupported", "a plain recording's camera is part of its picture");
      await this.deps.runner.export({ source, output, removed, background: true }, progress);
      return;
    }
    const shown: EditScene = withCamera || !scene.camera ? scene : { ...scene, camera: { ...scene.camera, shown: false } };
    if (copiable({ ...described, scene: shown }, true)) {
      const tracks: CopyTrack[] = ["screen", "sound0"];
      await this.deps.runner.copyTracks({ source, tracks, output, background: true }, progress);
      return;
    }
    await this.deps.runner.export({ source, output, removed, render: exportRender(description, shown), background: true }, progress);
  }
}

/** Whether `kind` of `subject` is a file of its own, made into the cache: not the recording itself, and offered. */
function needsMaking(subject: VersionSubject, kind: VersionKind): boolean {
  if (!offeredVersions(subject).includes(kind)) return false;
  if (kind === "video" && videoIsOriginal(subject)) return false;
  return !(kind === "original" && subject.editable);
}

/** Whether `file` is a recording the Recordings tab lists: directly in the output folder `dir`, or in a folder of it. */
export function inOutputFolder(dir: string, file: string): boolean {
  const folder = path.dirname(path.resolve(file)), root = path.resolve(dir);
  return folder === root || path.dirname(folder) === root;
}

/** A copied track's extension: a picture's `.mp4`, a sound's `.m4a`. */
function trackExtension(track: CopyTrack): string {
  return track === "screen" || track === "camera" ? ".mp4" : ".m4a";
}
