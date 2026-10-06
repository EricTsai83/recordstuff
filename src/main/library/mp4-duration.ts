/**
 * How long an MP4 plays, read from its boxes rather than by decoding it, for the
 * Recordings tab (docs/system-design/desktop.md#recordings). The capture host
 * writes fragmented MP4, whose `mvhd` says 0: the length is the last fragment's
 * start (`tfdt`) plus its samples' durations (`trun`, or the defaults in `tfhd`
 * and `trex`), in its track's `mdhd` timescale. A plain MP4 keeps its length
 * in `mvhd`. Only box headers are read on the way, so a long recording costs
 * one small read per fragment, never its media.
 */
import fs from "node:fs/promises";

interface Box { type: string; start: number; size: number; header: number }

/** The boxes inside `data` from `from` to `to`; a truncated last box is left out. */
function children(data: Buffer, from = 0, to = data.length): Box[] {
  const boxes: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = data.readUInt32BE(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = Number(data.readBigUInt64BE(at + 8)); header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) break;
    boxes.push({ type: data.toString("latin1", at + 4, at + 8), start: at, size, header });
    at += size;
  }
  return boxes;
}
const inside = (data: Buffer, box: Box): Box[] => children(data, box.start + box.header, box.start + box.size);
const find = (boxes: Box[], type: string): Box | undefined => boxes.find(b => b.type === type);
/** A full box's version, then the offset its fields start at. */
const full = (data: Buffer, box: Box): { version: number; flags: number; at: number } => {
  const at = box.start + box.header;
  return { version: data[at]!, flags: data.readUIntBE(at + 1, 3), at: at + 4 };
};
const uint = (data: Buffer, at: number, wide: boolean): number => wide ? Number(data.readBigUInt64BE(at)) : data.readUInt32BE(at);

interface Track { timescale: number; defaultDuration: number }

/** Each track's timescale and fragment default duration, and the movie's own length when it states one. */
function movie(data: Buffer): { tracks: Map<number, Track>; seconds?: number } {
  const top = children(data);
  const tracks = new Map<number, Track>();
  let seconds: number | undefined;
  const mvhd = find(top, "mvhd");
  if (mvhd) {
    const { version, at } = full(data, mvhd);
    const wide = version === 1;
    const timescale = data.readUInt32BE(at + (wide ? 16 : 8));
    // All ones means unknown, in either width; the 64-bit value is compared before it loses precision.
    const unknown = wide ? data.readBigUInt64BE(at + 20) === 0xffffffffffffffffn : data.readUInt32BE(at + 12) === 0xffffffff;
    const duration = uint(data, at + (wide ? 20 : 12), wide);
    if (timescale > 0 && duration > 0 && !unknown) seconds = duration / timescale;
  }
  for (const trak of top.filter(b => b.type === "trak")) {
    const parts = inside(data, trak);
    const tkhd = find(parts, "tkhd");
    const mdia = find(parts, "mdia");
    const mdhd = mdia && find(inside(data, mdia), "mdhd");
    if (!tkhd || !mdhd) continue;
    const head = full(data, tkhd);
    const id = data.readUInt32BE(head.at + (head.version === 1 ? 16 : 8));
    const media = full(data, mdhd);
    tracks.set(id, { timescale: data.readUInt32BE(media.at + (media.version === 1 ? 16 : 8)), defaultDuration: 0 });
  }
  const mvex = find(top, "mvex");
  for (const trex of mvex ? inside(data, mvex).filter(b => b.type === "trex") : []) {
    const { at } = full(data, trex);
    const track = tracks.get(data.readUInt32BE(at));
    if (track) track.defaultDuration = data.readUInt32BE(at + 8);
  }
  return { tracks, ...(seconds === undefined ? {} : { seconds }) };
}

/** Where a fragment ends, in seconds: the longest of its tracks. */
function fragmentEnd(data: Buffer, tracks: Map<number, Track>): number | undefined {
  let end: number | undefined;
  for (const traf of children(data).filter(b => b.type === "traf")) {
    const parts = inside(data, traf);
    const tfhd = find(parts, "tfhd");
    const tfdt = find(parts, "tfdt");
    if (!tfhd || !tfdt) continue;
    const head = full(data, tfhd);
    const track = tracks.get(data.readUInt32BE(head.at));
    if (!track?.timescale) continue;
    let field = head.at + 4;
    if (head.flags & 0x1) field += 8;
    if (head.flags & 0x2) field += 4;
    const defaultDuration = head.flags & 0x8 ? data.readUInt32BE(field) : track.defaultDuration;
    const decode = full(data, tfdt);
    let ticks = uint(data, decode.at, decode.version === 1);
    for (const trun of parts.filter(b => b.type === "trun")) {
      const run = full(data, trun);
      const count = data.readUInt32BE(run.at);
      let at = run.at + 4 + (run.flags & 0x1 ? 4 : 0) + (run.flags & 0x4 ? 4 : 0);
      const stride = [0x100, 0x200, 0x400, 0x800].filter(flag => run.flags & flag).length * 4;
      if (!(run.flags & 0x100)) { ticks += count * defaultDuration; continue; }
      for (let sample = 0; sample < count && at + 4 <= trun.start + trun.size; sample++, at += stride) ticks += data.readUInt32BE(at);
    }
    const seconds = ticks / track.timescale;
    end = Math.max(end ?? 0, seconds);
  }
  return end;
}

/** The playing time in seconds, or undefined for a file whose boxes do not say. Never throws. */
export async function mp4Duration(filePath: string): Promise<number | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const { size } = await handle.stat();
    const header = Buffer.alloc(16);
    const read = async (at: number, length: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle!.read(buffer, 0, length, at);
      return buffer.subarray(0, bytesRead);
    };
    let moov: Buffer | undefined;
    let lastMoof: { at: number; size: number } | undefined;
    // Box headers only, from the start: every fragment is a moof and an mdat.
    for (let at = 0; at + 8 <= size;) {
      const { bytesRead } = await handle.read(header, 0, 16, at);
      if (bytesRead < 8) break;
      let boxSize = header.readUInt32BE(0);
      let headerSize = 8;
      if (boxSize === 1) { if (bytesRead < 16) break; boxSize = Number(header.readBigUInt64BE(8)); headerSize = 16; }
      else if (boxSize === 0) boxSize = size - at;
      if (boxSize < headerSize || at + boxSize > size) break;
      const type = header.toString("latin1", 4, 8);
      // Both stay small: a movie header and one second's fragment index, never the media.
      if (type === "moov" && boxSize <= 16 << 20) moov = (await read(at + headerSize, boxSize - headerSize));
      if (type === "moof" && boxSize <= 16 << 20) lastMoof = { at: at + headerSize, size: boxSize - headerSize };
      at += boxSize;
    }
    if (!moov) return undefined;
    const { tracks, seconds } = movie(moov);
    const fragment = lastMoof ? fragmentEnd(await read(lastMoof.at, lastMoof.size), tracks) : undefined;
    const result = fragment ?? seconds;
    return result !== undefined && Number.isFinite(result) && result > 0 ? result : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}
