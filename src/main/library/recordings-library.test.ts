import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LENGTHS_PUBLISH_MS, RecordingsLibrary, THUMBNAILS_AT_ONCE, THUMBNAILS_KEPT, UNDO_TRASH_MS, WATCH_SETTLE_MS, fileId, isListedName, parseRange, stampedTime } from "./recordings-library";
import { formatTimestamp } from "../recording/recorder";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-library-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function setup() {
  const changed = vi.fn();
  const deps = {
    dir: () => dir, changed, log: vi.fn(),
    thumbnail: vi.fn(async (_file: string): Promise<Buffer | undefined> => Buffer.from("jpeg")),
    trash: vi.fn(async (file: string) => fs.rmSync(file)),
    open: vi.fn(async () => ""), reveal: vi.fn(),
  };
  return { library: new RecordingsLibrary(deps), deps, changed };
}
const touch = (name: string, bytes = "0123456789"): string => { const file = path.join(dir, name); fs.writeFileSync(file, bytes); return file; };

describe("names", () => {
  it("lists finished videos only, and reads the app's own timestamp", () => {
    expect(["a.mp4", "B.MOV", "c.m4v", "2026-10-04 14-02-11.mp4"].every(isListedName)).toBe(true);
    expect(["2026-10-04 14-02-11.recording.mp4", ".hidden.mp4", "notes.txt", "clip.webm"].some(isListedName)).toBe(false);
    expect(stampedTime("2026-10-04 14-02-11-2.mp4")).toBe(new Date(2026, 9, 4, 14, 2, 11).getTime());
    expect(stampedTime("Product demo.mp4")).toBeUndefined();
    expect(fileId("/a/b.mp4")).toBe(fileId("/a/b.mp4"));
    expect(fileId("/a/b.mp4")).not.toBe(fileId("/a/c.mp4"));
  });
  it("reads back the names the recorder writes, and never lists the one it is still writing (recorder.ts openUniqueWriter)", () => {
    const started = new Date(2026, 0, 2, 3, 4, 5);
    const stamp = formatTimestamp(started);
    for (const name of [`${stamp}.mp4`, `${stamp}-2.mp4`]) {
      expect(isListedName(name)).toBe(true);
      expect(stampedTime(name)).toBe(started.getTime());
    }
    expect(isListedName(`${stamp}.recording.mp4`)).toBe(false);
    expect(isListedName(`${stamp}-2.recording.mp4`)).toBe(false);
  });
  it("serves start-end, open-ended and suffix byte ranges, and refuses one past the end", () => {
    expect([parseRange("bytes=0-1", 10), parseRange("bytes=4-", 10), parseRange("bytes=-3", 10), parseRange("bytes=8-99", 10)])
      .toEqual([{ start: 0, end: 1 }, { start: 4, end: 9 }, { start: 7, end: 9 }, { start: 8, end: 9 }]);
    expect([parseRange("bytes=10-", 10), parseRange("bytes=5-2", 10), parseRange("items=0-1", 10), parseRange("bytes=-", 10)]).toEqual([null, null, null, null]);
    expect([parseRange("bytes=-3", 0), parseRange("bytes=0-", 0)]).toEqual([null, null]);
    expect(parseRange(null, 10)).toBeUndefined();
  });
});

/**
 * Writes `file` until the watched library lists `expected`. On macOS libuv starts the FSEvents stream on its own
 * thread after `fs.watch` returns, so a write right after a watcher is attached can precede the stream and go
 * unseen, more often under load. Each write waits longer than the settle delay, so a retry never keeps resetting it.
 */
async function writeUntilListed(library: RecordingsLibrary, file: string, expected: string[]): Promise<void> {
  const listed = (): boolean => JSON.stringify(library.state.files.map(entry => entry.name)) === JSON.stringify(expected);
  for (let attempt = 0; attempt < 6 && !listed(); attempt++) {
    fs.writeFileSync(file, `x${attempt}`);
    await vi.waitFor(() => { if (!listed()) throw new Error("not listed yet"); }, { timeout: WATCH_SETTLE_MS * 4 }).catch(() => undefined);
  }
  expect(library.state.files.map(entry => entry.name)).toEqual(expected);
}

