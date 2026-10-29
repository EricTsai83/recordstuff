/**
 * The Recordings tab's view: the listed recordings, their categories and the tab's own choices.
 */
import { translate as t } from "../../../shared/i18n";
import { formatBytes } from "../../../shared/quality";
import { formatDuration } from "../../../shared/video-player";
import type { LibraryItemView, LibraryView } from "../../../shared/settings-panel";
import type { VideoState } from "../../sharing/sharing";
import { recordingTitle } from "../../../shared/versions";
import { MEDIA_SCHEME } from "../../library/recordings-library";
import { abbreviateHome, type AppContext } from "../../app/ui-model";
import { type DateFormats, dayHeading, shortTime } from "./history";

/** A card's Video while it is prepared or failed (plan 100), in the card's words. */
function videoStateView(state: VideoState | undefined, language: AppContext["language"], mac: boolean): Pick<LibraryItemView, "preparing"> {
  if (!state) return {};
  const hint = t(mac ? "Option-drag gives the original." : "Alt-drag gives the original.", language);
  if (state.state === "failed") return { preparing: { state: "failed", label: t("Video not prepared", language), hint } };
  const percent = Math.floor(state.progress * 100);
  return { preparing: { state: "preparing", progress: state.progress, hint,
    label: percent > 0 ? t("Preparing video… {percent}%", language, { percent }) : t("Preparing video…", language) } };
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
          editableHint: t("Keeps the picture, camera and sounds apart so you can change them later. To send it, drag it: you give the video as it plays here.", language) } : {}),
        ...videoStateView(ctx.preparingVideos?.get(file.path), language, mac),
        // Holds an edit made for the file as it is (2026-10-26, the maintainer's request).
        ...(ctx.editedRecordings?.get(file.path) === file.size ? { edited: t("Edited", language) } : {}),
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
