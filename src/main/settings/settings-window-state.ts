import fs from "node:fs";
import { keepFile } from "../lib/file-backup";
import { writeFileAtomic } from "../lib/atomic-file";
import { drainQueue } from "../lib/drain-queue";
import { errnoCode } from "../lib/errors";

export interface WindowSize { width: number; height: number }
/**
 * Room for the sidebar beside three recording cards in a row and unhurried settings rows (2026-10-04);
 * narrower windows put the tabs on top. A smaller work area still fits it down (`fitSettingsSize`).
 */
export const DEFAULT_SETTINGS_SIZE: WindowSize = { width: 960, height: 640 };
/** Only the current layout is read; older layouts are backed up and reset once. */
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
  private resetPending = false;
  private backedUp = false;
  private newerOnDisk = false;
  constructor(private readonly file: string, private readonly log: (message: string) => void = () => {}) {
    try {
      const size: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!size || typeof size !== "object" || Array.isArray(size)) throw new Error("invalid window state");
      const layout = (size as { layout?: unknown } | null)?.layout;
      this.newerOnDisk = typeof layout === "number" && layout > LAYOUT;
      if (this.newerOnDisk) return;
      if (layout !== LAYOUT) {
        if (layout !== undefined && (!Number.isSafeInteger(layout) || (layout as number) < 1)) throw new Error("invalid window layout");
        this.resetPending = true;
        this.stored = { ...DEFAULT_SETTINGS_SIZE };
        this.write("reset");
        return;
      }
      const zoom = (size as { zoom?: unknown } | null)?.zoom;
      if (validZoom(zoom)) this.currentZoom = zoom;
      const sized = typeof size === "object" && size !== null && ("width" in size || "height" in size);
      if (!sized) return;
      if (!validSize(size)) throw new Error("invalid window size");
      this.current = this.stored = { width: size.width, height: size.height };
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
    const snapshot = { layout: LAYOUT, ...(this.stored ? { width: this.stored.width, height: this.stored.height } : {}), ...(this.currentZoom !== 1 ? { zoom: this.currentZoom } : {}) };
    this.queue = this.queue.then(async () => {
      if (this.newerOnDisk) throw new Error("Window state is from a newer app version; refusing to overwrite it");
      if (this.resetPending && !this.backedUp) { await keepFile(this.file, "reset-backup"); this.backedUp = true; }
      await writeFileAtomic(this.file, JSON.stringify(snapshot));
      this.resetPending = false;
    })
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
