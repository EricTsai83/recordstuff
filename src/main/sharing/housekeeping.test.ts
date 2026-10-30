import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditStore, editRecord, sourceIdentity } from "../editing/edit-store";
import { Housekeeping, removableRoot } from "./housekeeping";

let dir: string, output: string, store: EditStore;
const swept: string[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "housekeeping-"));
  output = path.join(dir, "Movies");
  fs.mkdirSync(output);
  store = new EditStore(path.join(dir, "edits"));
  swept.length = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function edited(file: string, bytes = "a recording"): Promise<string> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  await store.save(editRecord({ source: await sourceIdentity(file), timescale: 90000, removed: [[0, 9000]], revision: 1 }));
  return file;
}

function setup(outputDir = (): string => output) {
  const changed = vi.fn();
  const housekeeping = new Housekeeping({ store, sweepVersions: async (folder) => { swept.push(folder); }, outputDir, changed, log: () => undefined, platform: process.platform });
  return { housekeeping, changed };
}

describe("what is kept for a recording (plan 100)", () => {
  it("removes the edit of a recording deleted from a disk that is there, and sweeps the versions too", async () => {
    const file = await edited(path.join(output, "Meeting.mp4"));
    const { housekeeping } = setup();
    fs.rmSync(file);
    await housekeeping.run();
    expect(store.edited().size).toBe(0);
    expect(fs.existsSync(store.fileFor(file))).toBe(false);
    expect(swept).toEqual([output]);
  });

  it("lets the edit of a recording renamed or moved in Finder follow it, into a category too", async () => {
    const file = await edited(path.join(output, "Meeting.mp4"));
    const moved = path.join(output, "Talks", "Weekly.mp4");
    fs.mkdirSync(path.dirname(moved));
    fs.renameSync(file, moved);
    const { housekeeping } = setup();
    await housekeeping.run();
    expect([...store.edited().keys()]).toEqual([moved]);
    expect(housekeeping.kept).toEqual([]);
  });

  it("keeps and lists the edit of a recording outside the output folder, and removes it when asked", async () => {
    const file = await edited(path.join(dir, "Old folder", "Meeting.mp4"));
    const { housekeeping, changed } = setup();
    await housekeeping.run();
    expect(housekeeping.kept).toEqual([{ source: file, reason: "elsewhere", bytes: fs.statSync(store.fileFor(file)).size }]);
    expect(changed).toHaveBeenCalledTimes(1);
    await housekeeping.run();
    expect(changed, "unchanged, nothing is drawn again").toHaveBeenCalledTimes(1);
    await housekeeping.removeKept();
    expect(store.edited().size).toBe(0);
    expect(housekeeping.kept).toEqual([]);
  });

  it("removes the edits of a folder left behind when asked as it was left", async () => {
    const old = path.join(dir, "Old folder");
    const leaving = await edited(path.join(old, "A.mp4"));
    const staying = await edited(path.join(output, "B.mp4"), "another");
    const { housekeeping } = setup();
    await housekeeping.removeIn(old);
    expect([...store.edited().keys()]).toEqual([staying]);
    expect(fs.existsSync(store.fileFor(leaving))).toBe(false);
  });

  it("keeps the edit of a recording whose disk is away, listed as such", async () => {
    // A disk that is not there, as each platform names one: a drive letter no runner has on Windows.
    const away = process.platform === "win32" ? "Q:\\RecordStuff-test\\Movies\\Meeting.mp4" : "/Volumes/RecordStuff-test-drive-that-is-not-here/Movies/Meeting.mp4";
    const identity = { ...(await sourceIdentity(await edited(path.join(output, "Seed.mp4")))), path: away };
    await store.discard(path.join(output, "Seed.mp4"));
    await store.save(editRecord({ source: identity, timescale: 90000, removed: [[0, 9000]], revision: 1 }));
    const { housekeeping } = setup();
    await housekeeping.run();
    expect(housekeeping.kept).toMatchObject([{ source: away, reason: "disk" }]);
    expect([...store.edited().keys()]).toEqual([away]);
  });

  it("knows which disks can go away", () => {
    expect(removableRoot("/Volumes/Drive/Movies/a.mp4", "darwin")).toBe("/Volumes/Drive");
    expect(removableRoot("/Users/me/Movies/a.mp4", "darwin")).toBeUndefined();
    expect(removableRoot("D:\\Videos\\a.mp4", "win32")).toBe("D:\\");
  });

  // A folder or file made unreadable by its mode: Windows ignores the mode, so these run on macOS only.
  it.skipIf(process.platform === "win32")("decides nothing about an edit while its recording or the output folder cannot be read (Codex review)", async () => {
    const category = path.join(output, "Talks");
    const file = await edited(path.join(output, "Meeting.mp4"));
    // Renamed in Finder into a category that cannot be read now.
    fs.mkdirSync(category);
    fs.renameSync(file, path.join(category, "Weekly.mp4"));
    fs.chmodSync(category, 0o000);
    const { housekeeping } = setup();
    try {
      await housekeeping.run();
      expect([...store.edited().keys()], "kept: the search could not see everything").toEqual([file]);
    } finally {
      fs.chmodSync(category, 0o755);
    }
    await housekeeping.run();
    expect([...store.edited().keys()]).toEqual([path.join(category, "Weekly.mp4")]);
  });

  it.skipIf(process.platform === "win32")("keeps an edit while a file that may be its renamed recording cannot be read (Codex review)", async () => {
    const file = await edited(path.join(output, "Meeting.mp4"));
    const renamed = path.join(output, "Weekly.mp4");
    fs.renameSync(file, renamed);
    fs.chmodSync(renamed, 0o000);
    const { housekeeping } = setup();
    try {
      await housekeeping.run();
      expect([...store.edited().keys()]).toEqual([file]);
    } finally {
      fs.chmodSync(renamed, 0o644);
    }
    await housekeeping.run();
    expect([...store.edited().keys()]).toEqual([renamed]);
  });
});
