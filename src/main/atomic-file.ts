/**
 * Whole-file replacement for small metadata files: settings, window size and
 * failure history. A reader sees either the previous or the new content, also
 * after a crash or power loss: the content goes to `<file>.tmp`, is flushed to
 * disk, and only then renamed over `file`. Without the flush a rename can
 * reach the disk before the data and leave an empty file behind.
 *
 * A failed attempt removes its temporary file and leaves `file` untouched.
 * Callers serialize writes to one file; the fixed temporary name means an
 * interrupted attempt is overwritten by the next one instead of accumulating.
 */
import fs from "node:fs";
import path from "node:path";

export interface AtomicWriteOptions {
  /** Permission bits for a newly created file. */
  mode?: number;
}

/** Ordered chunks are encoded about 1 MiB per write, so a large file never needs one long main-thread encode. */
export async function writeFileAtomic(file: string, content: string | readonly string[], options: AtomicWriteOptions = {}): Promise<void> {
  const temporary = `${file}.tmp`;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const handle = await fs.promises.open(temporary, "w", options.mode);
  let open = true;
  try {
    // A FileHandle writeFile continues from the current position.
    let batch = "";
    for (const chunk of typeof content === "string" ? [content] : content) {
      batch += chunk;
      if (batch.length >= 1 << 20) { await handle.writeFile(batch, "utf8"); batch = ""; }
    }
    if (batch || typeof content === "string") await handle.writeFile(batch, "utf8");
    await handle.sync();
    open = false;
    await handle.close();
    await fs.promises.rename(temporary, file);
  } catch (error) {
    if (open) await handle.close().catch(() => undefined);
    await fs.promises.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** For writes that must also complete during app shutdown. */
export function writeFileAtomicSync(file: string, content: string, options: AtomicWriteOptions = {}): void {
  const temporary = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd: number | undefined = fs.openSync(temporary, "w", options.mode);
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* Keep the original error. */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* Never created. */ }
    throw error;
  }
}