/** A movie header stating `seconds`, enough for mp4Duration. */
const movieOf = (seconds: number): Buffer => {
  const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const mvhd = Buffer.concat([u32(108), Buffer.from("mvhd"), Buffer.alloc(12), u32(1000), u32(seconds * 1000), Buffer.alloc(80)]);
  return Buffer.concat([u32(mvhd.length + 8), Buffer.from("moov"), mvhd]);
};

describe("RecordingsLibrary", () => {
  it("resolves a refresh with the listing, before any length is read, and publishes the lengths after (review pass 1, F2)", async () => {
    fs.writeFileSync(path.join(dir, "a.mp4"), movieOf(2));
    const { library, changed } = setup();
    await library.refresh();
    expect(library.state.files.map(file => [file.name, file.duration])).toEqual([["a.mp4", undefined]]);
    expect(changed).toHaveBeenCalledTimes(1);
    await library.lengths;
    expect(library.state.files[0]!.duration).toBe(2);
    expect(changed).toHaveBeenCalledTimes(2);
    // Known lengths are kept on the next listing, which then reads nothing.
    await library.refresh(); await library.lengths;
    expect(library.state.files[0]!.duration).toBe(2);
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("publishes lengths read so far while a long folder is still being read, then the rest at the end", async () => {
    for (const seconds of [1, 2, 3]) fs.writeFileSync(path.join(dir, `2026-10-0${seconds} 09-00-00.mp4`), movieOf(seconds));
    let clock = 0;
    const changed = vi.fn();
    const library = new RecordingsLibrary({
      dir: () => dir, changed, log: vi.fn(), thumbnail: vi.fn(), trash: vi.fn(), open: vi.fn(), reveal: vi.fn(),
      // Each read takes longer than the publishing interval.
      now: () => (clock += LENGTHS_PUBLISH_MS),
    });
    const seen: (number | undefined)[][] = [];
    changed.mockImplementation(() => seen.push(library.state.files.map(file => file.duration).sort()));
    await library.refresh(); await library.lengths;
    // The listing (newest first), then after each of the first two reads, then the last one once at the end.
    expect(seen).toEqual([[undefined, undefined, undefined], [3, undefined, undefined], [2, 3, undefined], [1, 2, 3]]);
  });

  it("stops reading lengths when the window closes, and reads only the rest on the next listing", async () => {
    for (const seconds of [1, 2, 3]) fs.writeFileSync(path.join(dir, `2026-10-0${seconds} 09-00-00.mp4`), movieOf(seconds));
    let clock = 0;
    const changed = vi.fn();
    const library = new RecordingsLibrary({
      dir: () => dir, changed, log: vi.fn(), thumbnail: vi.fn(), trash: vi.fn(), open: vi.fn(), reveal: vi.fn(),
      now: () => (clock += LENGTHS_PUBLISH_MS),
    });
    const seen: (number | undefined)[][] = [];
    // The window closes as the first length is published.
    changed.mockImplementation(() => {
      seen.push(library.state.files.map(file => file.duration).sort());
      if (seen.length === 2) library.unwatch();
    });
    await library.refresh(); await library.lengths;
    expect(seen).toEqual([[undefined, undefined, undefined], [3, undefined, undefined]]);
    await library.refresh(); await library.lengths;
    expect(seen.at(-1)).toEqual([1, 2, 3]);
  });

  it("lists the folder newest first, skipping a recording still being written and anything not a video", async () => {
    touch("2026-10-03 09-00-00.mp4"); touch("2026-10-04 14-02-11.mp4"); touch("2026-10-04 15-00-00.recording.mp4"); touch("notes.txt");
    fs.mkdirSync(path.join(dir, "folder.mp4"));
    const { library, changed } = setup();
    expect(library.state.loading).toBe(true);
    await library.refresh();
    expect(library.state.files.map(file => file.name)).toEqual(["2026-10-04 14-02-11.mp4", "2026-10-03 09-00-00.mp4"]);
    expect(library.state.files[0]).toMatchObject({ size: 10, recordedAt: new Date(2026, 9, 4, 14, 2, 11).getTime() });
    // Not an MP4 inside, so no length; still listed.
    expect(library.state.files[0]).not.toHaveProperty("duration");
    expect(changed).toHaveBeenCalled();
  });
  it("reports an unreadable folder instead of an empty one", async () => {
    const { library } = setup();
    fs.rmSync(dir, { recursive: true });
    await library.refresh();
    expect(library.state).toMatchObject({ failed: true, loading: false, files: [] });
    fs.mkdirSync(dir);
  });
  it("serves a listed video whole or by range, and nothing for an id it did not list", async () => {
    touch("clip.mp4");
    const { library } = setup();
    await library.refresh();
    const id = library.state.files[0]!.id;
    const whole = await library.handle(new Request(`recordstuff-media://video/${id}`));
    expect([whole.status, whole.headers.get("accept-ranges"), await whole.text()]).toEqual([200, "bytes", "0123456789"]);
    const part = await library.handle(new Request(`recordstuff-media://video/${id}`, { headers: { range: "bytes=2-5" } }));
    expect([part.status, part.headers.get("content-range"), await part.text()]).toEqual([206, "bytes 2-5/10", "2345"]);
    expect((await library.handle(new Request(`recordstuff-media://video/${id}`, { headers: { range: "bytes=20-" } }))).status).toBe(416);
    expect((await library.handle(new Request(`recordstuff-media://video/${fileId("/etc/hosts")}`))).status).toBe(404);
    expect((await library.handle(new Request(`recordstuff-media://other/${id}`))).status).toBe(404);
    const thumb = await library.handle(new Request(`recordstuff-media://thumb/${id}`));
    expect([thumb.status, thumb.headers.get("content-type"), await thumb.text()]).toEqual([200, "image/jpeg", "jpeg"]);
  });
  it("lets the page keep a thumbnail only under the address of the file's current version", async () => {
    touch("clip.mp4");
    const { library } = setup();
    await library.refresh();
    const { id, version } = library.state.files[0]!;
    const cacheControl = async (query: string) =>
      (await library.handle(new Request(`recordstuff-media://thumb/${id}${query}`))).headers.get("cache-control");
    expect(await cacheControl(`?v=${version}`)).toBe("max-age=31536000, immutable");
    expect(await cacheControl("?v=10-0")).toBe("no-cache");
    expect(await cacheControl("")).toBe("no-cache");
  });
  it("makes at most a few thumbnails at once, then the newest asked first", async () => {
    for (let index = 0; index < THUMBNAILS_AT_ONCE + 2; index++) touch(`clip-${index}.mp4`);
    const { library, deps } = setup();
    const pending = new Map<string, { resolve: (jpeg: Buffer) => void; reject: (cause: Error) => void }>();
    let making = 0, most = 0;
    deps.thumbnail.mockImplementation(file => new Promise<Buffer | undefined>((resolve, reject) => {
      making++; most = Math.max(most, making);
      const done = () => { making--; pending.delete(file); };
      pending.set(file, { resolve: jpeg => { done(); resolve(jpeg); }, reject: cause => { done(); reject(cause); } });
    }));
    await library.refresh();
    const files = library.state.files;
    const jpegs = files.map(file => library.thumbnail(file));
    await vi.waitFor(() => expect(deps.thumbnail).toHaveBeenCalledTimes(THUMBNAILS_AT_ONCE));
    pending.get(files[1]!.path)!.resolve(Buffer.from("one"));
    await vi.waitFor(() => expect(deps.thumbnail).toHaveBeenCalledTimes(THUMBNAILS_AT_ONCE + 1));
    // After a fast scroll the newest asked are the cards in view; the ones asked on the way past wait.
    expect(deps.thumbnail).toHaveBeenLastCalledWith(files[THUMBNAILS_AT_ONCE + 1]!.path);
    // A failed one gives up its turn as well.
    pending.get(files[0]!.path)!.reject(new Error("unreadable"));
    await vi.waitFor(() => expect(deps.thumbnail).toHaveBeenCalledTimes(THUMBNAILS_AT_ONCE + 2));
    expect(deps.thumbnail).toHaveBeenLastCalledWith(files[THUMBNAILS_AT_ONCE]!.path);
    for (const { resolve } of [...pending.values()]) resolve(Buffer.from("rest"));
    expect((await Promise.all(jpegs)).map(jpeg => jpeg?.toString())).toEqual([undefined, "one", ...Array<string>(THUMBNAILS_AT_ONCE).fill("rest")]);
    expect(most).toBe(THUMBNAILS_AT_ONCE);
  });
  it("does not let the page keep a picture read after the file changed under its address", async () => {
    const file = touch("clip.mp4");
    const { library, deps } = setup();
    await library.refresh();
    const { id, version } = library.state.files[0]!;
    // The picture is read once the file has changed, as when it waited its turn meanwhile.
    deps.thumbnail.mockImplementationOnce(async () => { fs.writeFileSync(file, "longer content now"); return Buffer.from("new"); });
    const thumb = await library.handle(new Request(`recordstuff-media://thumb/${id}?v=${version}`));
    expect([thumb.status, thumb.headers.get("cache-control")]).toEqual([200, "no-cache"]);
  });
  it("makes a renamed file's thumbnail from its new name when the old one was not made yet", async () => {
    for (let index = 0; index < THUMBNAILS_AT_ONCE + 1; index++) touch(`clip-${index}.mp4`);
    const { library, deps } = setup();
    // The first few are held until the rename; every later one reads at once.
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    deps.thumbnail.mockImplementation(async file => {
      await held;
      return fs.existsSync(file) ? Buffer.from(path.basename(file)) : undefined;
    });
    await library.refresh();
    const waiting = library.state.files[THUMBNAILS_AT_ONCE]!;
    const jpegs = library.state.files.map(file => library.thumbnail(file));
    await vi.waitFor(() => expect(deps.thumbnail).toHaveBeenCalledTimes(THUMBNAILS_AT_ONCE));
    const renamed = await library.rename(waiting.id, "Renamed");
    expect(renamed).toEqual({ id: fileId(path.join(dir, "Renamed.mp4")) });
    release();
    await Promise.all(jpegs);
    const listed = library.state.files.find(file => file.name === "Renamed.mp4")!;
    expect((await library.thumbnail(listed))?.toString()).toBe("Renamed.mp4");
  });
  it("carries a made thumbnail over to a file's new name", async () => {
    touch("clip.mp4");
    const { library, deps } = setup();
    await library.refresh();
    await library.thumbnail(library.state.files[0]!);
    await library.rename(library.state.files[0]!.id, "Renamed");
    await library.thumbnail(library.state.files[0]!);
    expect(deps.thumbnail).toHaveBeenCalledTimes(1);
  });
  it("makes a thumbnail once per version of a file", async () => {
    const file = touch("clip.mp4");
    const { library, deps } = setup();
    await library.refresh();
    await library.thumbnail(library.state.files[0]!); await library.thumbnail(library.state.files[0]!);
    expect(deps.thumbnail).toHaveBeenCalledTimes(1);
    fs.writeFileSync(file, "longer content now"); await library.refresh();
    await library.thumbnail(library.state.files[0]!);
    expect(deps.thumbnail).toHaveBeenCalledTimes(2);
  });
  it("reads the folder once more for any number of refreshes asked while it is being read", async () => {
    touch("a.mp4");
    const { library } = setup();
    const readdir = vi.spyOn(fs.promises, "readdir");
    try {
      const first = library.refresh();
      touch("b.mp4");
      const later = [library.refresh(), library.refresh()];
      expect(later[0]).toBe(later[1]);
      await Promise.all([first, ...later]);
      expect(readdir).toHaveBeenCalledTimes(2);
      // The shared listing began after the later requests, so it has what they were made for.
      expect(library.state.files.map(file => file.name).sort()).toEqual(["a.mp4", "b.mp4"]);
      await library.refresh();
      expect(readdir).toHaveBeenCalledTimes(3);
    } finally { readdir.mockRestore(); }
  });
  it("while watched, follows videos added or removed in the folder, ignoring a recording still being written", async () => {
    const { library } = setup();
    await library.refresh();
    library.watch();
    try {
      const readdir = vi.spyOn(fs.promises, "readdir");
      touch("2026-10-04 15-00-00.recording.mp4");
      await new Promise(resolve => setTimeout(resolve, WATCH_SETTLE_MS * 3));
      expect(readdir).not.toHaveBeenCalled();
      readdir.mockRestore();
      const added = path.join(dir, "new.mp4");
      await writeUntilListed(library, added, ["new.mp4"]);
      fs.rmSync(added);
      await vi.waitFor(() => expect(library.state.files).toEqual([]), { timeout: 3000 });
    } finally { library.unwatch(); }
  });
  it("stops watching when unwatched, follows a changed folder, and says once that a folder cannot be watched", async () => {
    let folder = dir;
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-library-other-"));
    const log = vi.fn();
    const library = new RecordingsLibrary({ dir: () => folder, changed: vi.fn(), log,
      thumbnail: vi.fn(async () => undefined), trash: vi.fn(async () => {}), open: vi.fn(async () => ""), reveal: vi.fn() });
    try {
      library.watch(); library.unwatch();
      touch("ignored.mp4");
      await new Promise(resolve => setTimeout(resolve, WATCH_SETTLE_MS * 3));
      expect(library.state.loading).toBe(true);
      library.watch();
      folder = other; await library.refresh();
      await writeUntilListed(library, path.join(other, "there.mp4"), ["there.mp4"]);
      library.unwatch();
      folder = path.join(other, "missing");
      library.watch(); library.watch();
      // Looked at asynchronously, so a folder whose server is gone never holds the main process.
      await vi.waitFor(() => expect(log.mock.calls.filter(([line]) => String(line).includes("cannot watch"))).toHaveLength(1));
      library.watch();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(log.mock.calls.filter(([line]) => String(line).includes("cannot watch"))).toHaveLength(1);
      // Still wanted: once the folder lists, it is followed without another activation (review pass 1, F2).
      fs.mkdirSync(folder);
      await library.refresh();
      await writeUntilListed(library, path.join(folder, "later.mp4"), ["later.mp4"]);
    } finally { library.unwatch(); fs.rmSync(other, { recursive: true, force: true }); }
  });
  it("lists a save or a changed folder only while the window follows the folder", async () => {
    touch("a.mp4");
    const { library } = setup();
    const readdir = vi.spyOn(fs.promises, "readdir");
    try {
      await library.refreshIfWatched();
      expect(readdir).not.toHaveBeenCalled();
      library.watch();
      await library.refreshIfWatched();
      expect(readdir).toHaveBeenCalledTimes(1);
      library.unwatch();
      await library.refreshIfWatched();
      expect(readdir).toHaveBeenCalledTimes(1);
    } finally { readdir.mockRestore(); library.unwatch(); }
  });
  it("never reads the folder synchronously when the window asks to follow it", async () => {
    const { library } = setup();
    const statSync = vi.spyOn(fs, "statSync");
    try {
      library.watch();
      await library.refresh();
      await writeUntilListed(library, path.join(dir, "followed.mp4"), ["followed.mp4"]);
      expect(statSync).not.toHaveBeenCalled();
    } finally { statSync.mockRestore(); library.unwatch(); }
  });
  // macOS watches folders by path (FSEvents), so this passes there either way; on Windows and Linux the watcher holds
  // the folder itself, and the library attaches to the replacement (review pass 2, P2-2).
  it("follows a folder replaced at the same path while watched", async () => {
    const { library } = setup();
    await library.refresh();
    library.watch();
    try {
      fs.rmSync(dir, { recursive: true }); fs.mkdirSync(dir);
      await library.refresh();
      await writeUntilListed(library, path.join(dir, "after.mp4"), ["after.mp4"]);
    } finally { library.unwatch(); }
  });
  it("forgets the length and thumbnail of a file that left the folder", async () => {
    const file = touch("clip.mp4");
    const { library, deps } = setup();
    await library.refresh(); await library.lengths;
    const listed = library.state.files[0]!;
    await library.thumbnail(listed);
    fs.rmSync(file); await library.refresh();
    // The same name and content again is a new file to the library: its thumbnail is made afresh.
    const mtime = new Date(Number(listed.version.split("-")[1]));
    fs.writeFileSync(file, "0123456789"); fs.utimesSync(file, mtime, mtime);
    await library.refresh();
    expect(library.state.files[0]!.version).toBe(listed.version);
    await library.thumbnail(library.state.files[0]!);
    expect(deps.thumbnail).toHaveBeenCalledTimes(2);
  });
  it("keeps only the thumbnails shown most recently, making an older one again when it is shown", async () => {
    for (let index = 0; index <= THUMBNAILS_KEPT; index++) touch(`clip-${String(index).padStart(3, "0")}.mp4`);
    const { library, deps } = setup();
    await library.refresh();
    const files = [...library.state.files].sort((a, b) => a.name.localeCompare(b.name));
    for (const file of files.slice(0, THUMBNAILS_KEPT)) await library.thumbnail(file);
    // Shown again, the first becomes the newest, so the one past the limit evicts the second instead.
    await library.thumbnail(files[0]!);
    await library.thumbnail(files[THUMBNAILS_KEPT]!);
    expect(deps.thumbnail).toHaveBeenCalledTimes(THUMBNAILS_KEPT + 1);
    await library.thumbnail(files[0]!);
    expect(deps.thumbnail).toHaveBeenCalledTimes(THUMBNAILS_KEPT + 1);
    await library.thumbnail(files[1]!);
    expect(deps.thumbnail).toHaveBeenCalledTimes(THUMBNAILS_KEPT + 2);
    expect(deps.thumbnail).toHaveBeenLastCalledWith(files[1]!.path);
  });
  it("takes a file off the list at once and moves it to the Trash later; opens and reveals only what it listed", async () => {
    const file = touch("clip.mp4");
    const { library, deps } = setup();
    await library.refresh();
    const id = library.state.files[0]!.id;
    expect(await library.act(id, "open")).toBe(true);
    expect(deps.open).toHaveBeenCalledWith(file);
    expect(await library.act(id, "reveal")).toBe(true);
    expect(deps.reveal).toHaveBeenCalledWith(file);
    expect(await library.act(id, "trash")).toBe(true);
    // Off the list, with Undo offered, while the file itself waits.
    expect(library.state.files).toEqual([]);
    expect(library.state.trashed).toEqual({ name: "clip.mp4" });
    expect(fs.existsSync(file)).toBe(true);
    expect(deps.trash).not.toHaveBeenCalled();
    await library.flushTrash();
    expect(deps.trash).toHaveBeenCalledWith(file);
    expect(fs.existsSync(file)).toBe(false);
    expect(library.state.trashed).toBeUndefined();
    expect(await library.act(id, "open")).toBe(false);
    deps.open.mockResolvedValueOnce("no application");
    touch("other.mp4"); await library.refresh();
    expect(await library.act(library.state.files[0]!.id, "open")).toBe(false);
  });
  it("moves a waiting file once its time is up, and brings back the newest one first on Undo (2026-10-05)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const first = touch("first.mp4"), second = touch("second.mp4");
      const { library, deps } = setup();
      await library.refresh();
      const idOf = (file: string): string => library.state.files.find(item => item.path === file)!.id;
      await library.act(idOf(first), "trash");
      await library.act(idOf(second), "trash");
      expect(library.state).toMatchObject({ files: [], trashed: { name: "second.mp4" } });
      expect(await library.undoTrash()).toBe(true);
      expect(library.state.files.map(file => file.name)).toEqual(["second.mp4"]);
      expect(library.state.trashed).toEqual({ name: "first.mp4" });
      await vi.advanceTimersByTimeAsync(UNDO_TRASH_MS);
      // The timer began the move, which reads the file's identity from disk first: a flush waits on that same move.
      await library.flushTrash();
      expect(deps.trash.mock.calls).toEqual([[first]]);
      expect(library.state.trashed).toBeUndefined();
      // Nothing left waiting: Undo has nothing to bring back, and the one brought back stays.
      expect(await library.undoTrash()).toBe(false);
      await vi.advanceTimersByTimeAsync(UNDO_TRASH_MS);
      expect(fs.existsSync(second)).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("waits once for a file asked to go to the Trash twice, so Undo keeps it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const file = touch("clip.mp4");
      const { library, deps } = setup();
      await library.refresh();
      const id = library.state.files[0]!.id;
      // Two requests overlap: both found the file in the same listing.
      expect(await Promise.all([library.act(id, "trash"), library.act(id, "trash")])).toEqual([true, true]);
      expect(await library.undoTrash()).toBe(true);
      expect(library.state.files.map(item => item.name)).toEqual(["clip.mp4"]);
      await vi.advanceTimersByTimeAsync(UNDO_TRASH_MS);
      await library.flushTrash();
      expect(deps.trash).not.toHaveBeenCalled();
      expect(fs.existsSync(file)).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("lists a file again and says so when its delayed move to the Trash fails", async () => {
    const file = touch("clip.mp4");
    const { library, deps } = setup();
    await library.refresh();
    await library.act(library.state.files[0]!.id, "trash");
    deps.trash.mockRejectedValueOnce(new Error("volume has no Trash"));
    await library.flushTrash();
    expect(library.state.files.map(item => item.path)).toEqual([file]);
    expect(library.state).toMatchObject({ trashFailed: "clip.mp4" });
    expect(library.state.trashed).toBeUndefined();
    // The next action on a file clears it.
    await library.act(library.state.files[0]!.id, "reveal");
    expect(library.state.trashFailed).toBeUndefined();
  });
  it("offers no Undo once a move has begun, and moves a file once however many flushes overlap it (review pass 1, F2)", async () => {
    const file = touch("clip.mp4");
    const { library, deps } = setup();
    await library.refresh();
    await library.act(library.state.files[0]!.id, "trash");
    let finish!: () => void;
    deps.trash.mockImplementationOnce(file => new Promise<void>(resolve => { finish = () => { fs.rmSync(file); resolve(); }; }));
    const first = library.flushTrash();
    // The move is under way: nothing to bring back, and the file stays off the list.
    expect(library.state.trashed).toBeUndefined();
    expect(await library.undoTrash()).toBe(false);
    const second = library.flushTrash();
    await library.refresh();
    expect(library.state.files).toEqual([]);
    // The move reads the file's identity from disk before it calls the Trash.
    await vi.waitFor(() => expect(deps.trash).toHaveBeenCalledTimes(1));
    finish();
    await Promise.all([first, second]);
    expect(deps.trash).toHaveBeenCalledTimes(1);
    expect([fs.existsSync(file), library.state.trashFailed]).toEqual([false, undefined]);
  });
  it("leaves another file now at a waiting file's path where it is, and lists it (review pass 2, F1)", async () => {
    const file = touch("clip.mp4");
    const { library, deps } = setup();
    await library.refresh();
    await library.act(library.state.files[0]!.id, "trash");
    // Renamed in Finder meanwhile, and a different file saved under the old name.
    fs.renameSync(file, path.join(dir, "kept.mp4"));
    touch("clip.mp4", "replacement");
    await library.flushTrash();
    expect(deps.trash).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8")).toBe("replacement");
    expect(library.state.files.map(item => item.name).sort()).toEqual(["clip.mp4", "kept.mp4"]);
    expect(library.state.trashed).toBeUndefined();
  });
  it("refuses to wait on a file that already left the folder", async () => {
    const file = touch("clip.mp4");
    const { library } = setup();
    await library.refresh();
    fs.rmSync(file);
    expect(await library.act(library.state.files[0]!.id, "trash")).toBe(false);
    expect(library.state.trashed).toBeUndefined();
  });
  it("renames within the folder keeping the extension, never over another file, and keeps its cached length", async () => {
    const file = touch("2026-10-04 14-02-11.mp4");
    touch("Taken.mp4");
    const { library, deps } = setup();
    await library.refresh();
    const id = library.state.files.find(item => item.path === file)!.id;
    expect(await library.rename(id, "Taken")).toEqual({ problem: "exists" });
    expect(await library.rename(id, "a/b")).toEqual({ problem: "characters" });
    expect(await library.rename(id, "  ")).toEqual({ problem: "empty" });
    expect(await library.rename(id, ".hidden")).toEqual({ problem: "dot" });
    expect(fs.existsSync(file)).toBe(true);
    const renamed = await library.rename(id, " Product demo ");
    const target = path.join(dir, "Product demo.mp4");
    expect(renamed).toEqual({ id: fileId(target) });
    expect([fs.existsSync(file), fs.readFileSync(target, "utf8")]).toEqual([false, "0123456789"]);
    expect(library.state.files.map(item => item.name).sort()).toEqual(["Product demo.mp4", "Taken.mp4"]);
    expect(await library.rename(id, "Again")).toEqual({ problem: "missing" });
    // The same name changes nothing.
    expect(await library.rename(fileId(target), "Product demo")).toEqual({ id: fileId(target) });
    expect(deps.log).toHaveBeenCalledWith(`library: renamed ${file} to ${target}`);
  });
  it("keeps a renamed file's length and thumbnail through a listing that began before the rename", async () => {
    const file = touch("clip.mp4");
    fs.writeFileSync(file, movieOf(2));
    const { library, deps } = setup();
    await library.refresh(); await library.lengths;
    await library.thumbnail(library.state.files[0]!);
    expect(deps.thumbnail).toHaveBeenCalledTimes(1);
    // A listing (a focus, a folder event) reads the folder just before the rename, and finishes after it.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const readdir = fsPromises.readdir;
    vi.spyOn(fsPromises, "readdir").mockImplementationOnce((async (...args: Parameters<typeof readdir>) => {
      const entries = await readdir(...args);
      await gate;
      return entries;
    }) as typeof readdir);
    const stale = library.refresh();
    const target = path.join(dir, "Demo.mp4");
    const renaming = library.rename(library.state.files[0]!.id, "Demo");
    await vi.waitFor(() => expect([fs.existsSync(file), fs.existsSync(target)]).toEqual([false, true]));
    release();
    await stale;
    expect(await renaming).toEqual({ id: fileId(target) });
    const renamed = library.state.files.find(item => item.path === target)!;
    expect(renamed.duration).toBe(2);
    await library.thumbnail(renamed);
    expect(deps.thumbnail).toHaveBeenCalledTimes(1);
  });
  it("never replaces another file on a volume without hard links, reserving the new name first (review pass 1, F1)", async () => {
    const file = touch("clip.mp4");
    const { library } = setup();
    await library.refresh();
    const id = library.state.files[0]!.id;
    const unsupported = Object.assign(new Error("not supported"), { code: "ENOTSUP" });
    const link = vi.spyOn(fsPromises, "link").mockRejectedValue(unsupported);
    try {
      // Another file takes the name after the check: the exclusive create finds it, and it is kept as it was.
      const lstat = vi.spyOn(fsPromises, "lstat").mockImplementationOnce(async target => {
        fs.writeFileSync(String(target), "someone else's");
        throw Object.assign(new Error("absent when checked"), { code: "ENOENT" });
      });
      expect(await library.rename(id, "Taken")).toEqual({ problem: "exists" });
      expect(fs.readFileSync(path.join(dir, "Taken.mp4"), "utf8")).toBe("someone else's");
      expect(fs.existsSync(file)).toBe(true);
      lstat.mockRestore();
      // A free name: the file moves onto its placeholder, with nothing left behind.
      const renamed = await library.rename(id, "Demo");
      expect(renamed).toEqual({ id: fileId(path.join(dir, "Demo.mp4")) });
      expect(fs.readdirSync(dir).sort()).toEqual(["Demo.mp4", "Taken.mp4"]);
      expect(fs.readFileSync(path.join(dir, "Demo.mp4"), "utf8")).toBe("0123456789");
    } finally { link.mockRestore(); }
  });
  it("says a reveal failed when the file left the folder since the listing", async () => {
    const file = touch("clip.mp4");
    const { library, deps } = setup();
    await library.refresh();
    fs.rmSync(file);
    expect(await library.act(library.state.files[0]!.id, "reveal")).toBe(false);
    expect(deps.reveal).not.toHaveBeenCalled();
    // The answer's listing no longer has it, so the page can say it left rather than "try again".
    expect(library.state.files).toEqual([]);
  });
  it("lists the folder again before answering a failed open, keeping a file that is still there", async () => {
    const kept = touch("kept.mp4"), gone = touch("gone.mp4");
    const { library, deps } = setup();
    await library.refresh();
    const idOf = (file: string): string => library.state.files.find(item => item.path === file)!.id;
    const goneId = idOf(gone);
    fs.rmSync(gone);
    deps.open.mockResolvedValue("The file could not be opened");
    expect(await library.act(goneId, "open")).toBe(false);
    expect(library.state.files.map(item => item.path)).toEqual([kept]);
    expect(await library.act(idOf(kept), "open")).toBe(false);
    expect(library.state.files.map(item => item.path)).toEqual([kept]);
  });
});
