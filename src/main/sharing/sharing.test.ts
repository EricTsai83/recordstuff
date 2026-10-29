import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CopyTracksRequest, ExportPlan, ExportRequest } from "../../shared/editing";
import type { EditScene } from "../../shared/editable";
import { editRecord, sourceIdentity, type LoadedEdit } from "../editing/edit-store";
import { ExportFailure } from "../editing/export-host";
import { Sharing, type SharingRunner } from "./sharing";
import { VersionCache } from "./version-cache";

let dir: string;
let paused: string | undefined;
const logs: string[] = [];

const MIXED = JSON.stringify({ version: 2, mix: true, sounds: ["system", "microphone"], camera: { width: 0.2, height: 0.2, rounding: 1, x: 1, y: 1, mirror: true } });
const NO_CAMERA = JSON.stringify({ version: 2, mix: true, sounds: ["system", "microphone"], camera: null });

/** The export worker, faked: each call is recorded and writes its output; `hold` keeps the next export running. */
class FakeRunner implements SharingRunner {
  readonly calls: Array<{ type: string; request: unknown }> = [];
  descriptions = new Map<string, string>();
  hold: { release(): void; progress?: (fraction: number) => void } | undefined;
  private holding: ((value: unknown) => void) | undefined;
  private rejectHeld: ((cause: unknown) => void) | undefined;
  fail = false;
  closed = 0;

  async inspect(request: { source: string }): Promise<ExportPlan> {
    this.calls.push({ type: "inspect", request });
    return { timescale: 90000, duration: 900000, outputDuration: 900000, frames: 300, removed: [], parts: [], dropped: [], secondDescription: false, hasAudio: true,
      editable: this.descriptions.get(request.source) ?? null };
  }

  async export(request: ExportRequest & { output: string }, progress: (fraction: number) => void): Promise<{ bytes: number }> {
    this.calls.push({ type: "export", request });
    if (this.fail) throw new ExportFailure("encode_failed", "the encoder refused");
    if (this.hold) {
      this.hold.progress = progress;
      await new Promise((resolve, reject) => { this.holding = resolve; this.rejectHeld = reject; });
    }
    progress(0.5);
    fs.writeFileSync(request.output, `rendered ${request.source}`);
    return { bytes: 1 };
  }

  async copyTracks(request: CopyTracksRequest): Promise<number> {
    this.calls.push({ type: "tracks", request });
    fs.writeFileSync(request.output, `${request.tracks.join("+")} of ${request.source}`);
    return 1;
  }

  release(): void { this.hold = undefined; this.holding?.(undefined); }
  cancel(): void { this.calls.push({ type: "cancel", request: undefined }); this.rejectHeld?.(new ExportFailure("cancelled", "cancelled")); this.hold = undefined; }
  closeIdle(): void { this.closed++; }
}

const edits = new Map<string, { removed: Array<[number, number]>; scene?: EditScene } | "unreadable" | "stale">();
let runner: FakeRunner;
let cache: VersionCache;
let sharing: Sharing;
let changes = 0;

function recording(name: string, editable?: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `the bytes of ${name}`);
  if (editable) runner.descriptions.set(file, editable);
  return file;
}

