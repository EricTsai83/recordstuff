/**
 * Turns the capture host's fragmented MP4 into a plain one as it is saved (docs/system-design/recording.md#plain-mp4-at-save),
 * as OBS's hybrid MP4 does. A fragmented file has no index of its own: Chromium reads every fragment's header before
 * it shows the first frame, about a second for a 36-minute recording and longer for longer ones, and again on every
 * open. While recording, `FragmentIndex` follows the bytes the writer has written, keeping only the movie header and
 * each fragment's sample list, never the media. At stop `finalize` builds the whole movie's index (a `moov` with every
 * sample's size, duration and place in the file); the writer appends it and then turns the old fragmented header
 * into the start of one `mdat` that covers everything up to it, so a player sees ftyp, mdat, moov. Nothing is copied
 * or moved, so saving stays constant time. Anything this does not understand leaves the file fragmented, as before.
 */

/** A box larger than this is not a header the capture host writes; following it would only hold memory. */
const MAX_HEADER_BOX = 16 << 20;
/** Header boxes `push` keeps whole; everything else, the media above all, is only skipped over. */
const KEPT = new Set(["ftyp", "moov", "moof"]);
/** A `stbl`'s boxes that `finalize` rewrites; any other would describe the fragments wrongly once rebuilt. */
const SAMPLE_TABLES = new Set(["stts", "stsc", "stsz", "stz2", "stco", "co64", "stss", "ctts"]);
/** The 64-bit `mdat` header written over the old `moov`: size 1, type, then the real size. */
export const MDAT_HEADER_SIZE = 16;
/** trun: sample_is_non_sync_sample, in a sample's flags. */
const NON_SYNC = 0x10000;

interface Box { type: string; start: number; size: number; header: number }

/** The boxes inside `data` from `from` to `to`; a box that does not fit is an error, not a truncation. */
function children(data: Buffer, from = 0, to = data.length): Box[] {
  const boxes: Box[] = [];
  for (let at = from; at < to;) {
    if (at + 8 > to) throw new Error("box header cut short");
    let size = data.readUInt32BE(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) throw new Error("box header cut short");
      size = Number(data.readBigUInt64BE(at + 8)); header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) throw new Error(`box at ${at} does not fit`);
    boxes.push({ type: data.toString("latin1", at + 4, at + 8), start: at, size, header });
    at += size;
  }
  return boxes;
}
const inside = (data: Buffer, box: Box): Box[] => children(data, box.start + box.header, box.start + box.size);
/** A full box's version and flags, then the offset its fields start at. */
const full = (data: Buffer, box: Box): { version: number; flags: number; at: number } => {
  const at = box.start + box.header;
  return { version: data[at]!, flags: data.readUIntBE(at + 1, 3), at: at + 4 };
};

