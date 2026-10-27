export interface WindowDragResults {
  cases: Array<{ name: string; ok: boolean; detail: unknown }>;
  complete: boolean; blocked: boolean; error?: string; cleanupError?: string;
}
export function parseWindowDragResults(text: string): WindowDragResults {
  const value = JSON.parse(text) as WindowDragResults;
  if (!value || !Array.isArray(value.cases) || typeof value.complete !== "boolean" || typeof value.blocked !== "boolean"
    || value.cases.some(test => !test || typeof test.name !== "string" || typeof test.ok !== "boolean"))
    throw new Error("Malformed window drag results");
  return value;
}
/** An incomplete/empty run cannot pass, even when the fixture exited zero. Earlier failures outrank a later blocker. */
export function windowDragFailed(results: WindowDragResults | undefined, exit: number | null, stopped?: string): boolean {
  if (results?.cases.some(test => !test.ok)) return true;
  if (results?.blocked) return false;
  // Each wide profile's top strip, its full sidebar and, by the toggle, its collapsed one; the narrow profile's top strip
  // and the collapsed sidebar it always shows (2026-10-21).
  const top = ["top-left", "top-middle", "top-right"], sidebar = ["sidebar-blank", "tab-no-drag", "tab-click", "menu-button-no-drag", "menu-click", "menu-overlay-no-drag"];
  const expected = ["wide-100", "wide-150"].flatMap(profile => [...top.map(name => `${profile}-${name}`),
    ...[...sidebar, "brand", "toggle-no-drag"].map(name => `${profile}-full-${name}`), ...[...sidebar, "toggle-no-drag"].map(name => `${profile}-collapsed-${name}`)]);
  expected.push(...[...top, ...sidebar].map(name => `narrow-100-${name}`));
  // The window's drag handle while a modal is open (2026-10-27).
  expected.push("modal-handle-hidden-away-from-top", "modal-handle-shown-near-top", "modal-handle-drag", "modal-handle-closes-nothing",
    "modal-backdrop-still-dismisses", "console");
  return exit !== 0 || Boolean(stopped) || !results?.complete || Boolean(results.error)
    || results.cases.length !== expected.length || expected.some(name => !results.cases.some(test => test.name === name));
}
