/**
 * Reading Node errors in one place: the `code` an errno error carries and the
 * message of any thrown value, shared by the main-process modules.
 */

/** The errno code (`ENOENT`, `EEXIST`, …) of a thrown value, when it carries one. */
export function errnoCode(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null && "code" in cause && (cause as { code: unknown }).code !== undefined
    ? String((cause as { code: unknown }).code)
    : undefined;
}

/** An error's message, or the value itself as text. */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** For unexpected faults, where the log needs to say where it came from: the stack when there is one. */
export function stackOf(cause: unknown): string {
  return cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
}
