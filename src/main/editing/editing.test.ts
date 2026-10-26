import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorView, ExportPlan, ExportRequest } from "../../shared/editing";
import { EditStore } from "./edit-store";
import { ExportFailure } from "./export-host";

vi.mock("electron", () => ({ utilityProcess: { fork: () => { throw new Error("not in tests"); } } }));

const { Editing, OWNED_PART, editedName, publish, removeLeftovers, skippedRanges } = await import("./editing");
type Deps = ConstructorParameters<typeof Editing>[0];

let dir: string;
let source: string;
let sourceHash: string;
const hash = (file: string): string => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** An editable recording's description (plan 087), as the engine writes it. */
const DESCRIPTION = JSON.stringify({ version: 1, sounds: ["system", "microphone"], camera: { width: 0.2, height: 0.3, rounding: 0.15, x: 0.97, y: 0.05, mirror: true } });

function planFor(removed: Array<{ from: number; to: number }>, editable?: string): ExportPlan {
  // Snapped to whole frames of 3000 ticks, as the engine does.
  const snap = (t: number): number => Math.round(t / 3000) * 3000;
  const snapped = removed.map(({ from, to }) => ({ from: snap(from), to: snap(to) })).filter(({ from, to }) => to > from);
  const gone = snapped.reduce((sum, r) => sum + r.to - r.from, 0);
  if (gone >= 900_000) throw new ExportFailure("nothing_kept", "every frame is removed");
  return {
    timescale: 90_000, duration: 900_000, outputDuration: 900_000 - gone, frames: 300, removed: snapped, dropped: [],
    parts: [{ requested: 0, start: 0, stop: 900_000, outStart: 0, fellBack: false, reencoded: false }], secondDescription: false, hasAudio: true,
    ...(editable ? { editable } : {}),
  };
}

/** A worker double: an export writes its file part way, then ends as `outcome` says. */
function runner(outcome: () => Promise<void> | void = () => undefined, editable?: string) {
  const calls = { cancel: 0, closeIdle: 0, close: 0 };
  let cancelled: (() => void) | undefined;
  return {
    calls,
    inspect: vi.fn(async ({ removed }: { removed: Array<{ from: number; to: number }> }) => planFor(removed, editable)),
    extract: vi.fn(async ({ track, output }: { source: string; track: string; output: string }) => {
      fs.writeFileSync(output, `the ${track}`, { flag: "wx" });
      return 9;
    }),
    export: vi.fn(async ({ output, removed }: ExportRequest & { output: string }, progress: (f: number) => void) => {
      // The worker creates its file only if it does not exist.
      fs.writeFileSync(output, "half an export", { flag: "wx" });
      progress(0.5);
      await new Promise<void>((resolve, reject) => {
        cancelled = () => reject(new ExportFailure("cancelled", "the export was cancelled"));
        Promise.resolve(outcome()).then(resolve, reject);
      });
      fs.writeFileSync(output, "a whole export");
      return { plan: planFor(removed), bytes: 14, reencodedFrames: 0, reencodedPackets: 0 };
    }),
    cancel: () => { calls.cancel++; cancelled?.(); },
    closeIdle: () => { calls.closeIdle++; },
    close: () => { calls.close++; },
  };
}

function setup(overrides: Partial<Deps> = {}, worker = runner()) {
  const views: Array<EditorView | undefined> = [];
  const published: string[] = [];
  const logs: string[] = [];
  let blocked: ReturnType<Deps["blocked"]>;
  const editing = new Editing({
    store: new EditStore(path.join(dir, "userData", "edits")),
    runner: worker,
    find: (id) => (id === "rec" && fs.existsSync(source) ? { path: source, name: path.basename(source) } : undefined),
    blocked: () => blocked,
    language: () => "en",
    changed: () => views.push(editing.view()),
    published: (file) => published.push(file),
    reveal: () => undefined,
    journal: path.join(dir, "userData", "edits", "exports-in-flight.json"),
    previewDir: path.join(dir, "userData", "edits", "preview"),
    log: (line) => logs.push(line),
    ...overrides,
  });
  return { editing, worker, views, published, logs, block: (reason: typeof blocked) => { blocked = reason; } };
}

/**
 * Waits for the export started by the last choice to settle. Bounded by time, not by a count of 5 ms sleeps, which a
 * loaded runner stretches and which gave up silently, leaving the next assertion to fail.
 */
async function settled(editing: InstanceType<typeof Editing>): Promise<void> {
  await vi.waitFor(() => expect(editing.exporting).toBe(false), { timeout: 5000, interval: 5 });
}

/** Files in the recording's folder, without the recording. */
const beside = (): string[] => fs.readdirSync(path.dirname(source)).filter((name) => name !== path.basename(source)).sort();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "editing-"));
  fs.mkdirSync(path.join(dir, "Movies"));
  source = path.join(dir, "Movies", "2026-10-24 10-00-00.mp4");
  fs.writeFileSync(source, Buffer.alloc(2 * 1024 * 1024 + 17, 3));
  sourceHash = hash(source);
});
afterEach(() => {
  expect(hash(source)).toBe(sourceHash);
  fs.rmSync(dir, { recursive: true, force: true });
});

async function editedOnce(ctx: ReturnType<typeof setup>): Promise<void> {
  expect(await ctx.editing.choose("rec", { action: "open" })).toBe(true);
  expect(await ctx.editing.choose("rec", { action: "save", removed: [[91_000, 179_000]], revision: ctx.editing.view()!.revision })).toBe(true);
}