/** Lets the queue move without waiting for a held export. */
const tick = async (): Promise<void> => { for (let n = 0; n < 50; n++) await new Promise((resolve) => setImmediate(resolve)); };
const settle = async (): Promise<void> => {
  for (let n = 0; n < 20; n++) await new Promise((resolve) => setImmediate(resolve));
  await sharing.idle();
};

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sharing-"));
  paused = undefined;
  logs.length = 0;
  edits.clear();
  changes = 0;
  runner = new FakeRunner();
  cache = new VersionCache({ root: path.join(dir, "cache"), log: (line) => logs.push(line), freeSpace: async () => 500 * 1024 ** 3 });
  sharing = new Sharing({
    cache,
    runner,
    store: {
      load: async (source, identity): Promise<LoadedEdit> => {
        const edit = edits.get(source);
        if (edit === "unreadable") return { kind: "unreadable", reason: "saved by a newer version" };
        const record = (removed: Array<[number, number]>, scene?: EditScene) => editRecord({ source: identity, timescale: 90000, removed, revision: 1, scene });
        if (edit === "stale") return { kind: "stale", record: record([[0, 9000]]) };
        return edit ? { kind: "ok", record: record(edit.removed, edit.scene) } : { kind: "none" };
      },
    },
    editable: async (source) => runner.descriptions.has(source),
    paused: () => paused,
    language: () => "en",
    changed: () => { changes++; },
    log: (line) => logs.push(line),
  });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("what a drag gives (plan 100)", () => {
  it("gives a plain recording never edited as it is, at once, with nothing made", async () => {
    const file = recording("Meeting.mp4");
    expect(await sharing.handOut(file, "video")).toEqual({ file });
    expect(runner.calls).toEqual([]);
  });

  it("waits for an edited plain recording's Video (D1), then gives it as <name> (edited).mp4", async () => {
    const file = recording("Meeting.mp4");
    edits.set(file, { removed: [[0, 9000]] });
    expect(await sharing.handOut(file, "video")).toEqual({ preparing: true });
    await settle();
    expect(runner.calls.find((call) => call.type === "export")?.request).toMatchObject({ source: file, removed: [{ from: 0, to: 9000 }], background: true });
    const given = await sharing.handOut(file, "video");
    expect(given).toMatchObject({ file: expect.stringMatching(/Meeting \(edited\)\.mp4$/) });
    expect(fs.readFileSync((given as { file: string }).file, "utf8")).toBe(`rendered ${file}`);
    // The recording's file is never what an edited recording's drag gives.
    expect((given as { file: string }).file).not.toBe(file);
    expect(runner.closed, "the worker goes once nothing is left").toBeGreaterThan(0);
  });

  it("gives a plain recording never edited as its Original too, on ⌥-drag (Codex F7)", async () => {
    const file = recording("Meeting.mp4");
    expect(await sharing.handOut(file, "original")).toEqual({ file });
  });

  it("gives nothing but the Original of a recording whose edit cannot be read or was made for another file (Codex F1)", async () => {
    for (const state of ["unreadable", "stale"] as const) {
      const file = recording(`${state}.mp4`);
      edits.set(file, state);
      for (const kind of ["video", "sound"] as const) expect(await sharing.handOut(file, kind), `${state} ${kind}`).toEqual({ failed: true });
      expect(await sharing.handOut(file, "original")).toEqual({ file });
      sharing.prepare(file);
      await settle();
      expect(sharing.videoState(file)).toEqual({ state: "failed" });
      const editable = recording(`${state}.recordstuff.mp4`, MIXED);
      edits.set(editable, state);
      expect(await sharing.handOut(editable, "video")).toEqual({ failed: true });
      expect(await sharing.handOut(editable, "original")).toEqual({ file: editable });
    }
    expect(runner.calls.filter((call) => call.type === "export" || call.type === "tracks")).toEqual([]);
  });

  it("gives an edited plain recording's Original as a link named (original), the recording untouched", async () => {
    const file = recording("Meeting.mp4");
    edits.set(file, { removed: [[0, 9000]] });
    const given = await sharing.handOut(file, "original") as { file: string };
    expect(path.basename(given.file)).toBe("Meeting (original).mp4");
    expect(fs.statSync(given.file).ino).toBe(fs.statSync(file).ino);
    expect(fs.readFileSync(file, "utf8")).toBe("the bytes of Meeting.mp4");
  });

  it("gives the recording itself as its Original on a volume without hard links", async () => {
    const file = recording("Meeting.mp4");
    edits.set(file, { removed: [[0, 9000]] });
    const refusing = new Sharing({ ...(sharing as unknown as { deps: ConstructorParameters<typeof Sharing>[0] }).deps,
      link: async () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); } });
    expect(await refusing.handOut(file, "original")).toEqual({ file });
  });

  it("gives an editable recording's original as it is, and renders its Video with the camera where it was recorded", async () => {
    const file = recording("Meeting.recordstuff.mp4", MIXED);
    expect(await sharing.handOut(file, "original")).toEqual({ file });
    expect(await sharing.handOut(file, "video")).toEqual({ preparing: true });
    await settle();
    const rendered = runner.calls.find((call) => call.type === "export")?.request as ExportRequest;
    expect(rendered.render).toMatchObject({ camera: { x: 1, y: 1, mirror: true }, volumesDb: [0, 0], soundTracks: [1, 2] });
    const given = await sharing.handOut(file, "video") as { file: string };
    expect(path.basename(given.file)).toBe("Meeting.mp4");
  });

  it("copies an editable recording's screen and mix without rendering when nothing changes them", async () => {
    const file = recording("Clip.recordstuff.mp4", NO_CAMERA);
    sharing.prepare(file);
    await settle();
    expect(runner.calls.filter((call) => call.type === "export")).toEqual([]);
    expect(runner.calls.find((call) => call.type === "tracks")?.request).toMatchObject({ source: file, tracks: ["screen", "sound0"], background: true });
    // Its sound alone from the recording's own played track; without a camera it offers no Video without one.
    sharing.prepare(file, "screenOnly");
    sharing.prepare(file, "sound");
    await settle();
    expect(runner.calls.filter((call) => call.type === "export")).toEqual([]);
    expect(runner.calls.filter((call) => call.type === "tracks").map((call) => (call.request as CopyTracksRequest).tracks)).toEqual([["screen", "sound0"], ["sound0"]]);
    expect(path.basename((await sharing.handOut(file, "sound") as { file: string }).file)).toBe("Clip (sound).m4a");
  });

  it("renders when a volume changed, and makes Sound only from the Video it made", async () => {
    const file = recording("Clip.recordstuff.mp4", NO_CAMERA);
    edits.set(file, { removed: [], scene: { volumes: { system: 100, microphone: 50 } } });
    sharing.prepare(file, "sound");
    await settle();
    const exported = runner.calls.filter((call) => call.type === "export");
    expect(exported).toHaveLength(1);
    const copied = runner.calls.find((call) => call.type === "tracks")?.request as CopyTracksRequest;
    expect(copied.tracks).toEqual(["sound0"]);
    expect(copied.source).toMatch(/content\.mp4$/);
    // The Video was kept, so a drag has it at once.
    expect(await sharing.handOut(file, "video")).toMatchObject({ file: expect.any(String) });
  });

  it("copies an editable recording's screen and mix for its Video without the camera when nothing else changes", async () => {
    const file = recording("Cam.recordstuff.mp4", MIXED);
    sharing.prepare(file, "screenOnly");
    await settle();
    expect(runner.calls.filter((call) => call.type === "export")).toEqual([]);
    expect(path.basename((await sharing.handOut(file, "screenOnly") as { file: string }).file)).toBe("Cam (screen only).mp4");
  });

  it("copies each source into a folder named after the recording (D7)", async () => {
    const file = recording("Talk.recordstuff.mp4", MIXED);
    sharing.prepare(file, "sources");
    await settle();
    const given = await sharing.handOut(file, "sources") as { file: string };
    expect(path.basename(given.file)).toBe("Talk sources");
    expect(fs.readdirSync(given.file).sort()).toEqual(["Talk - Camera.mp4", "Talk - Microphone.m4a", "Talk - Screen.mp4", "Talk - System sound.m4a"]);
    expect(fs.readFileSync(path.join(given.file, "Talk - Microphone.m4a"), "utf8")).toBe(`sound2 of ${file}`);
  });

  it("makes the next Video once the edit changes, keyed by it, and reuses one while it does not", async () => {
    const file = recording("Meeting.mp4");
    edits.set(file, { removed: [[0, 9000]] });
    sharing.prepare(file);
    await settle();
    sharing.prepare(file);
    await settle();
    expect(runner.calls.filter((call) => call.type === "export")).toHaveLength(1);
    edits.set(file, { removed: [[0, 18000]] });
    expect(await sharing.handOut(file, "video")).toEqual({ preparing: true });
    await settle();
    expect(runner.calls.filter((call) => call.type === "export")).toHaveLength(2);
    expect(fs.readdirSync(cache.root).filter((name) => !name.startsWith("."))).toHaveLength(1);
  });
});

