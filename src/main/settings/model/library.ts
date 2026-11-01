/**
 * The Recordings tab's view: the listed recordings, their categories and the tab's own choices.
 */
import { translate as t, type PlainMessageKey } from "../../../shared/i18n";
import { formatBytes } from "../../../shared/quality";
import { formatDuration } from "../../../shared/video-player";
import type { LibraryItemView, LibraryView } from "../../../shared/settings-panel";
import type { VideoState } from "../../sharing/sharing";
import { MORE_VERSIONS, offeredVersions, recordingTitle, versionName, type VersionKind, type VersionSubject } from "../../../shared/versions";
import type { ShareView } from "../../../shared/settings-panel";
import { MEDIA_SCHEME } from "../../library/recordings-library";
import { abbreviateHome, type AppContext } from "../../app/ui-model";
import { type DateFormats, dayHeading, shortTime } from "./history";

/**
 * A card's Video while it is prepared or failed (plan 100): a thin bar along its picture's foot, and these words read by
 * assistive technology (2026-11-01: a scrim with words over the picture, before); a refused drag says the rest in a toast.
 */
function videoStateView(state: VideoState | undefined, language: AppContext["language"]): Pick<LibraryItemView, "preparing"> {
  if (!state) return {};
  if (state.state === "failed") return { preparing: { state: "failed", label: t("Video not prepared", language) } };
  const percent = Math.floor(state.progress * 100);
  return { preparing: { state: "preparing", progress: state.progress,
    label: percent > 0 ? t("Preparing video… {percent}%", language, { percent }) : t("Preparing video…", language) } };
}

const VERSION_LABELS: Record<VersionKind, PlainMessageKey> = {
  video: "Video file", sound: "Sound only", original: "Original", screenOnly: "No camera", sources: "Sources",
};
/** What each version is and what it is for, said in the bar when it is picked (2026-11-01, in place of a few words under each file). */
const VERSION_NOTES: Record<Exclude<VersionKind, "original">, PlainMessageKey> = {
  video: "The finished video, as it plays here. Use this one to send or upload.",
  sound: "Just the sound, every sound mixed into one track.",
  screenOnly: "The finished video without the camera.",
  sources: "The screen, the camera and each sound as files of their own, for editing in another app.",
};

/**
 * Share… for a recording (plan 100 step 3): the versions it offers, in order, each with the name it leaves as and what
 * it is; the Original says what it holds; the Video is the default; the Video's state is the card's.
 */
function shareView(subject: VersionSubject, title: string, states: Partial<Record<VersionKind, VideoState>>, language: AppContext["language"]): ShareView {
  return {
    heading: t("Share “{title}”", language, { title }),
    versions: offeredVersions(subject).map(kind => {
      const note = kind === "original"
        ? t(subject.editable ? "Unedited, with the camera and each sound apart. RecordStuff on another Mac can still edit it."
          : "The whole recording as made, before your edits, with the removed parts still in it.", language)
        : t(VERSION_NOTES[kind], language);
      const state = states[kind];
      return {
        kind, label: t(VERSION_LABELS[kind], language), note, fileName: versionName(kind, subject, language),
        ...(MORE_VERSIONS.includes(kind) ? { more: true as const } : {}),
        ...(kind === "video" ? { recommended: true as const } : {}),
        state: state?.state ?? "ready",
        ...(state?.state === "preparing" ? { progress: state.progress, ...(state.since === undefined ? {} : { since: state.since }) } : {}),
      };
    }),
    labels: {
      share: t("Share", language), copy: t("Copy", language), saveTo: t("Save to…", language),
      more: t("More", language), moreCount: t("{count} items", language, { count: "{count}" }), close: t("Close", language),
      drag: t("You can also drag a file into another app.", language),
      preparingNote: t("Being prepared. Copy and Save to… wait until it is ready.", language),
      failedNote: t("This file could not be made. Pick it again to retry.", language),
      selected: t("{count} files selected", language, { count: "{count}" }),
      copied: t("Copied", language), saved: t("Saved", language),
      preparing: t("Preparing…", language), failed: t("Could not be made", language),
    },
  };
}

/** Each version's state for Share…: as sharing reports them, the Video's as the card shows it. */
function shareStatesOf(ctx: AppContext, source: string): Partial<Record<VersionKind, VideoState>> {
  const states: Partial<Record<VersionKind, VideoState>> = { ...ctx.shareStates?.get(source) };
  const video = ctx.preparingVideos?.get(source);
  if (video) states.video = video;
  return states;
}

