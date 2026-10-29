import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copiedFiles, filesPropertyList, saveInto } from "./give";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "give-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("giving versions (plan 100 step 3)", () => {
  it("copies a version's file, or a Sources folder's files without the folder (D7)", async () => {
    const video = path.join(dir, "Meeting.mp4");
    fs.writeFileSync(video, "video");
    const sources = path.join(dir, "Meeting sources");
    fs.mkdirSync(sources);
    for (const name of ["Meeting - Screen.mp4", "Meeting - Microphone.m4a", ".DS_Store"]) fs.writeFileSync(path.join(sources, name), name);
    expect(await copiedFiles(video)).toEqual([video]);
    expect(await copiedFiles(sources)).toEqual([path.join(sources, "Meeting - Microphone.m4a"), path.join(sources, "Meeting - Screen.mp4")]);
  });

  it("saves under each version's own name, numbered where the name is taken, never over another file", async () => {
    const from = path.join(dir, "cache"), to = path.join(dir, "Desktop");
    fs.mkdirSync(from); fs.mkdirSync(to);
    fs.writeFileSync(path.join(from, "Meeting.mp4"), "new");
    fs.mkdirSync(path.join(from, "Meeting sources"));
    fs.writeFileSync(path.join(from, "Meeting sources", "Meeting - Screen.mp4"), "screen");
    fs.writeFileSync(path.join(to, "Meeting.mp4"), "someone's own");
    const written = await saveInto(to, [path.join(from, "Meeting.mp4"), path.join(from, "Meeting sources")]);
    expect(written).toEqual([path.join(to, "Meeting 2.mp4"), path.join(to, "Meeting sources")]);
    expect(fs.readFileSync(path.join(to, "Meeting.mp4"), "utf8")).toBe("someone's own");
    expect(fs.readFileSync(path.join(to, "Meeting 2.mp4"), "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(to, "Meeting sources", "Meeting - Screen.mp4"), "utf8")).toBe("screen");
    // Saved again: the folder is numbered too.
    expect(await saveInto(to, [path.join(from, "Meeting sources")])).toEqual([path.join(to, "Meeting sources 2")]);
    // An independent copy: changing the cache's file leaves the saved one.
    fs.writeFileSync(path.join(from, "Meeting.mp4"), "changed");
    expect(fs.readFileSync(path.join(to, "Meeting 2.mp4"), "utf8")).toBe("new");
  });

  it("lists files for the pasteboard with their paths escaped", () => {
    expect(filesPropertyList(["/a/Q&A <1>.mp4"])).toContain("<array><string>/a/Q&amp;A &lt;1&gt;.mp4</string></array>");
  });
});
