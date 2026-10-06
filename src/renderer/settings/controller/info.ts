/** A row's explanation popover: open on hover or focus, pinned by a click, closed after the pointer leaves. */
import type { SettingsView } from "../../../shared/settings-panel";
import { draw, selectedTab } from "./core";

export let infoOpen: { id: string; pinned: boolean } | undefined;
let infoLeave: ReturnType<typeof setTimeout> | undefined;
export function showInfo(id: string, pinned: boolean): void {
  clearTimeout(infoLeave);
  infoOpen = {
    id,
    pinned: pinned || (infoOpen?.id === id && infoOpen.pinned) === true,
  };
  draw();
}
export function hideInfo(): boolean {
  clearTimeout(infoLeave);
  if (!infoOpen) return false;
  infoOpen = undefined;
  draw();
  return true;
}
export function leaveInfo(id: string): void {
  clearTimeout(infoLeave);
  infoLeave = setTimeout(() => {
    const trigger = document.getElementById(`setting-${id}-info-button`),
      popup = document.getElementById(`setting-${id}-info-popup`);
    if (
      infoOpen?.id === id &&
      !infoOpen.pinned &&
      document.activeElement !== trigger &&
      !trigger?.matches(":hover") &&
      !popup?.matches(":hover")
    )
      hideInfo();
  }, 120);
}
/** A popover whose row left the selected tab, or lost its explanation, closes without a draw of its own. */
export function forgetInfo(next: SettingsView): void {
  if (
    infoOpen &&
    !next.groups.some(
      (group) =>
        group.id === infoOpen?.id && group.info && group.tab === selectedTab,
    )
  )
    infoOpen = undefined;
}
export function disposeInfo(): void {
  clearTimeout(infoLeave);
}
