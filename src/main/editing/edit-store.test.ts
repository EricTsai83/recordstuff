import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EDIT_RECORD_LIMIT, EditStore, editRecord, parseRecord, sourceIdentity, type EditRecord } from "./edit-store";

let dir: string;
let store: EditStore;
let recording: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "edit-store-"));
  store = new EditStore(path.join(dir, "edits"));
  recording = path.join(dir, "2026-10-24 10-00-00.mp4");
  fs.writeFileSync(recording, Buffer.alloc(3 * 1024 * 1024, 7));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function record(removed: Array<[number, number]> = [[90_000, 180_000]], revision = 1): Promise<EditRecord> {
  return { version: 1, source: await sourceIdentity(recording), timescale: 90_000, removed, revision };
}

describe("edit records", () => {
  it("are saved and read back for the same recording, which is never written", async () => {
    const before = fs.readFileSync(recording);
    const saved = await record();
    await store.save(saved);
    expect(await store.load(recording, await sourceIdentity(recording))).toEqual({ kind: "ok", record: saved });
    expect(fs.readFileSync(recording).equals(before)).toBe(true);
    // Nothing beside the recording: the record lives in userData.
    expect(fs.readdirSync(dir).sort()).toEqual(["2026-10-24 10-00-00.mp4", "edits"]);
  });

  it("are none for a recording never edited", async () => {
    expect(await store.load(recording, await sourceIdentity(recording))).toEqual({ kind: "none" });
  });

  it("are stale once the recording at that path is another file", async () => {
    await store.save(await record());
    // The same size and the same ends, changed in the middle and touched: the modification time tells.
    const handle = fs.openSync(recording, "r+");
    fs.writeSync(handle, Buffer.from([1]), 0, 1, 1.5 * 1024 * 1024);
    fs.closeSync(handle);
    fs.utimesSync(recording, new Date(), new Date(Date.now() + 5000));
    const loaded = await store.load(recording, await sourceIdentity(recording));
    expect(loaded.kind).toBe("stale");
    // A different end with the same time and size: the hash tells.
    const identity = { ...await sourceIdentity(recording), hash: "0".repeat(64) };
    expect((await store.load(recording, identity)).kind).toBe("stale");
  });

  it("keep the last whole revision when a write fails", async () => {
    await store.save(await record([[0, 10]], 1));
    const file = store.fileFor(recording);
    // A folder where the temporary file goes: the next write cannot create it, on every platform
    // (a read-only folder does not stop writes on Windows).
    fs.mkdirSync(`${file}.tmp`);
    try {
      await expect(store.save(await record([[0, 20]], 2))).rejects.toThrow();
    } finally {
      fs.rmdirSync(`${file}.tmp`);
    }
    const loaded = await store.load(recording, await sourceIdentity(recording));
    expect(loaded.kind === "ok" && loaded.record.revision).toBe(1);
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("that cannot be read are reported and kept, never replaced", async () => {
    const file = store.fileFor(recording);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const [text, reason] of [
      ["{ not json", /not valid JSON/],
      [JSON.stringify({ version: 4, removed: [] }), /newer version \(4\)/],
      [JSON.stringify({ version: 1, removed: "all" }), /fields/],
      [JSON.stringify({ ...{ version: 1, timescale: 90_000, revision: 1, source: { path: recording, size: 1, mtimeMs: 1, hash: "a".repeat(64) } }, removed: [[20, 30], [10, 25]] }), /overlap or are out of order/],
    ] as const) {
      fs.writeFileSync(file, text);
      const loaded = await store.load(recording, await sourceIdentity(recording));
      expect(loaded.kind).toBe("unreadable");
      expect(loaded.kind === "unreadable" && loaded.reason).toMatch(reason);
      expect(fs.readFileSync(file, "utf8")).toBe(text);
    }
  });

  it("are read only up to their bound", async () => {
    const file = store.fileFor(recording);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, " ".repeat(EDIT_RECORD_LIMIT + 1));
    const loaded = await store.load(recording, await sourceIdentity(recording));
    expect(loaded.kind === "unreadable" && loaded.reason).toMatch(/more than/);
  });

  it("go on Discard, and only they do", async () => {
    await store.save(await record());
    await store.discard(recording);
    expect(fs.existsSync(store.fileFor(recording))).toBe(false);
    expect(fs.existsSync(recording)).toBe(true);
  });

  it("are listed by recording, kept by saves, discards and moves, and read once at launch (2026-10-26)", async () => {
    const saved = await record();
    await store.save(saved);
    expect([...store.edited()]).toEqual([[recording, saved.source.size]]);
    const moved = path.join(dir, "Talk.mp4");
    await store.prepareMove(recording, moved);
    fs.renameSync(recording, moved);
    await store.finishMove(recording, moved, true);
    expect([...store.edited().keys()]).toEqual([moved]);
    // Read again by a new store; files that are not records, or are unreadable, are left out.
    fs.writeFileSync(path.join(dir, "edits", "exports-in-flight.json"), "[]");
    fs.writeFileSync(path.join(dir, "edits", `${"0".repeat(32)}.json`), "{");
    const launched = new EditStore(path.join(dir, "edits"));
    await launched.scan();
    expect([...launched.edited().keys()]).toEqual([moved]);
    await launched.discard(moved);
    expect(launched.edited().size).toBe(0);
  });

  it("are read at launch in the writes' queue, so a discard made meanwhile is not undone by it (review of 2026-10-26)", async () => {
    await store.save(await record());
    const launched = new EditStore(path.join(dir, "edits"));
    const scanned = launched.scan();
    const discarded = launched.discard(recording);
    await Promise.all([scanned, discarded]);
    expect(launched.edited().size).toBe(0);
  });

  it("follow a recording renamed or moved, when it is the same file", async () => {
    const saved = await record();
    await store.save(saved);
    const moved = path.join(dir, "Talk.mp4");
    await store.prepareMove(recording, moved);
    fs.renameSync(recording, moved);
    await store.finishMove(recording, moved, true);
    const loaded = await store.load(moved, await sourceIdentity(moved));
    expect(loaded.kind === "ok" && loaded.record.removed).toEqual(saved.removed);
    expect(fs.existsSync(store.fileFor(recording))).toBe(false);
  });

  it("follow the recordings of a category folder renamed, and only those directly in it", async () => {
    const folder = path.join(dir, "Demos");
    fs.mkdirSync(folder);
    const inside = path.join(folder, "Talk.mp4");
    fs.renameSync(recording, inside);
    recording = inside;
    const saved = await record();
    await store.save(saved);
    // A recording outside the folder, whose edit stays where it is.
    const outside = path.join(dir, "Other.mp4");
    fs.writeFileSync(outside, Buffer.alloc(1024, 3));
    await store.save({ ...saved, source: await sourceIdentity(outside) });
    const renamed = path.join(dir, "Talks");
    await store.prepareFolderMove(folder, renamed);
    fs.renameSync(folder, renamed);
    await store.finishFolderMove(folder, renamed, true);
    const moved = path.join(renamed, "Talk.mp4");
    expect([...store.edited().keys()].sort()).toEqual([outside, moved].sort());
    const loaded = await store.load(moved, await sourceIdentity(moved));
    expect(loaded.kind === "ok" && loaded.record.removed).toEqual(saved.removed);
    expect(fs.existsSync(store.fileFor(inside))).toBe(false);
  });
});

