/**
 * What leaves RecordStuff when a recording is shared (plan 100): a **version**, made from the recording and its edit at
 * that moment, never a file the person manages. This module says which versions a recording offers and what each is
 * named when it leaves; main makes them (main/sharing) and the Recordings tab offers them.
 *
 * The naming rule (D3, D8, D9): only the original is marked; everything else is named as a finished file, after the
 * recording, with a content tag only where it differs from the default form. An editable original is
 * `<name>.recordstuff.mp4` on disk; a plain recording's original leaves as `<name> (original).mp4`. A version that would
 * take its source's own name, as the Video of an edited plain recording would, is `<name> (edited).mp4`, so a drop
 * beside the original never asks to replace it.
 */
import { translate, type Language } from "./i18n";
import type { CopyTrack } from "./editing";
import type { EditableSound } from "./editable";

/**
 * The versions, by purpose: what the app shows (`video`), its sound alone, the file as made, the Video without the
 * camera, and each track as a file of its own (`sources`).
 */
export type VersionKind = "video" | "sound" | "original" | "screenOnly" | "sources";
export const VERSION_KINDS: readonly VersionKind[] = ["video", "sound", "original", "screenOnly", "sources"];

/** The versions Share… keeps under More (plan 100): for people who know they want them. */
export const MORE_VERSIONS: readonly VersionKind[] = ["screenOnly", "sources"];

export function isVersionKind(value: unknown): value is VersionKind {
  return (VERSION_KINDS as readonly unknown[]).includes(value);
}

/** What a recording is, as far as its versions go. */
export interface VersionSubject {
  /** The recording's file name, with its extension: `Meeting.mp4`, `Meeting.recordstuff.mp4`. */
  fileName: string;
  /** It holds an edit made for the file as it is. */
  edited: boolean;
  /** An editable recording (plan 087): whether it holds a camera, and its inputs' own sounds as its description says. */
  editable?: { camera: boolean; sounds: readonly EditableSound[]; mix?: true };
}

/** The marker before an editable original's extension (D3): `Meeting.recordstuff.mp4`. Only for people; never read. */
export const EDITABLE_MARKER = ".recordstuff";

/** The recording's name without its extension or the editable marker: what its card and every version are named by. */
export function recordingTitle(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "");
  return stem.toLowerCase().endsWith(EDITABLE_MARKER) && stem.length > EDITABLE_MARKER.length ? stem.slice(0, -EDITABLE_MARKER.length) : stem;
}

/** Whether a file name carries the editable marker (D3). */
export function hasEditableMarker(fileName: string): boolean {
  return recordingTitle(fileName) !== fileName.replace(/\.[^.]+$/, "");
}

/**
 * The versions `subject` offers, in the order they are shown: an unedited plain recording only its Video (the file
 * itself) and Sound only; an edited one its Original too; an editable recording every one, Video without the camera only
 * when it holds a camera.
 */
export function offeredVersions(subject: VersionSubject): VersionKind[] {
  if (subject.editable) return ["video", "sound", "original", ...(subject.editable.camera ? ["screenOnly" as const] : []), "sources"];
  return subject.edited ? ["video", "sound", "original"] : ["video", "sound"];
}

/** Whether `subject`'s Video is the recording's own file, given as it is: a plain recording never edited. */
export function videoIsOriginal(subject: VersionSubject): boolean {
  return !subject.editable && !subject.edited;
}

/** Two names the file system takes for the same: macOS's volumes ignore case and compose accents alike. */
function sameName(a: string, b: string): boolean {
  return a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();
}

function extensionOf(fileName: string): string {
  return /\.[^.]+$/.exec(fileName)?.[0] ?? ".mp4";
}

/**
 * The name `kind` of `subject` leaves with, in `language`: a file's name, or for `sources` its folder's. Not checked
 * against what the place it lands in holds: a name taken there is the receiving app's to number.
 */
export function versionName(kind: VersionKind, subject: VersionSubject, language?: Language): string {
  const title = recordingTitle(subject.fileName);
  switch (kind) {
    case "video": {
      if (videoIsOriginal(subject)) return subject.fileName;
      const name = `${title}.mp4`;
      // D9: never its source's own name, so it cannot replace the original where both meet.
      return sameName(name, subject.fileName) ? `${translate("{title} (edited)", language, { title })}.mp4` : name;
    }
    case "sound": return `${translate("{title} (sound)", language, { title })}.m4a`;
    case "original": return subject.editable ? subject.fileName : `${translate("{title} (original)", language, { title })}${extensionOf(subject.fileName)}`;
    case "screenOnly": return `${translate("{title} (screen only)", language, { title })}.mp4`;
    case "sources": return translate("{title} sources", language, { title });
  }
}

/** What one of a recording's sources holds. */
export type SourceRole = "screen" | "camera" | "system" | "microphone";

/** One of a recording's sources: the track copied, what it holds, and the file it is copied into. */
export interface SourceFile {
  track: CopyTrack;
  role: SourceRole;
  name: string;
}

/** The file name of `role` among the sources of a recording titled `title`. */
export function sourceFileName(role: SourceRole, title: string, language?: Language): string {
  switch (role) {
    case "screen": return `${translate("{title} - Screen", language, { title })}.mp4`;
    case "camera": return `${translate("{title} - Camera", language, { title })}.mp4`;
    case "system": return `${translate("{title} - System sound", language, { title })}.m4a`;
    case "microphone": return `${translate("{title} - Microphone", language, { title })}.m4a`;
  }
}

/**
 * An editable recording's sources (D7): the screen, the camera when it holds one, and each input's own sound, named
 * alike so they sort together: `Meeting - Screen.mp4`, `Meeting - Camera.mp4`, `Meeting - System sound.m4a`,
 * `Meeting - Microphone.m4a`. Without a mix (plan 087's version 1) the first input is the track players play; with
 * one (plan 098) the inputs' own tracks follow the mix. A silent input has no file. None for a plain recording.
 */
export function sourceFiles(subject: VersionSubject, language?: Language): SourceFile[] {
  const editable = subject.editable;
  if (!editable) return [];
  const title = recordingTitle(subject.fileName);
  const file = (track: CopyTrack, role: SourceRole): SourceFile => ({ track, role, name: sourceFileName(role, title, language) });
  const files: SourceFile[] = [file("screen", "screen")];
  if (editable.camera) files.push(file("camera", "camera"));
  const places: readonly CopyTrack[] = editable.mix ? ["sound1", "sound2"] : ["sound0", "sound1"];
  editable.sounds.forEach((sound, index) => {
    const track = places[index];
    if (track && sound !== "silent") files.push(file(track, sound));
  });
  return files;
}