/**
 * The Recordings tab (2026-10-04): the output folder's videos, newest first, grouped by day like the
 * failures, each with the URLs the page may load it by. Totals count every listed file.
 */
export function libraryView(ctx: AppContext, now: Date, format: DateFormats): LibraryView | undefined {
  const library = ctx.library;
  if (!library) return undefined;
  const language = ctx.language;
  const folder = abbreviateHome(library.dir, ctx.homeDir);
  const mac = ctx.platform === "darwin";
  // What a Move to Trash left to say, whatever the listing shows meanwhile.
  const extras = {
    layout: ctx.libraryLayout ?? "grid",
    previewSound: ctx.libraryPreviewSound ?? false,
    ...(library.trashed ? { trashed: {
      name: library.trashed.name,
      message: t(mac ? "Moved {name} to the Trash." : "Moved {name} to the Recycle Bin.", language, { name: library.trashed.name }),
      undo: t("Undo", language),
    } } : {}),
    ...(library.trashFailed ? { notice: t(mac ? "Could not move {name} to the Trash. It is back in the folder." : "Could not move {name} to the Recycle Bin. It is back in the folder.", language, { name: library.trashFailed }) } : {}),
  };
  if (library.failed) return { folder, ...extras, status: t("Could not read the output folder. Check the folder and its drive, or choose another folder.", language), items: [] };
  if (library.loading) return { folder, ...extras, status: t("Loading recordings…", language), items: [] };
  const listed = new Set(library.folders?.map(folder => folder.name));
  const total = library.files.reduce((sum, file) => sum + file.size, 0);
  const count = library.files.length;
  return {
    folder,
    ...extras,
    ...(count ? { summary: t(count === 1 ? "1 recording · {size}" : "{count} recordings · {size}", language, { count, size: formatBytes(total) }) } : {}),
    items: library.files.map(file => {
      // Known by its name, whatever named it (2026-10-06, formerly the time for the app's own names); when it was
      // recorded comes beside it.
      const at = new Date(file.recordedAt);
      return {
        id: file.id, name: file.name, day: dayHeading(at, now, language, format),
        // An editable recording's marker is left out (plan 100, D3): its Editable mark says it.
        title: recordingTitle(file.name), time: shortTime(at, language, format),
        ...(file.duration === undefined ? {} : { duration: formatDuration(file.duration) }),
        size: formatBytes(file.size),
        thumbnail: `${MEDIA_SCHEME}://thumb/${file.id}?v=${file.version}`,
        video: `${MEDIA_SCHEME}://video/${file.id}?v=${file.version}`,
        ...(file.folder === undefined ? {} : { folder: file.folder }),
        ...(file.editable ? { editable: t("Editable", language),
          editableHint: t("Keeps the camera and each sound apart, so you can still change them here or in RecordStuff on another Mac. Drag the card or use Share… to send it.", language) } : {}),
        ...videoStateView(ctx.preparingVideos?.get(file.path), language),
        share: shareView({ fileName: file.name, edited: ctx.editedRecordings?.get(file.path) === file.size,
          // Without a camera, no Video without one; its description not read yet, the camera is taken to be there.
          ...(file.editable ? { editable: { camera: file.editableCamera ?? true, sounds: ["system", "microphone"], mix: true as const } } : {}) },
        recordingTitle(file.name), shareStatesOf(ctx, file.path), language),
        // Holds an edit made for the file as it is (2026-10-26, the maintainer's request).
        ...(ctx.editedRecordings?.get(file.path) === file.size ? { edited: t("Edited", language) } : {}),
        ...(file.copies?.length ? { copies: file.copies.map(copy => {
          const saved = new Date(copy.saved);
          const time = `${dayHeading(saved, now, language, format)} ${shortTime(saved, language, format)}`;
          return { label: t("{form}, saved {time}", language, { form: t(VERSION_LABELS[copy.form], language), time }), name: copy.name };
        }) } : {}),
      };
    }),
    ...(library.folders?.length ? { folders: library.folders.map(({ name, empty }) => ({ name, empty })) } : {}),
    // Only categories listed now: one renamed or deleted in Finder is not offered, and the tab shows every recording.
    ...((): Pick<LibraryView, "favorites"> => {
      const favorites = (ctx.libraryFavorites ?? []).filter(name => listed.has(name));
      return favorites.length ? { favorites } : {};
    })(),
    ...(ctx.libraryShown === null || (typeof ctx.libraryShown === "string" && listed.has(ctx.libraryShown))
      ? { shown: { folder: ctx.libraryShown } } : {}),
  };
}
