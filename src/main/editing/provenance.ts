/**
 * Writes a saved copy's provenance (shared/provenance.ts) into its `moov/udta`, before the copy is published (plan 100,
 * D4). The engine finishes every file it writes with its `moov` last (mux/mp4.rs `finish`), so the `moov` is rewritten
 * in place at the file's end and no sample offset moves. A file whose `moov` is not last (a finish that fell back to the
 * fragmented form) is left as it is: the copy is kept without provenance, as a copy saved before plan 100 is.
 */
import fs from "node:fs/promises";
import { PROVENANCE_BOX, PROVENANCE_LIMIT } from "../../shared/provenance";

/** A `moov` larger than this is not rewritten: an hour's index is a few MiB. */
const MOOV_LIMIT = 64 << 20;

interface Box { type: string; start: number; size: number; header: number }

function children(data: Buffer, from: number, to: number): Box[] | undefined {
  const boxes: Box[] = [];
  for (let at = from; at < to;) {
    if (at + 8 > to) return undefined;
    let size = data.readUInt32BE(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) return undefined;
      size = Number(data.readBigUInt64BE(at + 8)); header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) return undefined;
    boxes.push({ type: data.toString("latin1", at + 4, at + 8), start: at, size, header });
    at += size;
  }
  return boxes;
}

function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}

/**
 * The `moov` `payload` (its children, without its header) with `text` as its `udta`'s provenance: any earlier one
 * replaced, the `udta`'s other children kept, a `udta` added at the end when there is none. Undefined for a malformed one.
 */
export function withProvenance(payload: Buffer, text: string): Buffer | undefined {
  const boxes = children(payload, 0, payload.length);
  if (!boxes) return undefined;
  const entry = box(PROVENANCE_BOX, Buffer.from(text, "utf8"));
  const parts: Buffer[] = [];
  let placed = false;
  for (const child of boxes) {
    const bytes = payload.subarray(child.start, child.start + child.size);
    if (child.type !== "udta" || placed) { parts.push(bytes); continue; }
    const inner = children(payload, child.start + child.header, child.start + child.size);
    if (!inner) return undefined;
    const kept = inner.filter((b) => b.type !== PROVENANCE_BOX).map((b) => payload.subarray(b.start, b.start + b.size));
    parts.push(box("udta", ...kept, entry));
    placed = true;
  }
  if (!placed) parts.push(box("udta", entry));
  return Buffer.concat(parts);
}

/**
 * Writes `text` as `file`'s provenance. Returns undefined once written, else why it was not (the file is then as it was,
 * unless the write itself failed part way, which the caller treats as a failed save).
 */
export async function writeProvenance(file: string, text: string, open: (file: string) => Promise<fs.FileHandle> = (at) => fs.open(at, "r+")): Promise<string | undefined> {
  if (Buffer.byteLength(text, "utf8") > PROVENANCE_LIMIT) return "the provenance is too long";
  const handle = await open(file);
  try {
    const { size } = await handle.stat();
    const header = Buffer.alloc(16);
    let last: { type: string; at: number; size: number; header: number } | undefined;
    for (let at = 0; at < size;) {
      const { bytesRead } = await handle.read(header, 0, 16, at);
      if (bytesRead < 8) return "a box header is cut short";
      let boxSize = header.readUInt32BE(0);
      let headerSize = 8;
      if (boxSize === 1) {
        if (bytesRead < 16) return "a box header is cut short";
        boxSize = Number(header.readBigUInt64BE(8)); headerSize = 16;
      } else if (boxSize === 0) boxSize = size - at;
      if (boxSize < headerSize || at + boxSize > size) return "its boxes do not add up to the file";
      last = { type: header.toString("latin1", 4, 8), at, size: boxSize, header: headerSize };
      at += boxSize;
    }
    if (last?.type !== "moov") return "its movie index is not at its end";
    if (last.size > MOOV_LIMIT) return "its movie index is too large";
    const payload = Buffer.alloc(last.size - last.header);
    const { bytesRead } = await handle.read(payload, 0, payload.length, last.at + last.header);
    if (bytesRead !== payload.length) return "its movie index could not be read";
    const rewritten = withProvenance(payload, text);
    if (!rewritten) return "its movie index is malformed";
    const moov = box("moov", rewritten);
    // Every byte, however many calls the system takes; a write that stops short throws, so the save fails (Codex F1).
    for (let done = 0; done < moov.length;) {
      const { bytesWritten } = await handle.write(moov, done, moov.length - done, last.at + done);
      if (bytesWritten <= 0) throw Object.assign(new Error(`the movie index was written only in part (${done} of ${moov.length} bytes)`), { code: "EIO" });
      done += bytesWritten;
    }
    if (last.at + moov.length < size) await handle.truncate(last.at + moov.length);
    await handle.sync();
    return undefined;
  } finally {
    await handle.close();
  }
}
