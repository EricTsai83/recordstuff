/**
 * Where a saved copy came from (plan 100, D4): written by Save a copy… into the copy's own `moov/udta`, as an `rsed`
 * box describes an editable recording, so the Recordings tab can say "Saved from Meeting" on it and list it under its
 * recording even after either is renamed in Finder. No link is kept outside the file, so there is nothing to keep in
 * step: a copy moved out of the folder or deleted is simply not listed.
 *
 * The recording is known by the same identity its edit is (edit-store.ts): its size and the hash of its first and last
 * mebibyte, never its name. The name is kept only to say it when the recording itself is no longer listed.
 */

/** The `udta` child that holds a saved copy's provenance: RecordStuff's own four-character code, beside `rsed`. */
export const PROVENANCE_BOX = "rsfm";
/** The most a provenance may take, as written and as read. */
export const PROVENANCE_LIMIT = 4096;

/** The forms Save a copy… offers: the Video, the Video without the camera (an editable recording's), its sound alone. */
export type CopyForm = "video" | "screenOnly" | "sound";
export const COPY_FORMS: readonly CopyForm[] = ["video", "screenOnly", "sound"];

export function isCopyForm(value: unknown): value is CopyForm {
  return (COPY_FORMS as readonly unknown[]).includes(value);
}

export interface Provenance {
  version: 1;
  /** The recording's file name when the copy was saved. */
  from: string;
  /** The recording's identity: its size and the SHA-256 of its first and last mebibyte, hex (edit-store.ts). */
  size: number;
  hash: string;
  /** The edit's revision the copy was made from. */
  revision: number;
  form: CopyForm;
  /** When it was saved, in milliseconds since the epoch. */
  saved: number;
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The provenance in a copy's box, or undefined for anything else: never trusted for its shape. */
export function parseProvenance(text: string | undefined): Provenance | undefined {
  if (!text || text.length > PROVENANCE_LIMIT) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { from, size, hash, revision, form, saved } = record;
  if (record["version"] !== 1 || typeof from !== "string" || !from || from.length > 1024 || !isCount(size) || typeof hash !== "string"
    || !/^[0-9a-f]{64}$/.test(hash) || !isCount(revision) || !isCopyForm(form) || !isCount(saved)
    // A time a date can hold: one past it would make the tab's date formatting throw (Codex F3).
    || !Number.isFinite(new Date(saved).getTime())) return undefined;
  return { version: 1, from, size, hash, revision, form, saved };
}

export function provenanceText(provenance: Provenance): string {
  const { version, from, size, hash, revision, form, saved } = provenance;
  return JSON.stringify({ version, from, size, hash, revision, form, saved });
}