describe("a record's parsing", () => {
  it("takes version 1, and version 2 with an editable recording's scene (plan 087), with every field checked", () => {
    const source = { path: "/a.mp4", size: 10, mtimeMs: 5, hash: "f".repeat(64) };
    expect(parseRecord(JSON.stringify({ version: 1, source, timescale: 90_000, removed: [[1, 2]], revision: 0 }))).toEqual({ version: 1, source, timescale: 90_000, removed: [[1, 2]], revision: 0 });
    const scene = { camera: { x: 0.5, y: 1, width: 0.2, height: 0.3, shown: false }, volumes: { system: 100, microphone: 250 } };
    expect(parseRecord(JSON.stringify({ version: 2, source, timescale: 90_000, removed: [], revision: 3, scene }))).toEqual({ version: 2, source, timescale: 90_000, removed: [], revision: 3, scene });
    // Version 2 needs its scene, a whole one; version 1's has none to keep.
    expect(parseRecord(JSON.stringify({ version: 2, source, timescale: 90_000, removed: [], revision: 3 }))).toHaveProperty("reason");
    expect(parseRecord(JSON.stringify({ version: 2, source, timescale: 90_000, removed: [], revision: 3, scene: { ...scene, volumes: { system: 700, microphone: 0 } } }))).toHaveProperty("reason");
    expect(parseRecord(JSON.stringify({ version: 1, source, timescale: 90_000, removed: [], revision: 0, scene }))).not.toHaveProperty("scene");
    expect(parseRecord(JSON.stringify({ version: 1, source: { ...source, hash: "x" }, timescale: 90_000, removed: [], revision: 0 }))).toHaveProperty("reason");
    expect(parseRecord(JSON.stringify({ version: 1, source, timescale: 90_000, removed: [[2, 1]], revision: 0 }))).toHaveProperty("reason");
  });

  it("takes version 3, a camera hidden over stretches (2026-10-26), and writes it only for such a camera", () => {
    const source = { path: "/a.mp4", size: 10, mtimeMs: 5, hash: "f".repeat(64) };
    const camera = { x: 0.5, y: 1, width: 0.2, height: 0.3, shown: true };
    const scene = { camera: { ...camera, hidden: [[90_000, 180_000], [270_000, 360_000]] as Array<[number, number]> }, volumes: { system: 100, microphone: 100 } };
    expect(parseRecord(JSON.stringify({ version: 3, source, timescale: 90_000, removed: [], revision: 4, scene }))).toEqual({ version: 3, source, timescale: 90_000, removed: [], revision: 4, scene });
    // Version 2 never wrote stretches: a record that says 2 and holds them was not written by it.
    expect(parseRecord(JSON.stringify({ version: 2, source, timescale: 90_000, removed: [], revision: 4, scene }))).toHaveProperty("reason");
    expect(parseRecord(JSON.stringify({ version: 3, source, timescale: 90_000, removed: [], revision: 4, scene: { ...scene, camera: { ...camera, hidden: [[5, 2]] } } }))).toHaveProperty("reason");
    expect(parseRecord(JSON.stringify({ version: 4, source, timescale: 90_000, removed: [], revision: 4, scene }))).toMatchObject({ reason: expect.stringContaining("newer version (4)") });
    const fields = { source, timescale: 90_000, removed: [] as Array<[number, number]>, revision: 1 };
    expect(editRecord({ ...fields, scene }).version).toBe(3);
    expect(editRecord({ ...fields, scene: { ...scene, camera } }).version).toBe(2);
    expect(editRecord({ ...fields, scene: { ...scene, camera: { ...camera, shown: false } } }).version).toBe(2);
    expect(editRecord(fields).version).toBe(1);
    // A volume stretch (2026-10-26) is version 3's too, and no version 2 record holds one.
    const loud = { camera, volumes: { system: 100, microphone: 100 }, volumeStretches: { microphone: [[0, 90_000, 0]] as Array<[number, number, number]> } };
    expect(editRecord({ ...fields, scene: loud }).version).toBe(3);
    expect(parseRecord(JSON.stringify({ version: 3, source, timescale: 90_000, removed: [], revision: 4, scene: loud }))).toMatchObject({ version: 3, scene: loud });
    expect(parseRecord(JSON.stringify({ version: 2, source, timescale: 90_000, removed: [], revision: 4, scene: loud }))).toHaveProperty("reason");
  });

  it("are found by the recording's bytes once it was renamed or moved in Finder, and follow it (plan 100)", async () => {
    const saved = await record();
    await store.save(saved);
    const moved = path.join(dir, "Talk.mp4");
    fs.renameSync(recording, moved);
    const loaded = await store.load(moved, await sourceIdentity(moved));
    expect(loaded.kind === "ok" && loaded.record.removed).toEqual(saved.removed);
    expect(loaded.kind === "ok" && loaded.record.source.path).toBe(moved);
    // It moved with the recording: found at the new path from now on, nothing left at the old one.
    expect([...store.edited().keys()]).toEqual([moved]);
    expect(fs.existsSync(store.fileFor(recording))).toBe(false);
    expect(fs.existsSync(store.fileFor(moved))).toBe(true);
  });

  it("are not taken by a copy of the recording while the recording is still at its path", async () => {
    await store.save(await record());
    const copy = path.join(dir, "Copy.mp4");
    fs.copyFileSync(recording, copy);
    fs.utimesSync(copy, fs.statSync(recording).atime, fs.statSync(recording).mtime);
    expect(await store.load(copy, await sourceIdentity(copy))).toEqual({ kind: "none" });
    expect([...store.edited().keys()]).toEqual([recording]);
  });

  it("are written for a recording's new path before it moves, and finished or taken back after (plan 100)", async () => {
    const saved = await record();
    await store.save(saved);
    const target = path.join(dir, "Talk.mp4");
    await store.prepareMove(recording, target);
    expect([...store.edited().keys()].sort()).toEqual([recording, target].sort());
    // The move did not happen: the record written for it goes, the recording's stays.
    await store.finishMove(recording, target, false);
    expect([...store.edited().keys()]).toEqual([recording]);
    // It did: the old one goes, and the new one is the recording's edit at its new path.
    await store.prepareMove(recording, target);
    fs.renameSync(recording, target);
    await store.finishMove(recording, target, true);
    expect([...store.edited().keys()]).toEqual([target]);
    const loaded = await store.load(target, await sourceIdentity(target));
    expect(loaded.kind === "ok" && loaded.record.removed).toEqual(saved.removed);
    // A recording with no edit has nothing to write.
    const other = path.join(dir, "Other.mp4");
    fs.writeFileSync(other, "x");
    await store.prepareMove(other, path.join(dir, "Else.mp4"));
    expect(store.edited().size).toBe(1);
  });

  // A read-only folder does not stop writes on Windows, so this runs on macOS only.
  it.skipIf(process.platform === "win32")("refuse a move whose edit cannot be written, with the write's own error (plan 100)", async () => {
    await store.save(await record());
    fs.chmodSync(path.join(dir, "edits"), 0o500);
    try {
      await expect(store.prepareMove(recording, path.join(dir, "Talk.mp4"))).rejects.toMatchObject({ code: expect.stringMatching(/EACCES|EPERM/) });
    } finally {
      fs.chmodSync(path.join(dir, "edits"), 0o700);
    }
    expect([...store.edited().keys()]).toEqual([recording]);
  });

  it("are written for every recording of a category before it is renamed, and all taken back if one fails", async () => {
    const folder = path.join(dir, "Demos");
    fs.mkdirSync(folder);
    const inside = path.join(folder, "Talk.mp4");
    fs.renameSync(recording, inside);
    recording = inside;
    await store.save(await record());
    const renamed = path.join(dir, "Talks");
    await store.prepareFolderMove(folder, renamed);
    expect([...store.edited().keys()].sort()).toEqual([inside, path.join(renamed, "Talk.mp4")].sort());
    await store.finishFolderMove(folder, renamed, false);
    expect([...store.edited().keys()]).toEqual([inside]);
    await store.prepareFolderMove(folder, renamed);
    fs.renameSync(folder, renamed);
    await store.finishFolderMove(folder, renamed, true);
    expect([...store.edited().keys()]).toEqual([path.join(renamed, "Talk.mp4")]);
  });

  it("never loses another recording's edit to a move refused because its name is taken (Codex review)", async () => {
    const other = path.join(dir, "Talk.mp4");
    fs.writeFileSync(other, Buffer.alloc(2048, 9));
    const theirs: EditRecord = { version: 1, source: await sourceIdentity(other), timescale: 90_000, removed: [[0, 9_000]], revision: 4 };
    await store.save(theirs);
    await store.save(await record());
    await store.prepareMove(recording, other);
    await store.finishMove(recording, other, false);
    expect(await store.load(other, await sourceIdentity(other))).toEqual({ kind: "ok", record: theirs });
    expect([...store.edited().keys()].sort()).toEqual([recording, other].sort());
  });

  it("refuse to move a recording whose edit cannot be read or was made for another file (Codex review)", async () => {
    fs.mkdirSync(path.join(dir, "edits"), { recursive: true });
    fs.writeFileSync(store.fileFor(recording), JSON.stringify({ version: 99 }));
    await expect(store.prepareMove(recording, path.join(dir, "Talk.mp4"))).rejects.toMatchObject({ code: "EBADMSG" });
    await store.save({ ...(await record()), source: { ...(await sourceIdentity(recording)), hash: "0".repeat(64) } });
    await expect(store.prepareMove(recording, path.join(dir, "Talk.mp4"))).rejects.toMatchObject({ code: "ESTALE" });
  });

  it("move an edit found by bytes once, however many readers ask at the same time (Codex review)", async () => {
    const saved = await record();
    await store.save(saved);
    const moved = path.join(dir, "Talk.mp4");
    fs.renameSync(recording, moved);
    const identity = await sourceIdentity(moved);
    const answers = await Promise.all([store.load(moved, identity), store.load(moved, identity), store.load(moved, identity)]);
    for (const answer of answers) expect(answer.kind === "ok" && answer.record.removed).toEqual(saved.removed);
    expect([...store.edited().keys()]).toEqual([moved]);
  });

  it("follow a rename that only changes case, on a volume that ignores case", async () => {
    const saved = await record();
    await store.save(saved);
    const upper = path.join(dir, "2026-10-24 10-00-00 TALK.mp4");
    const lower = path.join(dir, "2026-10-24 10-00-00 talk.mp4");
    fs.renameSync(recording, lower);
    recording = lower;
    await store.save({ ...saved, source: await sourceIdentity(lower) });
    await store.discard(path.join(dir, "2026-10-24 10-00-00.mp4"));
    const insensitive = fs.existsSync(upper);
    await store.prepareMove(lower, upper);
    fs.renameSync(lower, upper);
    await store.finishMove(lower, upper, true);
    const loaded = await store.load(upper, await sourceIdentity(upper));
    expect(loaded.kind === "ok" && loaded.record.removed, insensitive ? "case-insensitive volume" : "case-sensitive volume").toEqual(saved.removed);
  });

  it("never let a copy take an edit while its original cannot be looked at (Codex review)", async () => {
    const folder = path.join(dir, "Talks");
    fs.mkdirSync(folder);
    const original = path.join(folder, "Talk.mp4");
    fs.renameSync(recording, original);
    recording = original;
    await store.save(await record());
    const copy = path.join(dir, "Copy.mp4");
    fs.copyFileSync(original, copy);
    fs.utimesSync(copy, fs.statSync(original).atime, fs.statSync(original).mtime);
    fs.chmodSync(folder, 0o000);
    try {
      expect(await store.load(copy, await sourceIdentity(copy))).toEqual({ kind: "none" });
    } finally {
      fs.chmodSync(folder, 0o755);
    }
    expect([...store.edited().keys()]).toEqual([original]);
  });
});
