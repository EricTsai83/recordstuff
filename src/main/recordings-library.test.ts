import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingsLibrary, fileId, isListedName, parseRange, stampedTime } from "./recordings-library";

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
  });
});
