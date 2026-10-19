/**
 * What goes over the Recording Studio's port (plan 081): main gives the capture process one end of a channel and the
 * Settings page the other while the page shows the recording's preview or meters, so neither the preview's chunks
 * (preview-stream.ts) nor its levels pass through main. The page tells the capture process on it how often to show
 * the preview.
 */

/** How often the Studio shows its preview and meters while someone works in it (D21), and while it is only looked at (plan 081, D1). */
export const STUDIO_FPS = 10;
export const STUDIO_RESTING_FPS = 5;
/** How long the full rate lasts after a key, click or scroll in the Studio with the pointer outside it (studio-pace.ts). */
export const STUDIO_ACTIVE_MS = 3000;

/** The inputs' loudest samples since the last, linear, before muting (plan 075, D19): from the capture process. */
export interface StudioLevelsMessage { type: "levels"; system: number; microphone?: number }
/** The preview's frames a second the page asks for: from the page. */
export interface StudioRateMessage { type: "rate"; fps: typeof STUDIO_FPS | typeof STUDIO_RESTING_FPS }

const isLevel = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 16;

export function isStudioLevels(value: unknown): value is StudioLevelsMessage {
  const m = value as Partial<StudioLevelsMessage> | null;
  return !!m && typeof m === "object" && m.type === "levels" && isLevel(m.system) && (m.microphone === undefined || isLevel(m.microphone));
}

export function isStudioRate(value: unknown): value is StudioRateMessage {
  const m = value as Partial<StudioRateMessage> | null;
  return !!m && typeof m === "object" && m.type === "rate" && (m.fps === STUDIO_FPS || m.fps === STUDIO_RESTING_FPS);
}
