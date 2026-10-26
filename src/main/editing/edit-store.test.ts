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

  it("follow a recording renamed or moved, when it is the same file", async () => {
    const saved = await record();
    await store.save(saved);
    const moved = path.join(dir, "Talk.mp4");
    fs.renameSync(recording, moved);
    await store.moved(recording, moved);
    const loaded = await store.load(moved, await sourceIdentity(moved));
    expect(loaded.kind === "ok" && loaded.record.removed).toEqual(saved.removed);
    expect(fs.existsSync(store.fileFor(recording))).toBe(false);
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
});