describe("the edit view", () => {
  it("opens a recording with no edit, and saves each change snapped to frames with a new revision", async () => {
    const ctx = setup();
    await ctx.editing.choose("rec", { action: "open" });
    expect(ctx.editing.view()).toMatchObject({ state: "ready", removed: [], revision: 0, seconds: 10, exportable: false });
    await ctx.editing.choose("rec", { action: "save", removed: [[91_000, 179_000]], revision: 0 });
    expect(ctx.editing.view()).toMatchObject({ removed: [[90_000, 180_000]], revision: 1, outputSeconds: 9, exportable: true });
    // A change made against an older revision is refused.
    expect(await ctx.editing.choose("rec", { action: "save", removed: [], revision: 0 })).toBe(false);
    // Opened again, the edit is where it was left.
    ctx.editing.choose("rec", { action: "close" });
    await ctx.editing.choose("rec", { action: "open" });
    expect(ctx.editing.view()).toMatchObject({ removed: [[90_000, 180_000]], revision: 1 });
    expect(ctx.worker.calls.closeIdle).toBe(1);
  });

  it("keeps no record for an edit that changes nothing, and marks only recordings that hold one (2026-10-26)", async () => {
    const ctx = setup();
    const file = new EditStore(path.join(dir, "userData", "edits")).fileFor(source);
    await ctx.editing.choose("rec", { action: "open" });
    await ctx.editing.choose("rec", { action: "save", removed: [[91_000, 179_000]], revision: 0 });
    expect([fs.existsSync(file), ctx.editing.edited().get(source)]).toEqual([true, fs.statSync(source).size]);
    // Every cut kept again: the record goes and the mark with it; the view's revision goes on, so Undo saves again.
    await ctx.editing.choose("rec", { action: "save", removed: [], revision: 1 });
    expect([fs.existsSync(file), ctx.editing.edited().has(source), ctx.editing.view()!.revision]).toEqual([false, false, 2]);
    await ctx.editing.choose("rec", { action: "save", removed: [[91_000, 179_000]], revision: 2 });
    expect([fs.existsSync(file), ctx.editing.edited().has(source)]).toEqual([true, true]);
    // Renamed, the record follows and Settings draws again once it has, so the card at its new path is marked.
    ctx.editing.choose("rec", { action: "close" });
    const renamed = path.join(path.dirname(source), "Talk.mp4");
    fs.renameSync(source, renamed);
    const drawn = ctx.views.length;
    ctx.editing.moved(source, renamed);
    await vi.waitFor(() => expect(ctx.editing.edited().has(renamed)).toBe(true));
    expect(ctx.views.length).toBeGreaterThan(drawn);
    fs.renameSync(renamed, source);
    ctx.editing.moved(renamed, source);
    await vi.waitFor(() => expect(ctx.editing.edited().has(source)).toBe(true));
    // A new launch reads the marks from the records left.
    const later = setup();
    expect(later.editing.edited().size).toBe(0);
    await later.editing.scanEdits();
    expect(later.editing.edited().get(source)).toBe(fs.statSync(source).size);
  });

  it("refuses to remove everything, and says so", async () => {
    const ctx = setup();
    await ctx.editing.choose("rec", { action: "open" });
    expect(await ctx.editing.choose("rec", { action: "save", removed: [[0, 900_000]], revision: 0 })).toBe(false);
    expect(ctx.editing.view()).toMatchObject({ revision: 0, saveFailure: "At least one part of the recording must be kept." });
  });

  it("shows a file the engine refuses as one that cannot be cut", async () => {
    const worker = runner();
    worker.inspect.mockRejectedValue(new ExportFailure("unsupported", "sound packets that are not 1024 frames each"));
    const ctx = setup({}, worker);
    await ctx.editing.choose("rec", { action: "open" });
    expect(ctx.editing.view()).toMatchObject({ state: "unsupported", message: "This recording cannot be cut: only recordings made by this version of RecordStuff can be cut.", exportable: false });
  });

  it("shows a changed recording's edit as stale and offers to discard it, never touching the recording", async () => {
    const ctx = setup();
    await editedOnce(ctx);
    ctx.editing.choose("rec", { action: "close" });
    fs.appendFileSync(source, "more");
    sourceHash = hash(source);
    await ctx.editing.choose("rec", { action: "open" });
    expect(ctx.editing.view()).toMatchObject({ state: "stale", removed: [], exportable: false });
    expect(await ctx.editing.choose("rec", { action: "save", removed: [[0, 3000]], revision: 1 })).toBe(false);
    await ctx.editing.choose("rec", { action: "discard" });
    expect(ctx.editing.view()).toMatchObject({ state: "ready", removed: [], revision: 0 });
  });
});

