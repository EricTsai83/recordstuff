/** Independent source geometry for matrix checks, before the encoder reports its output. */
import { spawnSync } from "node:child_process";
import type { Dimensions } from "../../../src/shared/quality.ts";
import { systemUiCrop } from "../../../src/shared/system-ui.ts";

interface Rect { x: number; y: number; width: number; height: number }
export interface MatrixDisplay { id: string; bounds: Rect; workArea: Rect; scaleFactor: number }

/** AppKit uses bottom-left coordinates; normalise each work area relative to its display's top-left. */
export function matrixSourceSize(displays: MatrixDisplay[], settings: Record<string, unknown>): Dimensions {
  const preference = settings["display"] as { kind?: string; id?: string } | undefined;
  const display = (preference?.kind === "display" ? displays.find(d => d.id === preference.id) : undefined) ?? displays[0];
  if (!display) throw new Error("Cannot determine the matrix recording source: no display geometry");
  const { bounds, workArea, scaleFactor } = display;
  if (![bounds.x, bounds.y, workArea.x, workArea.y].every(Number.isFinite)
    || ![bounds.width, bounds.height, workArea.width, workArea.height, scaleFactor].every(n => Number.isFinite(n) && n > 0)) {
    throw new Error("Cannot determine the matrix recording source: invalid display geometry");
  }
  const localBounds = { x: 0, y: 0, width: bounds.width, height: bounds.height };
  const localWork = { x: workArea.x - bounds.x, y: bounds.y + bounds.height - workArea.y - workArea.height,
    width: workArea.width, height: workArea.height };
  const crop = systemUiCrop(localBounds, localWork, scaleFactor, {
    menuBar: settings["hideMenuBar"] === true, dock: settings["hideDock"] === true, desktop: settings["hideDesktop"] === true,
  });
  return crop ? { width: crop.width, height: crop.height }
    : { width: Math.floor(bounds.width * scaleFactor / 2) * 2, height: Math.floor(bounds.height * scaleFactor / 2) * 2 };
}

/** Read-only AppKit query: no app launch, focus change, input, or recording. First screen is the primary display. */
export function readMatrixDisplays(): MatrixDisplay[] {
  const script = `ObjC.import("AppKit");
    const rect = r => ({x:r.origin.x,y:r.origin.y,width:r.size.width,height:r.size.height});
    JSON.stringify(ObjC.unwrap($.NSScreen.screens).map(s => ({
      id:String(ObjC.unwrap(s.deviceDescription.objectForKey("NSScreenNumber"))),
      bounds:rect(s.frame),workArea:rect(s.visibleFrame),scaleFactor:s.backingScaleFactor
    })));`;
  const result = spawnSync("osascript", ["-l", "JavaScript", "-e", script], { encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0) throw new Error(`Cannot read matrix display geometry: ${result.error?.message ?? result.stderr.trim()}`);
  return JSON.parse(result.stdout) as MatrixDisplay[];
}
