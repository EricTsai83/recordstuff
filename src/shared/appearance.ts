/**
 * What a left click on the menu bar (system tray) icon does (2026-10-04): open the menu, as menu bar
 * icons usually do, or start and stop recording. A right click always opens the menu.
 */
export type TrayClick = "menu" | "record";
export function isTrayClick(value: unknown): value is TrayClick {
  return value === "menu" || value === "record";
}
/** How the Recordings tab lays out its videos (2026-10-05): large thumbnails in a grid, or one row each. */
export type LibraryLayout = "grid" | "list";
export function isLibraryLayout(value: unknown): value is LibraryLayout {
  return value === "grid" || value === "list";
}
/** Persisted appearance choice; system follows the OS live. */
export type Appearance = "system" | "light" | "dark";
export function isAppearance(value: unknown): value is Appearance {
  return value === "system" || value === "light" || value === "dark";
}