describe("an export", () => {
  it("is named in the app's language, numbered past a taken name", async () => {
    const ctx = setup({ language: () => "zh-TW" });
    await editedOnce(ctx);
    fs.writeFileSync(path.join(dir, "Movies", "2026-10-24 10-00-00（已編輯）.mp4"), "someone's own file");
    expect(await ctx.editing.choose("rec", { action: "export" })).toBe(true);
    await settled(ctx.editing);
    expect(ctx.editing.view()?.export).toEqual({ phase: "done", name: "2026-10-24 10-00-00（已編輯 2）.mp4", message: "已匯出為 2026-10-24 10-00-00（已編輯 2）.mp4。" });
    expect(fs.readFileSync(path.join(dir, "Movies", "2026-10-24 10-00-00（已編輯）.mp4"), "utf8")).toBe("someone's own file");
    expect(fs.readFileSync(path.join(dir, "Movies", "2026-10-24 10-00-00（已編輯 2）.mp4"), "utf8")).toBe("a whole export");
  });

  it("is published beside the recording as <name> (edited).mp4, numbered past taken names, never over them", async () => {
    const ctx = setup();
    await editedOnce(ctx);
    fs.writeFileSync(path.join(dir, "Movies", "2026-10-24 10-00-00 (edited).mp4"), "someone's own file");
    expect(await ctx.editing.choose("rec", { action: "export" })).toBe(true);
    expect(ctx.editing.view()?.export.phase).toBe("exporting");
    await settled(ctx.editing);
    expect(ctx.editing.view()?.export).toEqual({ phase: "done", name: "2026-10-24 10-00-00 (edited 2).mp4", message: "Exported as 2026-10-24 10-00-00 (edited 2).mp4." });
    expect(fs.readFileSync(path.join(dir, "Movies", "2026-10-24 10-00-00 (edited).mp4"), "utf8")).toBe("someone's own file");
    expect(fs.readFileSync(path.join(dir, "Movies", "2026-10-24 10-00-00 (edited 2).mp4"), "utf8")).toBe("a whole export");
    expect(beside()).toEqual(["2026-10-24 10-00-00 (edited 2).mp4", "2026-10-24 10-00-00 (edited).mp4"]);
    expect(ctx.published).toEqual([path.join(dir, "Movies", "2026-10-24 10-00-00 (edited 2).mp4")]);
    // The journal names nothing in flight any more.
    expect(JSON.parse(fs.readFileSync(path.join(dir, "userData", "edits", "exports-in-flight.json"), "utf8"))).toEqual([]);
  });

  for (const [what, failure, phase] of [
    ["a worker crash", new ExportFailure("export_worker_crashed", "the export worker exited with 139"), "failed"],
    ["a full disk", new ExportFailure("disk_full", "writing the export: No space left on device"), "failed"],
    ["a cancel", new ExportFailure("cancelled", "the export was cancelled"), "idle"],
  ] as const) {
    it(`that ends with ${what} leaves only the recording, as it was`, async () => {
      const ctx = setup({}, runner(() => { throw failure; }));
      await editedOnce(ctx);
      await ctx.editing.choose("rec", { action: "export" });
      await settled(ctx.editing);
      expect(ctx.editing.view()?.export.phase).toBe(phase);
      expect(beside()).toEqual([]);
      expect(ctx.published).toEqual([]);
    });
  }

  it("that cannot be published (a refused link and rename) removes its file and reports it", async () => {
    const refuse = async (): Promise<void> => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); };
    const ctx = setup({ files: { link: refuse, rename: refuse } });
    await editedOnce(ctx);
    await ctx.editing.choose("rec", { action: "export" });
    await settled(ctx.editing);
    expect(ctx.editing.view()?.export).toMatchObject({ phase: "failed" });
    expect(beside()).toEqual([]);
  });

  it("is cancelled by the edit view's Cancel export", async () => {
    let release!: () => void;
    const ctx = setup({}, runner(() => new Promise<void>((resolve) => { release = resolve; })));
    await editedOnce(ctx);
    await ctx.editing.choose("rec", { action: "export" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(await ctx.editing.choose("rec", { action: "cancelExport" })).toBe(true);
    expect(ctx.editing.view()?.export).toMatchObject({ phase: "exporting", cancelling: true });
    await settled(ctx.editing);
    expect(ctx.editing.view()?.export.phase).toBe("idle");
    expect(beside()).toEqual([]);
  });

  it("is not published when cancelled after the worker finished", async () => {
    let finished!: () => void;
    const worker = runner(() => new Promise<void>((resolve) => { finished = resolve; }));
    let slow!: () => void;
    // Publication waits on the file system, as a slow volume would.
    const ctx = setup({ files: { exists: async (file: string) => { await new Promise<void>((resolve) => { slow = resolve; }); return fs.existsSync(file); } } }, worker);
    await editedOnce(ctx);
    await ctx.editing.choose("rec", { action: "export" });
    await vi.waitFor(() => expect(finished).toBeTypeOf("function"));
    finished();
    await vi.waitFor(() => expect(slow).toBeTypeOf("function"));
    ctx.editing.yieldToCapture();
    slow();
    await settled(ctx.editing);
    expect(ctx.editing.view()?.export.phase).toBe("idle");
    expect(beside()).toEqual([]);
    expect(ctx.published).toEqual([]);
  });

  it("started while the launch's clean-up runs is journalled after it, never lost from it", async () => {
    const journal = path.join(dir, "userData", "edits", "exports-in-flight.json");
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(journal, JSON.stringify([path.join(dir, "Movies", ".old.recordstuff-export-aaaaaaaaaaaa.part")]));
    let release!: () => void;
    const ctx = setup({}, runner(() => new Promise<void>((resolve) => { release = resolve; })));
    void ctx.editing.removeLeftovers();
    await editedOnce(ctx);
    await ctx.editing.choose("rec", { action: "export" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const entries = JSON.parse(fs.readFileSync(journal, "utf8")) as string[];
    expect(entries).toHaveLength(1);
    expect(OWNED_PART.test(path.basename(entries[0]!))).toBe(true);
    expect(entries[0]).not.toContain(".old.");
    release();
    await settled(ctx.editing);
  });

  it("gives way to a recording or Live preview that starts, and to quit", async () => {
    for (const end of ["capture", "quit"] as const) {
      let release!: () => void;
      const ctx = setup({}, runner(() => new Promise<void>((resolve) => { release = resolve; })));
      await editedOnce(ctx);
      await ctx.editing.choose("rec", { action: "export" });
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      if (end === "capture") ctx.editing.yieldToCapture();
      else await ctx.editing.shutdown();
      await settled(ctx.editing);
      expect(ctx.worker.calls.cancel).toBe(1);
      expect(beside()).toEqual([]);
      if (end === "quit") expect(ctx.worker.calls.close).toBe(1);
      ctx.editing.choose("rec", { action: "close" });
    }
  });

  it("does not start while recording, previewing, saving or quitting, and says why", async () => {
    const ctx = setup();
    await editedOnce(ctx);
    for (const [reason, text] of [
      ["recording", "Export is unavailable while recording."],
      ["preview", "Export is unavailable while the Recording Studio's Live preview runs."],
      ["saving", "Export is unavailable while a recording is being saved."],
      ["quitting", "RecordStuff is quitting."],
    ] as const) {
      ctx.block(reason);
      expect(ctx.editing.view()).toMatchObject({ exportable: false, blocked: text });
      expect(await ctx.editing.choose("rec", { action: "export" })).toBe(false);
    }
    expect(ctx.worker.export).not.toHaveBeenCalled();
  });

  it("claims its place before its first wait, so a second Export and a starting recording see it", async () => {
    let release!: () => void;
    const ctx = setup({}, runner(() => new Promise<void>((resolve) => { release = resolve; })));
    await editedOnce(ctx);
    const first = ctx.editing.choose("rec", { action: "export" });
    const second = ctx.editing.choose("rec", { action: "export" });
    expect(await second).toBe(false);
    expect(await first).toBe(true);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await settled(ctx.editing);
    expect(ctx.worker.export).toHaveBeenCalledTimes(1);
    // A recording starting while Export prepares: the export never starts.
    const again = ctx.editing.choose("rec", { action: "export" });
    ctx.editing.yieldToCapture();
    expect(await again).toBe(false);
    expect(ctx.worker.export).toHaveBeenCalledTimes(1);
    expect(beside()).toEqual(["2026-10-24 10-00-00 (edited).mp4"]);
  });

  it("takes the edit as saved by the saves asked for before it, and refuses one asked for after", async () => {
    const ctx = setup();
    await editedOnce(ctx);
    const saving = ctx.editing.choose("rec", { action: "save", removed: [[90_000, 180_000], [600_000, 900_000]], revision: 1 });
    const exporting = ctx.editing.choose("rec", { action: "export" });
    expect(await ctx.editing.choose("rec", { action: "save", removed: [], revision: 2 })).toBe(false);
    expect(await saving).toBe(true);
    expect(await exporting).toBe(true);
    await settled(ctx.editing);
    expect(ctx.worker.export.mock.calls[0]![0].removed).toEqual([{ from: 90_000, to: 180_000 }, { from: 600_000, to: 900_000 }]);
  });

  it("is refused, and the edit shown stale, when the recording changed while its view was open", async () => {
    const ctx = setup();
    await editedOnce(ctx);
    fs.appendFileSync(source, "replaced");
    sourceHash = hash(source);
    expect(await ctx.editing.choose("rec", { action: "export" })).toBe(false);
    expect(ctx.editing.view()).toMatchObject({ state: "stale", exportable: false });
    expect(ctx.worker.export).not.toHaveBeenCalled();
    expect(await ctx.editing.choose("rec", { action: "save", removed: [], revision: 1 })).toBe(false);
  });

  it("runs one at a time", async () => {
    let release!: () => void;
    const ctx = setup({}, runner(() => new Promise<void>((resolve) => { release = resolve; })));
    await editedOnce(ctx);
    expect(await ctx.editing.choose("rec", { action: "export" })).toBe(true);
    expect(await ctx.editing.choose("rec", { action: "export" })).toBe(false);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await settled(ctx.editing);
    expect(ctx.worker.export).toHaveBeenCalledTimes(1);
  });
});

describe("the edit view's worker", () => {
  it("is released when the view closed while its plan was being made", async () => {
    let answer!: (plan: ExportPlan) => void;
    const worker = runner();
    worker.inspect.mockImplementationOnce(() => new Promise<ExportPlan>((resolve) => { answer = resolve; }));
    const ctx = setup({}, worker);
    const opening = ctx.editing.choose("rec", { action: "open" });
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    ctx.editing.choose("rec", { action: "close" });
    expect(worker.calls.closeIdle).toBe(1);
    answer(planFor([]));
    expect(await opening).toBe(false);
    expect(worker.calls.closeIdle).toBe(2);
  });
});

describe("what the preview skips", () => {
  it("is what the export leaves out: a later key-frame resume and a dropped part included", () => {
    const plan = { ...planFor([]), parts: [
      { requested: 0, start: 0, stop: 90_000, outStart: 0, fellBack: false, reencoded: false },
      { requested: 225_000, start: 270_000, stop: 450_000, outStart: 90_000, fellBack: true, reencoded: false },
    ], dropped: [{ from: 500_000, to: 520_000 }] };
    expect(skippedRanges(plan)).toEqual([[90_000, 270_000], [450_000, 900_000]]);
  });
});

describe("publication", () => {
  const files = () => ({
    link: (from: string, to: string) => fs.promises.link(from, to),
    rename: (from: string, to: string) => fs.promises.rename(from, to),
    unlink: (file: string) => fs.promises.unlink(file),
    exists: (file: string) => fs.promises.lstat(file).then(() => true, () => false),
    reserve: async (file: string) => {
      const handle = await fs.promises.open(file, "wx");
      try { const stat = await handle.stat(); return { ino: stat.ino, dev: stat.dev, size: stat.size }; } finally { await handle.close(); }
    },
    mark: (file: string) => fs.promises.lstat(file).then((stat) => ({ ino: stat.ino, dev: stat.dev, size: stat.size }), () => undefined),
  });

  it("names exports (edited), then (edited 2) and on, in the app's language", () => {
    expect(editedName("Talk", 1)).toBe("Talk (edited).mp4");
    expect(editedName("Talk", 3)).toBe("Talk (edited 3).mp4");
    expect(editedName("Talk", 1, "zh-TW")).toBe("Talk（已編輯）.mp4");
    expect(editedName("Talk", 2, "zh-TW")).toBe("Talk（已編輯 2）.mp4");
    // A title is taken as it is, never as a placeholder.
    expect(editedName("{number} {title}", 2, "zh-TW")).toBe("{number} {title}（已編輯 2）.mp4");
  });

  it("counts an export edited again on from its source's title, whichever language named it", () => {
    for (const title of ["Talk（已編輯）", "Talk（已編輯 2）", "Talk (edited)", "Talk (edited 12)"]) {
      expect(editedName(title, 1, "zh-TW"), title).toBe("Talk（已編輯）.mp4");
      expect(editedName(title, 3), title).toBe("Talk (edited 3).mp4");
    }
    // Only the ending: an edited word inside the title, or an ending that is not one, stays.
    expect(editedName("Talk (edited) notes", 1)).toBe("Talk (edited) notes (edited).mp4");
    expect(editedName("Talk (edited two)", 1)).toBe("Talk (edited two) (edited).mp4");
    expect(editedName("Talk(edited)", 1)).toBe("Talk(edited) (edited).mp4");
    // A title that is nothing but the ending keeps it, so the name is never empty.
    expect(editedName("（已編輯）", 1, "zh-TW")).toBe("（已編輯）（已編輯）.mp4");
  });

  it("publishes an export edited again as its source's next free name", async () => {
    const part = path.join(dir, "Movies", ".Talk（已編輯）.recordstuff-export-0123456789ab.part");
    fs.writeFileSync(part, "export");
    fs.writeFileSync(path.join(dir, "Movies", "Talk（已編輯）.mp4"), "first");
    const published = await publish(part, "Talk（已編輯）", files(), () => undefined, undefined, undefined, "zh-TW");
    expect(path.basename(published)).toBe("Talk（已編輯 2）.mp4");
    expect(fs.readFileSync(path.join(dir, "Movies", "Talk（已編輯）.mp4"), "utf8")).toBe("first");
  });

  it("on a volume without hard links reserves the name first, then moves the file onto it", async () => {
    const part = path.join(dir, "Movies", ".Talk.recordstuff-export-0123456789ab.part");
    fs.writeFileSync(part, "export");
    const noLinks = { ...files(), link: async () => { throw Object.assign(new Error("ENOTSUP"), { code: "ENOTSUP" }); } };
    const published = await publish(part, "Talk", noLinks, () => undefined);
    expect(path.basename(published)).toBe("Talk (edited).mp4");
    expect(fs.readFileSync(published, "utf8")).toBe("export");
    expect(fs.existsSync(part)).toBe(false);
  });

  it("removes its placeholder after a refused rename only while it is still its own empty file", async () => {
    const part = path.join(dir, "Movies", ".Talk.recordstuff-export-0123456789ab.part");
    fs.writeFileSync(part, "export");
    const target = path.join(dir, "Movies", "Talk (edited).mp4");
    for (const replaced of [false, true]) {
      const refusing = {
        ...files(),
        link: async () => { throw Object.assign(new Error("ENOTSUP"), { code: "ENOTSUP" }); },
        rename: async () => {
          if (replaced) { fs.rmSync(target); fs.writeFileSync(target, "someone's file"); }
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
      };
      await expect(publish(part, "Talk", refusing, () => undefined)).rejects.toMatchObject({ code: "EACCES" });
      expect(fs.existsSync(target)).toBe(replaced);
      if (replaced) expect(fs.readFileSync(target, "utf8")).toBe("someone's file");
    }
  });

  it("takes the next name when one appears between the check and the link", async () => {
    const part = path.join(dir, "Movies", ".Talk.recordstuff-export-0123456789ab.part");
    fs.writeFileSync(part, "export");
    let raced = false;
    const racing = {
      ...files(),
      link: async (from: string, to: string) => {
        if (!raced) { raced = true; fs.writeFileSync(to, "arrived first"); }
        return fs.promises.link(from, to);
      },
    };
    const published = await publish(part, "Talk", racing, () => undefined);
    expect(path.basename(published)).toBe("Talk (edited 2).mp4");
    expect(fs.readFileSync(path.join(dir, "Movies", "Talk (edited).mp4"), "utf8")).toBe("arrived first");
  });
});

describe("leftovers at launch", () => {
  it("are an export's own files named in the journal; nothing else is removed", async () => {
    const journal = path.join(dir, "userData", "exports-in-flight.json");
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    const owned = path.join(dir, "Movies", ".Talk.recordstuff-export-0123456789ab.part");
    const notOwned = path.join(dir, "Movies", "Talk.mp4");
    fs.writeFileSync(owned, "half");
    fs.writeFileSync(notOwned, "a recording");
    fs.writeFileSync(journal, JSON.stringify([owned, notOwned, "relative.part", path.join(dir, "Movies", ".gone.recordstuff-export-aaaaaaaaaaaa.part")]));
    const logs: string[] = [];
    expect(await removeLeftovers(journal, (line) => logs.push(line))).toBe(1);
    expect(fs.existsSync(owned)).toBe(false);
    expect(fs.readFileSync(notOwned, "utf8")).toBe("a recording");
    expect(JSON.parse(fs.readFileSync(journal, "utf8"))).toEqual([]);
    expect(logs.filter((line) => line.includes("left alone"))).toHaveLength(2);
    expect(OWNED_PART.test(path.basename(owned))).toBe(true);
  });

  it("keep a path that cannot be removed or checked now, and remove only a placeholder that is still the export's own empty file", async () => {
    const journal = path.join(dir, "userData", "exports-in-flight.json");
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    const movies = path.join(dir, "Movies");
    const held = path.join(movies, ".Talk.recordstuff-export-0123456789ab.part");
    const own = path.join(movies, "Talk (edited).mp4");
    const published = path.join(movies, "Talk (edited 2).mp4");
    const replaced = path.join(movies, "Talk (edited 3).mp4");
    const unknown = path.join(movies, "Talk (edited 4).mp4");
    const unreadable = path.join(movies, "Talk (edited 5).mp4");
    for (const file of [held, own, replaced, unknown, unreadable]) fs.writeFileSync(file, file === held ? "half" : "");
    fs.writeFileSync(published, "an export");
    const inode = (file: string) => { const stat = fs.statSync(file); return { ino: stat.ino, dev: stat.dev }; };
    const ownMark = inode(own), replacedMark = inode(replaced);
    // Someone else's empty file now stands where the export's placeholder was.
    fs.rmSync(replaced);
    fs.writeFileSync(path.join(movies, "spacer"), "x".repeat(4096));
    fs.writeFileSync(replaced, "");
    fs.writeFileSync(journal, JSON.stringify([
      held,
      { placeholder: own, ...ownMark },
      { placeholder: published, ...inode(published) },
      { placeholder: replaced, ...replacedMark },
      { placeholder: unknown },
      { placeholder: unreadable, ...inode(unreadable) },
    ]));
    const faulty = {
      unlink: async (file: string) => {
        if (file === held) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        await fs.promises.unlink(file);
      },
      mark: async (file: string) => {
        if (file === unreadable) throw Object.assign(new Error("EIO"), { code: "EIO" });
        const stat = await fs.promises.lstat(file).catch(() => undefined);
        return stat && { ino: stat.ino, dev: stat.dev, size: stat.size };
      },
    };
    expect(await removeLeftovers(journal, () => undefined, faulty)).toBe(1);
    expect([held, own, published, replaced, unknown, unreadable].map((file) => fs.existsSync(file))).toEqual([true, false, true, true, true, true]);
    expect(JSON.parse(fs.readFileSync(journal, "utf8"))).toEqual([held, { placeholder: unreadable, ...inode(unreadable) }]);
  });

  it("are nothing without a journal", async () => {
    expect(await removeLeftovers(path.join(dir, "missing.json"), () => undefined)).toBe(0);
  });
});

describe("an editable recording (plan 087)", () => {
  const previews = (): string[] => (fs.existsSync(path.join(dir, "userData", "edits", "preview")) ? fs.readdirSync(path.join(dir, "userData", "edits", "preview")).sort() : []);
  const record = (): Record<string, unknown> => {
    const edits = path.join(dir, "userData", "edits");
    const file = fs.readdirSync(edits).find((name) => name.endsWith(".json") && name !== "exports-in-flight.json")!;
    return JSON.parse(fs.readFileSync(path.join(edits, file), "utf8")) as Record<string, unknown>;
  };
  const ready = async (ctx: ReturnType<typeof setup>): Promise<void> => {
    await vi.waitFor(() => expect(Object.keys(ctx.editing.view()?.editable?.preview ?? {}).length).toBeGreaterThanOrEqual(2), { timeout: 5000, interval: 5 });
  };

  it("opens where the recording left the camera and the volumes, can be exported with no cut, and prepares its preview", async () => {
    const ctx = setup({}, runner(undefined, DESCRIPTION));
    await ctx.editing.choose("rec", { action: "open" });
    await ready(ctx);
    const view = ctx.editing.view()!;
    expect(view).toMatchObject({ state: "ready", removed: [], exportable: true });
    expect(view.editable).toMatchObject({
      sounds: ["system", "microphone"],
      camera: { rounding: 0.15, mirror: true },
      scene: { camera: { x: 0.97, y: 0.05, width: 0.2, height: 0.3, shown: true }, volumes: { system: 100, microphone: 100 } },
      // Where Reset goes back to: as the recording left it.
      recorded: { camera: { x: 0.97, y: 0.05, width: 0.2, height: 0.3, shown: true }, volumes: { system: 100, microphone: 100 } },
    });
    // Its camera and its second sound, copied for the page; served only at this view's addresses.
    const { camera, secondSound } = view.editable!.preview;
    expect(camera).toMatch(/^recordstuff-media:\/\/preview\/\d+\/camera$/);
    expect(secondSound).toMatch(/\/secondSound$/);
    expect(previews()).toHaveLength(2);
    const response = await ctx.editing.previewResponse(new Request(camera!))!;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("the camera");
    expect((await ctx.editing.previewResponse(new Request(camera!.replace(/preview\/\d+/, "preview/999")))!).status).toBe(404);
    expect(ctx.editing.previewResponse(new Request("recordstuff-media://video/rec"))).toBeUndefined();
    // Closed, its preview goes.
    ctx.editing.choose("rec", { action: "close" });
    await vi.waitFor(() => expect(previews()).toEqual([]));
  });

  it("saves the scene with the cuts as a version-2 edit, keeps it across saves of cuts alone, and exports it rendered", async () => {
    const worker = runner(undefined, DESCRIPTION);
    const ctx = setup({}, worker);
    await ctx.editing.choose("rec", { action: "open" });
    const scene = { camera: { x: 0, y: 1, width: 0.25, height: 0.25, shown: true }, volumes: { system: 0, microphone: 200 } };
    expect(await ctx.editing.choose("rec", { action: "save", removed: [], revision: 0, scene })).toBe(true);
    expect(record()).toMatchObject({ version: 2, scene, revision: 1 });
    // A cut alone keeps the scene.
    expect(await ctx.editing.choose("rec", { action: "save", removed: [[90_000, 180_000]], revision: 1 })).toBe(true);
    expect(ctx.editing.view()!.editable!.scene).toEqual(scene);
    ctx.editing.choose("rec", { action: "close" });
    await ctx.editing.choose("rec", { action: "open" });
    expect(ctx.editing.view()!.editable!.scene).toEqual(scene);
    expect(await ctx.editing.choose("rec", { action: "export" })).toBe(true);
    await settled(ctx.editing);
    const request = worker.export.mock.calls[0]![0];
    // The bubble where the edit put it, in the recording's shape; the system's sound silent, the microphone's doubled.
    expect(request.render).toEqual({ camera: { width: 0.25, height: 0.25, rounding: 0.15, x: 0, y: 1, mirror: true }, volumesDb: [-60, 20 * Math.log10(2)] });
    expect(request.removed).toEqual([{ from: 90_000, to: 180_000 }]);
    expect(ctx.published).toHaveLength(1);
  });

  it("leaves a hidden camera out of the export", async () => {
    const worker = runner(undefined, DESCRIPTION);
    const ctx = setup({}, worker);
    await ctx.editing.choose("rec", { action: "open" });
    const scene = { camera: { x: 0.5, y: 0.5, width: 0.2, height: 0.3, shown: false }, volumes: { system: 100, microphone: 100 } };
    await ctx.editing.choose("rec", { action: "save", removed: [], revision: 0, scene });
    await ctx.editing.choose("rec", { action: "export" });
    await settled(ctx.editing);
    expect(worker.export.mock.calls[0]![0].render).toEqual({ volumesDb: [0, 0] });
  });

  it("saves a camera hidden over stretches as a version-3 edit, kept within the recording, and leaves it out of the export there only", async () => {
    const worker = runner(undefined, DESCRIPTION);
    const ctx = setup({}, worker);
    await ctx.editing.choose("rec", { action: "open" });
    const place = { x: 0.5, y: 0.5, width: 0.2, height: 0.3, shown: true };
    // Out of order, overlapping and past the recording's end, as no page sends them: saved sorted, merged and within it.
    const scene = { camera: { ...place, hidden: [[600_000, 2_000_000], [90_000, 180_000], [150_000, 270_000]] as Array<[number, number]> }, volumes: { system: 100, microphone: 100 } };
    expect(await ctx.editing.choose("rec", { action: "save", removed: [], revision: 0, scene })).toBe(true);
    expect(record()).toMatchObject({ version: 3, scene: { camera: { ...place, hidden: [[90_000, 270_000], [600_000, 900_000]] } } });
    // Hidden throughout keeps the stretches (version 3); with none, it is version 2's hidden camera.
    expect(await ctx.editing.choose("rec", { action: "save", removed: [], revision: 1, scene: { ...scene, camera: { ...place, shown: false, hidden: [[0, 900_000]] } } })).toBe(true);
    expect(record()).toMatchObject({ version: 3, scene: { camera: { ...place, shown: false, hidden: [[0, 900_000]] } } });
    expect(await ctx.editing.choose("rec", { action: "save", removed: [], revision: 2, scene: { ...scene, camera: { ...place, shown: false } } })).toBe(true);
    expect(record()).toMatchObject({ version: 2, scene: { camera: { ...place, shown: false } } });
    expect((record() as { scene: { camera: object } }).scene.camera).not.toHaveProperty("hidden");
    expect(await ctx.editing.choose("rec", { action: "save", removed: [[0, 45_000]], revision: 3, scene: { ...scene, camera: { ...place, hidden: [[90_000, 180_000]] } } })).toBe(true);
    expect(await ctx.editing.choose("rec", { action: "export" })).toBe(true);
    await settled(ctx.editing);
    // On the recording's own clock, as the cuts are: the cut before the stretch does not move it.
    expect(worker.export.mock.calls[0]![0].render).toMatchObject({ camera: { x: 0.5, y: 0.5 }, cameraHidden: [{ from: 90_000, to: 180_000 }] });
    expect(ctx.logs.some((line) => /rendering .* the camera hidden over 1 stretch\(es\) \(camera shown, volumes /.test(line))).toBe(true);
  });

  it("saves an input's volume stretches as a version-3 edit, kept within the recording, and asks the export for them in dB", async () => {
    const worker = runner(undefined, DESCRIPTION);
    const ctx = setup({}, worker);
    await ctx.editing.choose("rec", { action: "open" });
    const scene = { camera: { x: 0.5, y: 0.5, width: 0.2, height: 0.3, shown: true }, volumes: { system: 100, microphone: 100 },
      volumeStretches: { microphone: [[450_000, 2_000_000, 0], [90_000, 180_000, 200]] as Array<[number, number, number]> } };
    expect(await ctx.editing.choose("rec", { action: "save", removed: [], revision: 0, scene })).toBe(true);
    expect(record()).toMatchObject({ version: 3, scene: { volumeStretches: { microphone: [[90_000, 180_000, 200], [450_000, 900_000, 0]] } } });
    expect(await ctx.editing.choose("rec", { action: "export" })).toBe(true);
    await settled(ctx.editing);
    expect(worker.export.mock.calls[0]![0].render!.volumeStretchesDb).toEqual([[], [{ from: 90_000, to: 180_000, db: 20 * Math.log10(2) }, { from: 450_000, to: 900_000, db: -60 }]]);
    expect(ctx.logs.some((line) => /rendering .*, volume stretches 0\/2 \(camera shown/.test(line))).toBe(true);
  });

  it("shows a recording whose description cannot be read as one that cannot be edited", async () => {
    const ctx = setup({}, runner(undefined, JSON.stringify({ version: 9, sounds: [] })));
    await ctx.editing.choose("rec", { action: "open" });
    expect(ctx.editing.view()).toMatchObject({ state: "unsupported", exportable: false });
    expect(ctx.editing.view()!.editable).toBeUndefined();
  });

  it("keeps an ordinary recording's edit at version 1, with no scene and no preview", async () => {
    const ctx = setup();
    await editedOnce(ctx);
    expect(record()).toMatchObject({ version: 1 });
    expect(record()).not.toHaveProperty("scene");
    expect(ctx.editing.view()!.editable).toBeUndefined();
    expect(ctx.worker.extract).not.toHaveBeenCalled();
  });

  it("ends a worker kept busy by the preview of a view closed meanwhile, and offers no bubble for a camera that wrote nothing", async () => {
    let finish!: () => void;
    const worker = runner(undefined, DESCRIPTION);
    worker.extract.mockImplementation(async ({ track }) => {
      if (track === "camera") await new Promise<void>((resolve) => { finish = resolve; });
      throw new ExportFailure("unsupported", `the recording has no ${track} track`);
    });
    const ctx = setup({}, worker);
    await ctx.editing.choose("rec", { action: "open" });
    await vi.waitFor(() => expect(worker.extract).toHaveBeenCalled());
    // Closed while the camera is still being copied: the worker stays for that request, then goes.
    ctx.editing.choose("rec", { action: "close" });
    const closed = worker.calls.closeIdle;
    finish();
    await vi.waitFor(() => expect(worker.calls.closeIdle).toBe(closed + 1));

    // Opened again: the camera's track holds nothing (an interrupted recording), so the view has no camera to place.
    worker.extract.mockImplementation(async ({ track }) => { throw new ExportFailure("unsupported", `the recording has no ${track} track`); });
    await ctx.editing.choose("rec", { action: "open" });
    // Waited for rather than slept on: a fixed 20 ms was not long enough on a Windows CI runner (2026-10-25).
    await vi.waitFor(() => {
      expect(ctx.editing.view()!.editable).not.toHaveProperty("camera");
      expect(ctx.editing.view()!.editable!.scene).not.toHaveProperty("camera");
    });
  });

  it("hands the full-screen viewer the open edit as its preview plays it, once the preview tracks are made, and nothing for another recording", async () => {
    let finish!: () => void;
    const worker = runner(undefined, DESCRIPTION);
    const extract = worker.extract.getMockImplementation()!;
    worker.extract.mockImplementation(async (request) => {
      if (request.track === "camera") await new Promise<void>((resolve) => { finish = resolve; });
      return extract(request);
    });
    const ctx = setup({}, worker);
    expect(await ctx.editing.playback("rec")).toBeUndefined();
    await ctx.editing.choose("rec", { action: "open" });
    expect(await ctx.editing.choose("rec", { action: "save", removed: [[0, 90_000]], revision: 0 })).toBe(true);
    await vi.waitFor(() => expect(worker.extract).toHaveBeenCalled());
    // Asked while the camera is still being copied: it waits for it (Codex's review), so the viewer has its URL.
    let answered = false;
    const asked = ctx.editing.playback("rec").then((edit) => { answered = true; return edit; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(answered).toBe(false);
    finish();
    const edit = await asked;
    expect(edit).toMatchObject({ timescale: 90_000, editable: { sounds: ["system", "microphone"], preview: { camera: expect.stringMatching(/^recordstuff-media:\/\/preview\/\d+\/camera$/) } } });
    expect(await ctx.editing.playback("other")).toBeUndefined();
  });

  it("removes the preview tracks a crash left at the next launch", async () => {
    const folder = path.join(dir, "userData", "edits", "preview");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "abc-3-camera.mp4"), "left");
    await setup().editing.removePreviews();
    expect(fs.existsSync(folder)).toBe(false);
  });
});
