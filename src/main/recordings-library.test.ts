import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LENGTHS_PUBLISH_MS, RecordingsLibrary, THUMBNAILS_KEPT, WATCH_SETTLE_MS, fileId, isListedName, parseRange, stampedTime } from "./recordings-library";
import { formatTimestamp } from "./recorder";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-library-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function setup() {
  const changed = vi.fn();
  const deps = {
    dir: () => dir, changed, log: vi.fn(),
    thumbnail: vi.fn(async () => Buffer.from("png")),
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
    expect(parseRange(null, 10)).toBeUndefined();
  });
});

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
    expect([thumb.status, thumb.headers.get("content-type"), await thumb.text()]).toEqual([200, "image/png", "png"]);
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
      const added = touch("new.mp4");
      await vi.waitFor(() => expect(library.state.files.map(file => file.name)).toEqual(["new.mp4"]), { timeout: 3000 });
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
      fs.writeFileSync(path.join(other, "there.mp4"), "x");
      await vi.waitFor(() => expect(library.state.files.map(file => file.name)).toEqual(["there.mp4"]), { timeout: 3000 });
      library.unwatch();
      folder = path.join(other, "missing");
      library.watch(); library.watch();
      expect(log.mock.calls.filter(([line]) => String(line).includes("cannot watch"))).toHaveLength(1);
      // Still wanted: once the folder lists, it is followed without another activation (review pass 1, F2).
      fs.mkdirSync(folder);
      await library.refresh();
      fs.writeFileSync(path.join(folder, "later.mp4"), "x");
      await vi.waitFor(() => expect(library.state.files.map(file => file.name)).toEqual(["later.mp4"]), { timeout: 3000 });
    } finally { library.unwatch(); fs.rmSync(other, { recursive: true, force: true }); }
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
      touch("after.mp4");
      await vi.waitFor(() => expect(library.state.files.map(file => file.name)).toEqual(["after.mp4"]), { timeout: 3000 });
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
  it("moves a listed file to the Trash and lists the folder again; opens and reveals only what it listed", async () => {
    const file = touch("clip.mp4");
    const { library, deps } = setup();
    await library.refresh();
    const id = library.state.files[0]!.id;
    expect(await library.act(id, "open")).toBe(true);
    expect(deps.open).toHaveBeenCalledWith(file);
    expect(await library.act(id, "reveal")).toBe(true);
    expect(deps.reveal).toHaveBeenCalledWith(file);
    expect(await library.act(id, "trash")).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(library.state.files).toEqual([]);
    expect(await library.act(id, "open")).toBe(false);
    deps.open.mockResolvedValueOnce("no application");
    touch("other.mp4"); await library.refresh();
    expect(await library.act(library.state.files[0]!.id, "open")).toBe(false);
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
