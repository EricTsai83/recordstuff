import fs from "node:fs";
import { writeFileAtomic } from "./atomic-file";
import { drainQueue } from "./drain-queue";
import { errnoCode } from "./errors";

export interface WindowSize { width: number; height: number }
/**
 * Room for the sidebar beside three recording cards in a row and unhurried settings rows (2026-10-04);
 * narrower windows put the tabs on top. A smaller work area still fits it down (`fitSettingsSize`).
 */
export const DEFAULT_SETTINGS_SIZE: WindowSize = { width: 960, height: 640 };
/**
 * The default a stored size was chosen against. One from before the sidebar (no `layout`) or from the first,
 * narrower sidebar default (`layout: 2`, 720 × 580) is ignored, so the window opens at the current default until
 * the user resizes it; sizes saved since keep the user's choice.
 */
const LAYOUT = 3;
export const MIN_SETTINGS_SIZE: WindowSize = { width: 380, height: 360 };
function validSize(value: unknown): value is WindowSize {
  if (!value || typeof value !== "object") return false;
  const size = value as WindowSize;
  return Number.isSafeInteger(size.width) && size.width > 0 && Number.isSafeInteger(size.height) && size.height > 0;
}

/** UI geometry is independent of recording preferences and their write queue. */
export class SettingsWindowState {
  private queue: Promise<void> = Promise.resolve();
  private current: WindowSize = { ...DEFAULT_SETTINGS_SIZE };
  constructor(private readonly file: string, private readonly log: (message: string) => void = () => {}) {
    try {
      const size: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!validSize(size)) throw new Error("invalid window size");
      if ((size as { layout?: unknown }).layout === LAYOUT) this.current = { width: size.width, height: size.height };
      else this.log(`settings window: ${size.width}×${size.height} was chosen against an earlier default; opening at the default`);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") this.log(`settings window: size read failed, using default: ${String(error)}`);
    }
  }
  get size(): WindowSize { return { ...this.current }; }
  save(size: WindowSize): void {
    if (!validSize(size)) return;
    // Remember within this process even if disk is temporarily unavailable.
    this.current = { ...size };
    const snapshot = { width: size.width, height: size.height, layout: LAYOUT };
    this.queue = this.queue.then(() => writeFileAtomic(this.file, JSON.stringify(snapshot)))
      .catch(error => this.log(`settings window: size save failed: ${String(error)}`));
  }
  async flush(): Promise<void> {
    await drainQueue(() => this.queue);
  }
}

export function fitSettingsSize(size: WindowSize, workArea: WindowSize): WindowSize {
  return {
    width: Math.min(workArea.width, Math.max(MIN_SETTINGS_SIZE.width, size.width)),
    height: Math.min(workArea.height, Math.max(MIN_SETTINGS_SIZE.height, size.height)),
  };
}
