/**
 * Structural sharing for the views main pushes (2026-11-01). Every push arrives as new objects, so a memoized row
 * compared by reference drew again on every push: with 212 recordings, a Video's progress redrew every card, some
 * 45 ms a push. Rows whose content is unchanged keep the previous push's object, and their memo holds.
 */

/** Whether `a` and `b`, plain data as IPC delivers it, are equal throughout. */
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) if (!sameData(a[index], b[index])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const aKeys = Object.keys(a), bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key) || !sameData((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/** `next`, with each row equal to the previous row of its id replaced by that previous row. */
export function keepUnchanged<T extends { id: string }>(previous: readonly T[] | undefined, next: T[]): T[] {
  if (!previous?.length) return next;
  const before = new Map(previous.map((row) => [row.id, row]));
  return next.map((row) => {
    const old = before.get(row.id);
    return old && sameData(old, row) ? old : row;
  });
}
