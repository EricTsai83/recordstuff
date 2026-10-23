/**
 * The Recording Studio's rates and timing (plans 081 and 092), with no imports, so the native runners load them under
 * Node's type stripping as they are (`scripts/acceptance-studio.mts`); studio-port.ts re-exports them.
 */

/** How often the Studio shows its preview and meters while someone works in it (D21), and while it is only looked at (plan 081, D1). */
export const STUDIO_FPS = 10;
export const STUDIO_RESTING_FPS = 5;
/** Smooth's rate (plan 092, D1). */
export const STUDIO_SMOOTH_FPS = 15;
/** The preview's rates the capture process accepts (plan 092, D1), as its engine's `PREVIEW_RATES`. */
export const STUDIO_RATES = [STUDIO_RESTING_FPS, STUDIO_FPS, STUDIO_SMOOTH_FPS] as const;
export type StudioFps = (typeof STUDIO_RATES)[number];
/** How long the full rate lasts after a key, click or scroll in the Studio with the pointer outside it (studio-pace.ts). */
export const STUDIO_ACTIVE_MS = 3000;
