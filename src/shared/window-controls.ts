/**
 * Where macOS draws the Settings window's controls, which `titleBarStyle: "hiddenInset"` insets in the page's top
 * edge (docs/system-design/desktop.md). No imports: the app (settings-window.ts), the Settings fixture and the
 * native acceptance runner, which Node loads directly, read the same numbers.
 */
export const TRAFFIC_LIGHT_POSITION = { x: 18, y: 18 } as const;
/**
 * The top-left corner the window controls occupy, in points from the window's corner, with a few points of air.
 * macOS 26 draws three 16 pt buttons 7 pt apart, at 17, 40 and 63 pt from the left and 17 pt from the top
 * (read through Accessibility on 2026-10-04), so they end at 79 × 33. Nothing the page lets a person click may lie
 * in it (ui.css leaves it to the drag strip); the native acceptance reads the real buttons and checks they fit.
 */
export const TRAFFIC_LIGHT_ZONE = { width: 86, height: 40 } as const;
