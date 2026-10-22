import { errnoCode } from "./errors";

/**
 * On Windows a file another program holds open briefly (a length read in the background, a thumbnail, Explorer, a
 * virus scan or the search indexer) refuses to be renamed or removed for a moment (EPERM, EACCES or EBUSY), and so does
 * a folder holding such a file: the change is tried again for about a second before the last attempt's error stands.
 */
const HELD_OPEN_RETRIES_MS = [50, 100, 200, 300, 400];
const HELD_OPEN = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Runs `change`, retrying while Windows says the file is held open; elsewhere it runs once. */
export async function retryWhileHeldOpen<T>(change: () => Promise<T>, platform: string = process.platform): Promise<T> {
  for (const wait of platform === "win32" ? HELD_OPEN_RETRIES_MS : []) {
    try {
      return await change();
    } catch (cause) {
      if (!HELD_OPEN.has(errnoCode(cause) ?? "")) throw cause;
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
  return change();
}
