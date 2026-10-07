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
  const expected = ["wide-100", "wide-150"].flatMap(profile => ["top-left", "top-middle", "top-right", "sidebar-blank", "brand",
    "tab-no-drag", "tab-click", "menu-button-no-drag", "menu-click", "menu-overlay-no-drag"].map(name => `${profile}-${name}`));
  expected.push("narrow-100-top-left", "narrow-100-top-middle", "narrow-100-top-right", "console");
  return exit !== 0 || Boolean(stopped) || !results?.complete || Boolean(results.error)
    || results.cases.length !== expected.length || expected.some(name => !results.cases.some(test => test.name === name));
}
