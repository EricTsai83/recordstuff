import fs from "node:fs";
import { writeFileAtomic } from "../lib/atomic-file";
import { drainQueue } from "../lib/drain-queue";
import { errnoCode } from "../lib/errors";

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

/** The page's zoom (⌘+ and ⌘-, settings-window.ts `ZOOM_STEPS`); anything outside these bounds reads as 100%. */
function validZoom(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.5 && value <= 3;
}

/** UI geometry is independent of recording preferences and their write queue. */
export class SettingsWindowState {
  private queue: Promise<void> = Promise.resolve();
  private current: WindowSize = { ...DEFAULT_SETTINGS_SIZE };
  /** The size the file holds, which an older default may keep from opening the window: a zoom saved alone keeps it. */
  private stored: WindowSize | undefined;
  private currentZoom = 1;
  constructor(private readonly file: string, private readonly log: (message: string) => void = () => {}) {
    try {
      const size: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      const zoom = (size as { zoom?: unknown } | null)?.zoom;
      if (validZoom(zoom)) this.currentZoom = zoom;
      // A file that keeps only a zoom: the window has not been resized yet.
      const sized = typeof size === "object" && size !== null && ("width" in size || "height" in size);
      if (!sized && validZoom(zoom)) return;
      if (!validSize(size)) throw new Error("invalid window size");
      if ((size as { layout?: unknown }).layout === LAYOUT) this.current = this.stored = { width: size.width, height: size.height };
      else this.log(`settings window: ${size.width}×${size.height} was chosen against an earlier default; opening at the default`);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") this.log(`settings window: size read failed, using default: ${String(error)}`);
    }
  }
  get size(): WindowSize { return { ...this.current }; }
  get zoom(): number { return this.currentZoom; }
  save(size: WindowSize): void {
    if (!validSize(size)) return;
    // Remember within this process even if disk is temporarily unavailable.
    this.current = { ...size };
    this.stored = { ...size };
    this.write("size");
  }
  saveZoom(zoom: number): void {
    if (!validZoom(zoom) || zoom === this.currentZoom) return;
    this.currentZoom = zoom;
    this.write("zoom");
  }
  /** The size the user chose (none yet: the file keeps no size) and the zoom, written together so neither drops the other. */
  private write(what: string): void {
    const snapshot = { ...(this.stored ? { width: this.stored.width, height: this.stored.height, layout: LAYOUT } : {}), ...(this.currentZoom !== 1 ? { zoom: this.currentZoom } : {}) };
    this.queue = this.queue.then(() => writeFileAtomic(this.file, JSON.stringify(snapshot)))
      .catch(error => this.log(`settings window: ${what} save failed: ${String(error)}`));
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
