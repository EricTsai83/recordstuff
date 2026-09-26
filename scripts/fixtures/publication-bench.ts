/**
 * Only bundled into a measurement directory by `pnpm bench:publication` and
 * run under Electron's own Node (ELECTRON_RUN_AS_NODE), so publication uses the
 * app's libuv. Each file is written through the production FileWriter into the
 * target folder in fixed chunks, published by `finish` and reported as one
 * JSON line; nothing is recorded and no window opens.
 */
import fs from "node:fs";
import path from "node:path";
import { FileWriter } from "../../src/main/file-writer";

interface BenchConfig {
  dir: string;
  sizes: number[];
  repeat: number;
  keep: boolean;
  chunkBytes: number;
}

async function main(): Promise<void> {
  const config = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8")) as BenchConfig;
  // Not zeros: no file system may treat the content as sparse or compressible.
  const chunk = new Uint8Array(config.chunkBytes);
  for (let i = 0; i < chunk.length; i += 1) chunk[i] = Math.imul(i, 2654435761) >>> 24;
  for (let round = 1; round <= config.repeat; round += 1) {
    for (const bytes of config.sizes) {
      const stem = path.join(config.dir, `bench-${process.pid}-${round}-${bytes}`);
      const writer = await FileWriter.open(`${stem}.recording.mp4`, `${stem}.mp4`);
      const began = performance.now();
      try {
        for (let written = 0; written < bytes; written += chunk.length) {
          await writer.append(bytes - written >= chunk.length ? chunk : chunk.subarray(0, bytes - written));
        }
        const wrote = performance.now();
        const saved = await writer.finish();
        console.log(JSON.stringify({ round, bytes, writeMs: wrote - began, finishMs: performance.now() - wrote, ...writer.finishTimings }));
        if (!config.keep) fs.rmSync(saved, { force: true });
      } catch (cause) {
        console.log(JSON.stringify({ round, bytes, error: cause instanceof Error ? cause.message : String(cause) }));
        const kept = await writer.abandon();
        if (kept && !config.keep) fs.rmSync(kept, { force: true });
      }
    }
  }
}

main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.stack ?? cause.message : String(cause));
  process.exit(1);
});
