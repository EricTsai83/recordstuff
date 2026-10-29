import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CACHE_LIMIT_BYTES, HOLD_MS, VersionCache, versionKey } from "./version-cache";

let root: string;
let now: number;
let free: number;
let held: Set<string>;
const logs: string[] = [];

function cache(): VersionCache {
  return new VersionCache({ root, log: (line) => logs.push(line), now: () => now, freeSpace: async () => free, held: (key) => held.has(key) });
}

async function made(versions: VersionCache, source: string, kind: "video" | "sound", bytes: number, edit = ""): Promise<string> {
  const key = versionKey({ size: 1, mtimeMs: 2, hash: source, edit, kind });
  const pending = await versions.begin(key);
  await fs.promises.writeFile(path.join(pending.dir, "content.mp4"), Buffer.alloc(bytes));
  await versions.commit(pending, { source, kind, content: "content.mp4" });
  return key;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "versions-"));
  now = 1_000_000;
  free = 500 * 1024 ** 3;
  held = new Set();
  logs.length = 0;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("the version cache (plan 100)", () => {
  it("keys a version by the recording's bytes, its edit and the version", () => {
    const base = { size: 10, mtimeMs: 20, hash: "a", edit: "", kind: "video" as const };
    expect(versionKey(base)).toMatch(/^[0-9a-f]{32}$/);
    expect(versionKey(base)).toBe(versionKey({ ...base }));
    for (const change of [{ size: 11 }, { mtimeMs: 21 }, { hash: "b" }, { edit: "cut" }, { kind: "sound" as const }]) {
      expect(versionKey({ ...base, ...change }), JSON.stringify(change)).not.toBe(versionKey(base));
    }
  });

  it("puts an entry into place whole and finds it again after a launch, removing what a crash left", async () => {
    const versions = cache();
    const source = path.join(root, "..", `${path.basename(root)}-a.mp4`);
    fs.writeFileSync(source, "a recording");
    const key = await made(versions, source, "video", 10);
    const gone = await made(versions, "/r/gone.mp4", "video", 5);
    expect(versions.get(key)).toMatchObject({ source, kind: "video", bytes: 10, made: now });
    fs.mkdirSync(path.join(root, ".part-0123456789ab"));
    fs.mkdirSync(path.join(root, "f".repeat(32)));
    fs.writeFileSync(path.join(root, "f".repeat(32), "entry.json"), "{ not json");
    const again = cache();
    await again.scan();
    expect(again.get(key)).toMatchObject({ source, bytes: 10 });
    // A recording deleted while RecordStuff was not following the folder takes its entries at the next launch (Codex F4).
    expect(again.get(gone)).toBeUndefined();
    expect(fs.readdirSync(root)).toEqual([key]);
    expect(again.size()).toBe(10);
    fs.rmSync(source);
  });

  it("hands a version out as a hard link under its outgoing name, and holds it for 24 hours", async () => {
    const versions = cache();
    const key = await made(versions, "/r/a.mp4", "video", 10);
    const file = await versions.handOut(versions.get(key)!, "Meeting.mp4");
    expect(path.basename(file)).toBe("Meeting.mp4");
    expect(fs.statSync(file).ino).toBe(fs.statSync(versions.contentPath(versions.get(key)!)).ino);
    // Another language's name is added; the earlier one stays, since a page may still be reading it (Codex F5).
    const renamed = await versions.handOut(versions.get(key)!, "會議.mp4");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(renamed)).toBe(true);
    expect(await versions.handOut(versions.get(key)!, "Meeting.mp4"), "the same name again").toBe(file);
    expect(versions.isHeld(versions.get(key)!)).toBe(true);
    now += HOLD_MS;
    expect(versions.isHeld(versions.get(key)!)).toBe(false);
  });

  it("lets a recording's older entry of a version go once it is edited again, unless it is held", async () => {
    const versions = cache();
    const first = await made(versions, "/r/a.mp4", "video", 10, "one");
    await versions.handOut(versions.get(first)!, "a.mp4");
    const second = await made(versions, "/r/a.mp4", "video", 10, "two");
    expect(versions.get(first), "held: handed out within a day").toBeDefined();
    now += HOLD_MS;
    const third = await made(versions, "/r/a.mp4", "video", 10, "three");
    expect(versions.get(first)).toBeUndefined();
    expect(versions.get(second)).toBeUndefined();
    expect(versions.get(third)).toBeDefined();
    // Another version of it, and another recording's, are not touched.
    const sound = await made(versions, "/r/a.mp4", "sound", 1);
    await made(versions, "/r/b.mp4", "video", 1);
    expect(versions.get(sound)).toBeDefined();
  });

  it("keeps within 10 GB or 10% of the free space, oldest first, never what is held", async () => {
    const versions = cache();
    free = 1000;
    expect(await versions.limit()).toBe(100);
    free = 500 * 1024 ** 3;
    expect(await versions.limit()).toBe(CACHE_LIMIT_BYTES);
    free = 1000;
    const oldest = await made(versions, "/r/1.mp4", "video", 40);
    now += 1;
    const handed = await made(versions, "/r/2.mp4", "video", 40);
    await versions.handOut(versions.get(handed)!, "2.mp4");
    now += 1;
    const clipboard = await made(versions, "/r/3.mp4", "video", 40);
    held.add(clipboard);
    now += 1;
    // 160 bytes against a limit of 100: the oldest goes, the two held stay though still over, and the one just made
    // stays until it is handed out (Codex F6).
    const newest = await made(versions, "/r/4.mp4", "video", 40);
    expect(versions.get(oldest)).toBeUndefined();
    expect(versions.get(handed)).toBeDefined();
    expect(versions.get(clipboard)).toBeDefined();
    expect(versions.get(newest)).toBeDefined();
    expect(versions.size()).toBe(120);
    // One larger than the limit on its own is still kept once made.
    const huge = await made(versions, "/r/5.mp4", "video", 500);
    expect(versions.get(huge)).toBeDefined();
    expect(versions.get(newest), "not held, older: it goes now").toBeUndefined();
  });

  it("never trims an entry while it is being handed out (Codex pass 2)", async () => {
    const versions = cache();
    free = 1000;
    const ready = await made(versions, "/r/1.mp4", "video", 80);
    now += 1;
    // A hand-out begins; another version is made meanwhile and takes the cache over its limit.
    const link = fs.promises.link;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let begun!: () => void;
    const started = new Promise<void>((resolve) => { begun = resolve; });
    (fs.promises as { link: typeof link }).link = async (...args) => { begun(); await gate; return link(...args); };
    const given = versions.handOut(versions.get(ready)!, "1.mp4");
    await started;
    (fs.promises as { link: typeof link }).link = link;
    await made(versions, "/r/2.mp4", "video", 80);
    expect(versions.get(ready), "pinned while it is handed out").toBeDefined();
    release();
    expect(fs.existsSync(await given)).toBe(true);
    expect(versions.isHeld(versions.get(ready)!)).toBe(true);
  });

  it("removes a recording's entries at once when it is deleted or leaves the folder, held or not", async () => {
    const versions = cache();
    const a = await made(versions, "/r/a.mp4", "video", 1);
    await versions.handOut(versions.get(a)!, "a.mp4");
    const b = await made(versions, "/r/b.mp4", "video", 1);
    await versions.removeSource("/r/a.mp4", "deleted");
    expect(versions.get(a)).toBeUndefined();
    expect(fs.existsSync(path.join(root, a))).toBe(false);
    expect(versions.sources()).toEqual(new Set(["/r/b.mp4"]));
    expect(versions.get(b)).toBeDefined();
  });

  it("follows a recording renamed in the tab, and clears all but what is held", async () => {
    const versions = cache();
    const a = await made(versions, "/r/a.mp4", "video", 1);
    const b = await made(versions, "/r/b.mp4", "video", 1);
    await versions.handOut(versions.get(b)!, "b.mp4");
    await versions.moved("/r/a.mp4", "/r/x/a.mp4");
    expect(versions.get(a)?.source).toBe("/r/x/a.mp4");
    expect(JSON.parse(fs.readFileSync(path.join(root, a, "entry.json"), "utf8"))).toMatchObject({ source: "/r/x/a.mp4" });
    await versions.clear();
    expect(versions.get(a)).toBeUndefined();
    expect(versions.get(b)).toBeDefined();
  });
});
