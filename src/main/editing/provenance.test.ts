import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { mp4Facts } from "../library/mp4-duration";
import { parseProvenance, provenanceText, type Provenance } from "../../shared/provenance";
import { withProvenance, writeProvenance } from "./provenance";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-provenance-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const box = (type: string, ...parts: Buffer[]): Buffer => { const body = Buffer.concat(parts); return Buffer.concat([u32(body.length + 8), Buffer.from(type, "latin1"), body]); };
const fullBox = (type: string, ...parts: Buffer[]): Buffer => box(type, Buffer.alloc(4), ...parts);
/** A plain movie of 3 s at 1000 ticks a second, as the engine finishes one: its index last. */
const mvhd = fullBox("mvhd", Buffer.alloc(8), u32(1000), u32(3000), Buffer.alloc(80));
const media = box("mdat", Buffer.alloc(256, 7));
const write = (name: string, ...parts: Buffer[]): string => { const file = path.join(dir, name); fs.writeFileSync(file, Buffer.concat(parts)); return file; };

const PROVENANCE: Provenance = { version: 1, from: "Meeting.recordstuff.mp4", size: 1234, hash: "a".repeat(64), revision: 3, form: "screenOnly", saved: 1_700_000_000_000 };

describe("a saved copy's provenance (plan 100, D4)", () => {
  it("is written into the movie's udta at the file's end and read back, the media untouched", async () => {
    const file = write("copy.mp4", box("ftyp", Buffer.alloc(8)), media, box("moov", mvhd));
    expect(await writeProvenance(file, provenanceText(PROVENANCE))).toBeUndefined();
    const facts = await mp4Facts(file);
    expect(facts).toMatchObject({ seconds: 3, editable: false });
    expect(parseProvenance(facts.provenance)).toEqual(PROVENANCE);
    expect(fs.readFileSync(file).subarray(16, 16 + media.length)).toEqual(media);
  });

  it("replaces an earlier one and keeps the udta's other children, an editable description among them", async () => {
    const rsed = box("rsed", Buffer.from('{"version":1}'));
    const file = write("again.mp4", media, box("moov", mvhd, box("udta", rsed, box("rsfm", Buffer.from("old, and much longer than the new one will be ".repeat(4))))));
    expect(await writeProvenance(file, provenanceText(PROVENANCE))).toBeUndefined();
    const facts = await mp4Facts(file);
    expect(facts.editable).toBe(true);
    expect(parseProvenance(facts.provenance)).toEqual(PROVENANCE);
    // Shorter than before: nothing is left after the new index.
    const bytes = fs.readFileSync(file);
    expect(bytes.readUInt32BE(media.length)).toBe(bytes.length - media.length);
  });

  it("leaves a file whose index is not last, or that is not a movie, as it was", async () => {
    const fragmented = write("fragmented.mp4", box("moov", mvhd), media);
    const before = fs.readFileSync(fragmented);
    expect(await writeProvenance(fragmented, provenanceText(PROVENANCE))).toBe("its movie index is not at its end");
    expect(fs.readFileSync(fragmented)).toEqual(before);
    const text = write("text.mp4", Buffer.from("a whole export"));
    expect(await writeProvenance(text, provenanceText(PROVENANCE))).toBeTypeOf("string");
    expect(fs.readFileSync(text, "utf8")).toBe("a whole export");
    expect(withProvenance(Buffer.from([0, 0, 0, 99, 1, 2]), "x")).toBeUndefined();
  });

  it("writes every byte however short each write is, and fails a write that stops (Codex F1)", async () => {
    const short = (limit: number) => async (file: string) => {
      const handle = await fs.promises.open(file, "r+");
      const write = handle.write.bind(handle) as (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesWritten: number }>;
      return Object.assign(handle, {
        write: async (buffer: Buffer, offset: number, length: number, position: number) => limit === 0 ? { bytesWritten: 0, buffer } : write(buffer, offset, Math.min(length, limit), position),
      });
    };
    const file = write("short.mp4", media, box("moov", mvhd));
    expect(await writeProvenance(file, provenanceText(PROVENANCE), short(7))).toBeUndefined();
    expect(parseProvenance((await mp4Facts(file)).provenance)).toEqual(PROVENANCE);
    const stopped = write("stopped.mp4", media, box("moov", mvhd));
    await expect(writeProvenance(stopped, provenanceText(PROVENANCE), short(0))).rejects.toMatchObject({ code: "EIO" });
  });

  it("is read only in its own shape", () => {
    // A time past what a date holds would make the tab's date formatting throw (Codex F3).
    expect(parseProvenance(JSON.stringify({ ...PROVENANCE, saved: Number.MAX_SAFE_INTEGER }))).toBeUndefined();
    expect(parseProvenance(provenanceText(PROVENANCE))).toEqual(PROVENANCE);
    expect(parseProvenance(JSON.stringify({ ...PROVENANCE, form: "original" }))).toBeUndefined();
    expect(parseProvenance(JSON.stringify({ ...PROVENANCE, hash: "not hex" }))).toBeUndefined();
    expect(parseProvenance(JSON.stringify({ ...PROVENANCE, version: 2 }))).toBeUndefined();
    expect(parseProvenance("{")).toBeUndefined();
    expect(parseProvenance(undefined)).toBeUndefined();
  });
});
