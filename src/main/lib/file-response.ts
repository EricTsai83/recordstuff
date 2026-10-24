/**
 * A file served to a page as media (the `recordstuff-media:` scheme, src/main/index.ts): whole, or the byte range a
 * <video> or <audio> element asks for. The recordings library serves recordings with it, and the edit view an editable
 * recording's preview tracks (plan 087).
 */
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";

/** `bytes=start-end`, `bytes=start-` or `bytes=-suffix` within `size`; null for a range that cannot be served. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // An empty file has no byte to serve, whichever form the range takes.
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix === 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start <= end && start < size ? { start, end } : null;
}

/** `file` as a media response, whole or the byte range `request` asks for, as <video> fetches it; 404 when it is gone. */
export async function fileResponse(file: string, type: string, request: Request): Promise<Response> {
  let size: number;
  try { size = (await fs.stat(file)).size; } catch { return new Response(null, { status: 404 }); }
  const range = parseRange(request.headers.get("range"), size);
  if (range === null) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const body = size === 0 ? null : Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      "content-type": type, "accept-ranges": "bytes", "content-length": String(size === 0 ? 0 : end - start + 1),
      ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
    },
  });
}
