/** Persisted appearance choice; system follows the OS live. */
export type Appearance = "system" | "light" | "dark";
export function isAppearance(value: unknown): value is Appearance {
  return value === "system" || value === "light" || value === "dark";
}