const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u64 = (n: number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const box = (type: string, ...parts: Buffer[]): Buffer => {
  const length = parts.reduce((sum, part) => sum + part.length, 8);
  return Buffer.concat([u32(length), Buffer.from(type, "latin1"), ...parts]);
};
const fullBox = (type: string, version: number, flags: number, ...parts: Buffer[]): Buffer =>
  box(type, Buffer.from([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);

/** Unsigned 32-bit values appended one at a time, in a buffer that doubles as it fills. */
class U32List {
  values = new Uint32Array(1024);
  length = 0;
  push(value: number): void {
    if (this.length === this.values.length) {
      const grown = new Uint32Array(this.values.length * 2);
      grown.set(this.values);
      this.values = grown;
    }
    this.values[this.length++] = value;
  }
}

interface Track {
  id: number;
  timescale: number;
  /** trex: what a fragment's samples are when neither tfhd nor trun says. */
  defaults: { description: number; duration: number; size: number; flags: number };
  sizes: U32List;
  durations: U32List;
  /** Composition offsets as unsigned bits, kept from the first sample that has one: until then all are zero. */
  offsets: U32List | undefined;
  negativeOffsets: boolean;
  /** 1-based numbers of the sync samples, kept from the first sample that is not one: until then all are. */
  syncs: U32List | undefined;
  /** One chunk per trun: where its samples start in the file, how many there are and their sample description. */
  chunkOffsets: number[];
  chunkCounts: U32List;
  chunkDescriptions: U32List;
  /** The decode time the next fragment must start at, in `timescale` ticks. */
  decodeEnd: number;
}

/** Where every sample of a written fragmented MP4 is, followed as it is written; see the file comment. */
export class FragmentIndex {
  /** Absolute offset of the next byte `push` will see. */
  private offset = 0;
  /** The box being read: its header so far, or, for a kept box, its bytes so far. */
  private pending: Buffer[] = [];
  private pendingLength = 0;
  private current: Box | undefined;
  /** Bytes of a skipped box still to come. */
  private skipping = 0;
  private moov: { data: Buffer; at: number; header: number } | undefined;
  private tracks = new Map<number, Track>();
  /** Every mdat's payload, so `finalize` can check each chunk lies inside one. */
  private mdats: Array<{ from: number; to: number }> = [];
  /** Why the file cannot be finalized; once set, nothing more is read. */
  private failure: string | undefined;

  get unusable(): string | undefined {
    return this.failure;
  }

  /** Follows `bytes`, the next ones written to the file. Never throws: what it cannot follow it gives up on. */
  push(bytes: Uint8Array): void {
    if (this.failure) return;
    try {
      this.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    } catch (cause) {
      this.fail(cause instanceof Error ? cause.message : String(cause));
    }
  }

  private fail(reason: string): void {
    this.failure ??= reason;
    // Nothing kept is needed any more.
    this.pending = [];
    this.tracks.clear();
    this.moov = undefined;
  }

  private read(bytes: Buffer): void {
    let at = 0;
    while (at < bytes.length && !this.failure) {
      if (this.skipping > 0) {
        const step = Math.min(this.skipping, bytes.length - at);
        this.skipping -= step;
        at += step;
        this.offset += step;
        continue;
      }
      // A header is 8 bytes, or 16 when its size is 64-bit; a kept box is read whole.
      const box = this.current;
      const wanted = box ? box.size : this.pendingLength >= 8 && this.peekSize() === 1 ? 16 : 8;
      const step = Math.min(wanted - this.pendingLength, bytes.length - at);
      this.pending.push(bytes.subarray(at, at + step));
      this.pendingLength += step;
      at += step;
      this.offset += step;
      if (this.pendingLength < wanted) continue;
      const data = Buffer.concat(this.pending);
      if (box) {
        this.pending = [];
        this.pendingLength = 0;
        this.current = undefined;
        this.take(box, data);
        continue;
      }
      if (wanted === 8 && data.readUInt32BE(0) === 1) continue;
      this.begin(data);
    }
  }

  private peekSize(): number {
    return Buffer.concat(this.pending).readUInt32BE(0);
  }

  /** A box header is complete: keep the box, or skip its body. */
  private begin(header: Buffer): void {
    const start = this.offset - header.length;
    let size = header.readUInt32BE(0);
    if (size === 1) size = Number(header.readBigUInt64BE(8));
    const type = header.toString("latin1", 4, 8);
    if (size === 0) throw new Error(`${type} at ${start} runs to the end of the file`);
    if (size < header.length) throw new Error(`${type} at ${start} is smaller than its header`);
    if (KEPT.has(type)) {
      if (size > MAX_HEADER_BOX) throw new Error(`${type} at ${start} is ${size} bytes`);
      this.current = { type, start, size, header: header.length };
      // The header is the start of the kept box; read goes on until the whole box is in.
      if (size === header.length) {
        this.pending = [];
        this.pendingLength = 0;
        this.current = undefined;
        this.take({ type, start, size, header: header.length }, header);
      }
      return;
    }
    this.pending = [];
    this.pendingLength = 0;
    if (type === "mdat") this.mdats.push({ from: start + header.length, to: start + size });
    this.skipping = size - header.length;
  }

  /** A kept box has been read whole; `data` is the box, header included. */
  private take(box: Box, data: Buffer): void {
    const local = { ...box, start: 0 };
    if (box.type === "moov") {
      if (this.moov) throw new Error("a second moov");
      this.moov = { data, at: box.start, header: box.header };
      this.readMovie(data, local);
    } else if (box.type === "moof") {
      if (!this.moov) throw new Error("a fragment before the moov");
      this.readFragment(data, local, box.start);
    }
  }

  private readMovie(data: Buffer, moov: Box): void {
    const top = inside(data, moov);
    for (const trak of top.filter(b => b.type === "trak")) {
      const parts = inside(data, trak);
      const tkhd = parts.find(b => b.type === "tkhd");
      const mdhd = parts.filter(b => b.type === "mdia").flatMap(b => inside(data, b)).find(b => b.type === "mdhd");
      if (!tkhd || !mdhd) throw new Error("a track without tkhd or mdhd");
      const head = full(data, tkhd);
      const id = data.readUInt32BE(head.at + (head.version === 1 ? 16 : 8));
      const media = full(data, mdhd);
      const timescale = data.readUInt32BE(media.at + (media.version === 1 ? 16 : 8));
      if (!timescale) throw new Error(`track ${id} has no timescale`);
      this.tracks.set(id, {
        id, timescale, defaults: { description: 1, duration: 0, size: 0, flags: 0 },
        sizes: new U32List(), durations: new U32List(), offsets: undefined, negativeOffsets: false,
        syncs: undefined, chunkOffsets: [], chunkCounts: new U32List(), chunkDescriptions: new U32List(),
        decodeEnd: 0,
      });
    }
    const mvex = top.find(b => b.type === "mvex");
    for (const trex of mvex ? inside(data, mvex).filter(b => b.type === "trex") : []) {
      const { at } = full(data, trex);
      const track = this.tracks.get(data.readUInt32BE(at));
      if (track) track.defaults = { description: data.readUInt32BE(at + 4), duration: data.readUInt32BE(at + 8), size: data.readUInt32BE(at + 12), flags: data.readUInt32BE(at + 16) };
    }
    if (this.tracks.size === 0) throw new Error("a movie without tracks");
  }

  private readFragment(data: Buffer, moof: Box, moofStart: number): void {
    // Without a base offset or default-base-is-moof, a traf's data follows the one before it (ISO/IEC 14496-12 8.8.7).
    let previousEnd = moofStart;
    for (const traf of inside(data, moof).filter(b => b.type === "traf")) {
      const parts = inside(data, traf);
      const tfhd = parts.find(b => b.type === "tfhd");
      if (!tfhd) throw new Error("a traf without tfhd");
      const head = full(data, tfhd);
      const track = this.tracks.get(data.readUInt32BE(head.at));
      if (!track) throw new Error(`a fragment of unknown track ${data.readUInt32BE(head.at)}`);
      if (head.flags & 0x10000) throw new Error("an empty-duration fragment");
      let field = head.at + 4;
      let base = head.flags & 0x20000 ? moofStart : previousEnd;
      if (head.flags & 0x1) { base = Number(data.readBigUInt64BE(field)); field += 8; }
      let description = track.defaults.description;
      if (head.flags & 0x2) { description = data.readUInt32BE(field); field += 4; }
      let duration = track.defaults.duration, size = track.defaults.size, flags = track.defaults.flags;
      if (head.flags & 0x8) { duration = data.readUInt32BE(field); field += 4; }
      if (head.flags & 0x10) { size = data.readUInt32BE(field); field += 4; }
      if (head.flags & 0x20) flags = data.readUInt32BE(field);
      const tfdt = parts.find(b => b.type === "tfdt");
      if (tfdt) {
        const decode = full(data, tfdt);
        const time = decode.version === 1 ? Number(data.readBigUInt64BE(decode.at)) : data.readUInt32BE(decode.at);
        this.align(track, time);
      }
      let position = base;
      let first = true;
      for (const trun of parts.filter(b => b.type === "trun")) {
        const run = full(data, trun);
        const count = data.readUInt32BE(run.at);
        let at = run.at + 4;
        if (run.flags & 0x1) { position = base + data.readInt32BE(at); at += 4; }
        else if (first) position = base;
        first = false;
        let firstFlags: number | undefined;
        if (run.flags & 0x4) { firstFlags = data.readUInt32BE(at); at += 4; }
        const stride = [0x100, 0x200, 0x400, 0x800].filter(flag => run.flags & flag).length * 4;
        if (at + count * stride > trun.start + trun.size) throw new Error("a trun longer than its box");
        if (count === 0) continue;
        track.chunkOffsets.push(position);
        track.chunkCounts.push(count);
        track.chunkDescriptions.push(description);
        for (let sample = 0; sample < count; sample++) {
          let sampleDuration = duration, sampleSize = size, sampleFlags = sample === 0 && firstFlags !== undefined ? firstFlags : flags, offset = 0;
          if (run.flags & 0x100) { sampleDuration = data.readUInt32BE(at); at += 4; }
          if (run.flags & 0x200) { sampleSize = data.readUInt32BE(at); at += 4; }
          if (run.flags & 0x400) { const own = data.readUInt32BE(at); at += 4; if (!(sample === 0 && firstFlags !== undefined)) sampleFlags = own; }
          if (run.flags & 0x800) { offset = run.version === 0 ? data.readUInt32BE(at) : data.readInt32BE(at); at += 4; }
          const before = track.sizes.length;
          track.sizes.push(sampleSize);
          track.durations.push(sampleDuration);
          // Most tracks have neither composition offsets nor non-sync samples; their lists start when one appears.
          if (offset !== 0 && !track.offsets) {
            track.offsets = new U32List();
            for (let n = 0; n < before; n++) track.offsets.push(0);
          }
          track.offsets?.push(offset);
          if (offset < 0) track.negativeOffsets = true;
          if (sampleFlags & NON_SYNC) {
            if (!track.syncs) {
              track.syncs = new U32List();
              for (let n = 1; n <= before; n++) track.syncs.push(n);
            }
          } else track.syncs?.push(before + 1);
          track.decodeEnd += sampleDuration;
          position += sampleSize;
        }
      }
      previousEnd = position;
    }
  }

  /**
   * A fragment says when it starts; a plain MP4 says it only by the durations before it. The capture host guesses
   * the duration of each fragment's last sample, and the next fragment's start corrects it, earlier or later (video
   * by up to a few frames, audio by a millisecond), as a fragmented player reads it: the sample before takes the
   * difference, so every sample keeps the decode time it played at.
   */
  private align(track: Track, time: number): void {
    if (time === track.decodeEnd) return;
    const last = track.durations.length - 1;
    // A track starting late needs an edit list, which nothing here writes.
    if (last < 0) throw new Error(`track ${track.id} starts at ${time}, not 0`);
    const corrected = track.durations.values[last]! + (time - track.decodeEnd);
    if (corrected <= 0) throw new Error(`track ${track.id} goes back to ${time}, before its last sample`);
    if (corrected > 0xffffffff) throw new Error(`track ${track.id} has a gap of ${time - track.decodeEnd} ticks`);
    track.durations.values[last] = corrected;
    track.decodeEnd = time;
  }

  /**
   * The movie's whole index for a file of `end` bytes, every one of them pushed: the `moov` to append at `end`, and
   * where the `MDAT_HEADER_SIZE`-byte header goes that turns the old header and every fragment into one `mdat`.
   */
  finalize(end: number): { moov: Buffer; mdatAt: number } | { reason: string } {
    if (this.failure) return { reason: this.failure };
    try {
      if (this.offset !== end) return { reason: `${this.offset} of ${end} bytes were followed` };
      if (this.current || this.pendingLength > 0 || this.skipping > 0) return { reason: "the file ends inside a box" };
      if (!this.moov) return { reason: "no moov" };
      if (this.moov.data.length < MDAT_HEADER_SIZE) return { reason: "a moov too small to become an mdat header" };
      this.checkChunks();
      return { moov: this.buildMovie(end), mdatAt: this.moov.at };
    } catch (cause) {
      return { reason: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /** Every chunk's samples lie inside one mdat, so the new index points at media, never at a header. */
  private checkChunks(): void {
    const mdats = this.mdats;
    for (const track of this.tracks.values()) {
      let sample = 0;
      for (let chunk = 0; chunk < track.chunkOffsets.length; chunk++) {
        const from = track.chunkOffsets[chunk]!;
        let to = from;
        for (let n = 0; n < track.chunkCounts.values[chunk]!; n++) to += track.sizes.values[sample++]!;
        let low = 0, high = mdats.length - 1, found = false;
        while (low <= high) {
          const middle = (low + high) >> 1;
          const mdat = mdats[middle]!;
          if (from < mdat.from) high = middle - 1;
          else if (from >= mdat.to) low = middle + 1;
          else { found = to <= mdat.to; break; }
        }
        if (!found) throw new Error(`track ${track.id} has samples outside every mdat at ${from}`);
      }
    }
  }

  private buildMovie(end: number): Buffer {
    const { data, header } = this.moov!;
    const top = children(data, header, data.length);
    const mvhd = top.find(b => b.type === "mvhd");
    if (!mvhd) throw new Error("a moov without mvhd");
    const head = full(data, mvhd);
    const movieScale = data.readUInt32BE(head.at + (head.version === 1 ? 16 : 8));
    if (!movieScale) throw new Error("a movie without a timescale");
    const wide = end + 16 > 0xffffffff;
    const movieDuration = (track: Track): number => Math.round(track.decodeEnd * movieScale / track.timescale);
    const longest = Math.max(0, ...[...this.tracks.values()].map(movieDuration));
    const parts = top.flatMap(child => {
      if (child.type === "mvex") return [];
      if (child.type === "mvhd") return [withDuration(data, child, longest)];
      if (child.type === "trak") return [this.buildTrack(data, child, movieDuration, wide)];
      return [data.subarray(child.start, child.start + child.size)];
    });
    return box("moov", ...parts);
  }

  private buildTrack(data: Buffer, trak: Box, movieDuration: (track: Track) => number, wide: boolean): Buffer {
    const parts = inside(data, trak);
    const tkhd = parts.find(b => b.type === "tkhd")!;
    const head = full(data, tkhd);
    const track = this.tracks.get(data.readUInt32BE(head.at + (head.version === 1 ? 16 : 8)))!;
    if (parts.some(b => b.type === "edts")) throw new Error(`track ${track.id} has an edit list`);
    const rebuild = (outer: Box): Buffer => {
      const content = inside(data, outer).flatMap(child => {
        if (child.type === "mdhd") return [withDuration(data, child, track.decodeEnd)];
        if (child.type === "mdia" || child.type === "minf") return [rebuild(child)];
        if (child.type === "stbl") return [this.buildSampleTable(data, child, track, wide)];
        return [data.subarray(child.start, child.start + child.size)];
      });
      return box(outer.type, ...content);
    };
    return box("trak", ...parts.map(child => {
      if (child.type === "tkhd") return withDuration(data, child, movieDuration(track));
      if (child.type === "mdia") return rebuild(child);
      return data.subarray(child.start, child.start + child.size);
    }));
  }

  private buildSampleTable(data: Buffer, stbl: Box, track: Track, wide: boolean): Buffer {
    const parts = inside(data, stbl);
    const stsd = parts.find(b => b.type === "stsd");
    if (!stsd) throw new Error(`track ${track.id} has no stsd`);
    const unknown = parts.find(b => b.type !== "stsd" && !SAMPLE_TABLES.has(b.type));
    if (unknown) throw new Error(`track ${track.id} has a ${unknown.type} in its stbl`);
    const count = track.sizes.length;
    const tables = [data.subarray(stsd.start, stsd.start + stsd.size), runs("stts", 0, track.durations.values, count)];
    if (track.offsets) tables.push(runs("ctts", track.negativeOffsets ? 1 : 0, track.offsets.values, count));
    if (track.syncs) tables.push(fullBox("stss", 0, 0, u32(track.syncs.length), ...Array.from(track.syncs.values.subarray(0, track.syncs.length), u32)));
    const chunks: Buffer[] = [];
    for (let chunk = 0; chunk < track.chunkCounts.length; chunk++) {
      const samples = track.chunkCounts.values[chunk]!, description = track.chunkDescriptions.values[chunk]!;
      // stsc names a chunk only where its count or description changes from the one before.
      if (chunk > 0 && samples === track.chunkCounts.values[chunk - 1] && description === track.chunkDescriptions.values[chunk - 1]) continue;
      chunks.push(u32(chunk + 1), u32(samples), u32(description));
    }
    tables.push(fullBox("stsc", 0, 0, u32(chunks.length / 3), ...chunks));
    tables.push(fullBox("stsz", 0, 0, u32(0), u32(count), Buffer.from(bigEndian(track.sizes.values.subarray(0, count)).buffer)));
    tables.push(wide
      ? fullBox("co64", 0, 0, u32(track.chunkOffsets.length), ...track.chunkOffsets.map(u64))
      : fullBox("stco", 0, 0, u32(track.chunkOffsets.length), ...track.chunkOffsets.map(u32)));
    return box("stbl", ...tables);
  }
}

/** A copy of an mvhd, tkhd or mdhd box saying `duration` instead. */
function withDuration(data: Buffer, header: Box, duration: number): Buffer {
  const copy = Buffer.from(data.subarray(header.start, header.start + header.size));
  const { version, at } = full(copy, { ...header, start: 0 });
  // mvhd and mdhd: times, timescale, duration; tkhd: times, track ID, reserved, duration.
  const field = at + (version === 1 ? 16 : 8) + (header.type === "tkhd" ? 8 : 4);
  if (version === 1) copy.writeBigUInt64BE(BigInt(duration), field);
  else if (duration > 0xffffffff) throw new Error(`a ${header.type} too short for its duration`);
  else copy.writeUInt32BE(duration, field);
  return copy;
}

/** stts or ctts: `values`, run-length coded as (count, value) pairs. */
function runs(type: "stts" | "ctts", version: number, values: Uint32Array, count: number): Buffer {
  const entries: number[] = [];
  for (let n = 0; n < count; n++) {
    const value = values[n]!;
    if (entries.length > 0 && entries[entries.length - 1] === value) entries[entries.length - 2] = entries[entries.length - 2]! + 1;
    else entries.push(1, value);
  }
  return fullBox(type, version, 0, u32(entries.length / 2), Buffer.from(bigEndian(Uint32Array.from(entries)).buffer));
}

/** The same 32-bit values in the file's byte order. */
function bigEndian(values: Uint32Array): Uint32Array {
  const out = new Uint32Array(values.length);
  const view = new DataView(out.buffer);
  for (let n = 0; n < values.length; n++) view.setUint32(n * 4, values[n]!);
  return out;
}

/** The header that makes `size` bytes from where it is written one `mdat`. */
export function mdatHeader(size: number): Buffer {
  return Buffer.concat([u32(1), Buffer.from("mdat", "latin1"), u64(size)]);
}
