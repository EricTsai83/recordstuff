import { translate as t, type Language } from "./i18n";

export type DisplayPreference = { kind: "primary" } | { kind: "display"; id: string; label: string };
export const DEFAULT_DISPLAY_PREFERENCE: DisplayPreference = { kind: "primary" };
export interface DisplayInfo {
  id: string;
  label: string;
  logicalWidth: number;
  logicalHeight: number;
  scaleFactor: number;
  internal: boolean;
  primary: boolean;
}
export type DisplayFailure = "target_missing" | "source_missing" | "topology_changed" | "target_removed" | "track_ended";
export function isDisplayId(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value));
}
export function isDisplayPreference(value: unknown): value is DisplayPreference {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v["kind"] === "primary" || (v["kind"] === "display" && isDisplayId(v["id"]) && typeof v["label"] === "string");
}
export function isDisplayInfo(value: unknown): value is DisplayInfo {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return isDisplayId(v["id"]) && typeof v["label"] === "string" && typeof v["internal"] === "boolean" && typeof v["primary"] === "boolean"
    && [v["logicalWidth"], v["logicalHeight"], v["scaleFactor"]].every((n) => typeof n === "number" && Number.isFinite(n) && n > 0);
}
export function displayLabel(display: { id: string; label: string; primary?: boolean }, language: Language): string {
  const label = display.label.trim() || t("Display {id}", language, { id: display.id });
  return display.primary ? t("{label} (Primary)", language, { label }) : label;
}
export function displayFailureText(detail: DisplayFailure, language: Language): string {
  const keys = {
    target_missing: "Selected display is unavailable. Choose another screen.",
    source_missing: "Display is connected but its capture source is unavailable. Retry or choose another screen.",
    topology_changed: "Display configuration changed. Retry.",
    track_ended: "The display capture ended unexpectedly. Retry or choose another screen.",
    target_removed: "The recording display was removed. Choose another screen.",
  } as const;
  return t(keys[detail], language);
}