describe("preparing alongside what the person does (D2)", () => {
  it("waits while something pauses it, and starts once resumed", async () => {
    const file = recording("Meeting.mp4");
    edits.set(file, { removed: [[0, 9000]] });
    paused = "recording";
    sharing.prepare(file);
    await settle();
    expect(runner.calls).toEqual([]);
    expect(sharing.videoState(file)).toEqual({ state: "preparing", progress: 0 });
    paused = undefined;
    sharing.resume();
    await settle();
    expect(sharing.videoState(file)).toBeUndefined();
    expect(await sharing.handOut(file, "video")).toMatchObject({ file: expect.any(String) });
  });

  it("cancels a Video being made when a recording starts, and makes it again from the start afterwards", async () => {
    const file = recording("Meeting.mp4");
    edits.set(file, { removed: [[0, 9000]] });
    runner.hold = { release: () => undefined };
    sharing.prepare(file);
    // Under a loaded runner the export may take longer than a few turns to begin.
    await vi.waitFor(() => expect(runner.hold?.progress).toBeDefined());
    runner.hold?.progress?.(0.4);
    // Progress is shown on the card as a fraction.
    expect(sharing.videoState(file)).toEqual({ state: "preparing", progress: 0.4 });
    paused = "recording";
    sharing.yield("a recording started");
    await settle();
    await vi.waitFor(() => expect(sharing.videoState(file)).toEqual({ state: "preparing", progress: 0 }));
    expect(runner.calls.map((call) => call.type)).toContain("cancel");
    expect(sharing.videoState(file)).toEqual({ state: "preparing", progress: 0 });
    expect(fs.readdirSync(cache.root), "nothing half-made is left").toEqual([]);
    paused = undefined;
    sharing.resume();
    await settle();
    expect(runner.calls.filter((call) => call.type === "export")).toHaveLength(2);
    expect(await sharing.handOut(file, "video")).toMatchObject({ file: expect.any(String) });
  });

  it("says when a Video could not be made, and tries again when asked", async () => {
    const file = recording("Meeting.mp4");
    edits.set(file, { removed: [[0, 9000]] });
    runner.fail = true;
    sharing.prepare(file);
    await settle();
    expect(sharing.videoState(file)).toEqual({ state: "failed" });
    expect(sharing.videoStates().get(file)).toEqual({ state: "failed" });
    runner.fail = false;
    expect(await sharing.handOut(file, "video")).toEqual({ preparing: true });
    await settle();
    expect(sharing.videoState(file)).toBeUndefined();
  });

  it("drops a recording's versions when it is deleted or leaves the folder, and follows one renamed", async () => {
    const a = recording("A.mp4"), b = recording("B.mp4");
    edits.set(a, { removed: [[0, 9000]] });
    edits.set(b, { removed: [[0, 9000]] });
    sharing.prepare(a);
    sharing.prepare(b);
    await settle();
    expect(cache.size()).toBeGreaterThan(0);
    await sharing.removed(a);
    expect(cache.sources()).toEqual(new Set([b]));
    const renamed = path.join(dir, "C.mp4");
    fs.renameSync(b, renamed);
    edits.set(renamed, edits.get(b)!);
    await sharing.moved(b, renamed);
    expect(await sharing.handOut(renamed, "video"), "its Video followed it, made for the same bytes and edit").toMatchObject({ file: expect.stringMatching(/C \(edited\)\.mp4$/) });
    expect(runner.calls.filter((call) => call.type === "export")).toHaveLength(2);
    expect((await sourceIdentity(renamed)).size).toBeGreaterThan(0);
  });

  it("keeps nothing made from a recording deleted while its version was being put into place (Codex F3)", async () => {
    const file = recording("Meeting.mp4");
    edits.set(file, { removed: [[0, 9000]] });
    const commit = cache.commit.bind(cache);
    let deleted = false;
    cache.commit = async (...args) => {
      if (!deleted) { deleted = true; await sharing.removed(file); }
      return commit(...args);
    };
    sharing.prepare(file);
    await settle();
    expect(cache.sources()).toEqual(new Set());
    expect(fs.readdirSync(cache.root)).toEqual([]);
    expect(sharing.videoState(file)).toBeUndefined();
  });

  it("waits for a rename in the tab before a drag or a listing reads the new path (Codex pass 2)", async () => {
    const from = recording("Old.mp4");
    edits.set(from, { removed: [[0, 9000]] });
    sharing.prepare(from);
    await settle();
    const to = path.join(dir, "New.mp4");
    let finish!: () => void;
    const renamed = sharing.during(async () => {
      fs.renameSync(from, to);
      // The listing has the new card already; its edit follows a moment later.
      await new Promise<void>((resolve) => { finish = resolve; });
      edits.set(to, edits.get(from)!);
      await sharing.moved(from, to);
    });
    await tick();
    const given = sharing.handOut(to, "video");
    const swept = sharing.sweep(dir);
    await tick();
    finish();
    await renamed;
    await swept;
    expect(await given).toMatchObject({ file: expect.stringMatching(/New \(edited\)\.mp4$/) });
    expect(cache.sources(), "the old path is not taken for a deleted recording").toEqual(new Set([to]));
    expect(runner.calls.filter((call) => call.type === "export")).toHaveLength(1);
  });

  it("carries a category's versions to its new name", async () => {
    fs.mkdirSync(path.join(dir, "Talks"));
    const from = path.join(dir, "Talks", "A.mp4");
    fs.writeFileSync(from, "a");
    edits.set(from, { removed: [[0, 9000]] });
    sharing.prepare(from);
    await settle();
    fs.renameSync(path.join(dir, "Talks"), path.join(dir, "Demos"));
    await sharing.folderMoved(path.join(dir, "Talks"), path.join(dir, "Demos"));
    expect(cache.sources()).toEqual(new Set([path.join(dir, "Demos", "A.mp4")]));
  });

  it("keeps versions only of recordings in the output folder: none of one gone, only those handed out of one left behind", async () => {
    const gone = recording("Gone.mp4"), held = recording("Held.mp4"), unheld = recording("Unheld.mp4");
    for (const file of [gone, held, unheld]) { edits.set(file, { removed: [[0, 9000]] }); sharing.prepare(file); }
    await settle();
    expect(await sharing.handOut(held, "video")).toMatchObject({ file: expect.any(String) });
    fs.rmSync(gone);
    // The output folder is now another: the two still on disk are no longer in the Recordings tab.
    await sharing.sweep(path.join(dir, "elsewhere"));
    expect(cache.sources(), "handed out within the day: a page may still read it").toEqual(new Set([held]));
    await sharing.sweep(dir);
    expect(cache.sources()).toEqual(new Set([held]));
  });

  it("ends for good the preparation of a recording that left the output folder, waiting or running (Codex review)", async () => {
    const running = recording("Running.mp4"), waiting = recording("Waiting.mp4");
    edits.set(running, { removed: [[0, 9000]] });
    edits.set(waiting, { removed: [[0, 9000]] });
    runner.hold = { release: () => undefined };
    sharing.prepare(running);
    sharing.prepare(waiting);
    await vi.waitFor(() => expect(runner.hold?.progress).toBeDefined());
    await sharing.sweep(path.join(dir, "elsewhere"));
    await settle();
    expect(sharing.videoState(running)).toBeUndefined();
    expect(sharing.videoState(waiting)).toBeUndefined();
    expect(runner.calls.filter((call) => call.type === "export")).toHaveLength(1);
    expect(cache.sources()).toEqual(new Set());
  });

  it("makes nothing for a version that is the recording itself", async () => {
    const plain = recording("Plain.mp4");
    sharing.prepare(plain);
    await settle();
    expect(runner.calls.map((call) => call.type)).toEqual(["inspect"]);
    expect(cache.size()).toBe(0);
  });

  it("ends a Video being made at quit", async () => {
    const file = recording("Meeting.mp4");
    edits.set(file, { removed: [[0, 9000]] });
    runner.hold = { release: () => undefined };
    sharing.prepare(file);
    await vi.waitFor(() => expect(runner.hold?.progress).toBeDefined());
    await sharing.shutdown(500);
    expect(runner.calls.map((call) => call.type)).toContain("cancel");
    expect(fs.readdirSync(cache.root)).toEqual([]);
  });
});
