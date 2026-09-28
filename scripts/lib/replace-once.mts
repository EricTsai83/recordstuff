/**
 * Replaces exactly one occurrence of `from` in an instrumented source, or
 * throws when the anchor is missing or ambiguous. The replacement is passed as
 * a callback so `$&`, `$'` and `$1` in `to` stay literal: a run directory or a
 * JSON string with a dollar sign must not corrupt the instrumented file.
 */
export function replaceOnce(source: string, from: string, to: string, what = "Acceptance"): string {
  if (source.split(from).length !== 2) throw new Error(`${what} source anchor changed: ${from}`);
  return source.replace(from, () => to);
}
