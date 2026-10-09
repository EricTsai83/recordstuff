/**
 * The Recordings tab: its layout, a card's menu, renaming, file actions and undoing a move to the Trash, and its
 * folders and search (plan 071): which folder is shown and what is searched live in the page only.
 */
import { translate } from "../../../shared/i18n";
import type { LibraryLayout } from "../../../shared/appearance";
import type { FolderChoice, LibraryItemView, LibraryView } from "../../../shared/settings-panel";
import { fileNameProblem, fileNameProblemText, folderNameProblem, folderProblemText } from "../../../shared/file-name";
import {
  announce,
  choose,
  draw,
  failure,
  focus,
  platform,
  render,
  selectedTab,
  text,
  view,
} from "./core";
import { playingItem } from "./player";
import { showToast, toastNode } from "./toast";

export let libraryError: string | undefined;
export let menuId: string | undefined;
export let menuKind: "dropdown" | "context" = "dropdown";
export let renaming:
  | {
      id: string;
      name: string;
      extension: string;
      error: string;
      pending: boolean;
    }
  | undefined;
export let optimisticLayout: LibraryLayout | undefined;
/**
 * The folder shown: every recording (undefined), those directly in the output folder (`{ folder: null }`, Unsorted) or
 * one subfolder's. Never saved: the tab opens on every recording.
 */
export let shownFolder: { folder: string | null } | undefined;
/** The search typed in the tab's head; it narrows the shown folder's recordings by name. */
export let query = "";
/** New folder or Rename folder…, while its dialog is open. */
export let folderDialog:
  | { folder?: string; name: string; error: string; pending: boolean }
  | undefined;
/** The card being dragged out of the page, which a folder in the bar takes when it is dropped there. */
export let dragging: string | undefined;
let folderPending = false;
/** Only the latest layout request's answer ends the optimistic layout: an earlier one would flash back its choice. */
let layoutRequest = 0;
let undoing = false;
const trashedCards: string[] = [];
const fileActionsPending = new Set<string>();
const movesPending = new Set<string>();
/** Another tab, or an explicit entry, closes a card's menu and its rename without a draw of their own. */
export function dismissLibraryOverlays(): void {
  menuId = undefined;
  renaming = undefined;
  folderDialog = undefined;
}
/** An entry bringing a recording into view: every folder and no search, so its card is there. */
export function showEveryRecording(): void {
  shownFolder = undefined;
  query = "";
}
/** Whether `item` is in the shown folder and matches the search, ignoring case. */
export function isShown(item: LibraryItemView): boolean {
  if (shownFolder && (item.folder ?? null) !== shownFolder.folder) return false;
  const words = query.trim().toLocaleLowerCase();
  return !words || item.title.toLocaleLowerCase().includes(words);
}
export function shownItems(library: LibraryView | undefined): LibraryItemView[] {
  return library?.items.filter(isShown) ?? [];
}
export function showFolder(folder: { folder: string | null } | undefined): void {
  shownFolder = folder;
  menuId = undefined;
  draw();
}
export function search(text: string): void {
  query = text;
  draw();
}
/**
 * A folder gone from the output folder, renamed or deleted elsewhere, is no longer shown: every recording is. So is
 * Unsorted once no folder is left, since the bar then offers no way back to every recording.
 */
export function forgetMissingFolder(library: LibraryView | undefined): void {
  const shown = shownFolder?.folder;
  if (shownFolder && !library?.folders?.length) shownFolder = undefined;
  else if (typeof shown === "string" && !library?.folders?.some((entry) => entry.name === shown))
    shownFolder = undefined;
}
export function startDragging(id: string): void {
  dragging = id;
}
export function stopDragging(): void {
  dragging = undefined;
}
/** The menu closes as the player opens over it. */
export function forgetMenu(): void {
  menuId = undefined;
}
/** A card that left the folder takes its menu and its rename with it, unless the rename is still being saved. */
export function forgetMissingItems(ids: Set<string>): void {
  if (menuId && !ids.has(menuId)) menuId = undefined;
  if (renaming && !renaming.pending && !ids.has(renaming.id))
    renaming = undefined;
}
export async function chooseLayout(layout: LibraryLayout): Promise<void> {
  const request = ++layoutRequest;
  optimisticLayout = layout;
  draw();
  try {
    const result = await window.settings.choose("library", layout);
    render(result.view);
    if (!result.applied)
      announce(
        result.failure ?? text("Could not complete this action. Try again."),
      );
  } catch {
    announce(text("Could not complete this action. Try again."));
  } finally {
    if (request === layoutRequest) {
      optimisticLayout = undefined;
      draw();
    }
  }
}
export async function revealFolder(): Promise<void> {
  await choose("outputFolder", "reveal", "library-reveal");
  if (failure?.group === "outputFolder") {
    libraryError = failure.text;
    draw();
  }
}
export function openMenu(id: string, kind: typeof menuKind = "dropdown"): void {
  if (!view?.library?.items.some((item) => item.id === id)) return;
  const card = document.getElementById(`clip-${id}`)?.getBoundingClientRect(),
    panel = document.getElementById("settings-panel")?.getBoundingClientRect();
  if (
    card &&
    panel &&
    panel.height &&
    (card.bottom <= panel.top || card.top >= panel.bottom)
  ) {
    menuId = undefined;
    draw();
    if (document.activeElement?.closest(".clip-menu")) focus(`clip-${id}-more`);
    return;
  }
  menuKind = kind;
  menuId = id;
  draw();
}
export function closeMenu(): void {
  const id = menuId;
  menuId = undefined;
  draw();
  if (id) focus(`clip-${id}-more`);
}
export function openRename(id: string): void {
  const item = view?.library?.items.find((item) => item.id === id);
  if (!item) return;
  menuId = undefined;
  const extension = /\.[^.]+$/.exec(item.name)?.[0] ?? "";
  renaming = {
    id,
    extension,
    name: item.name.slice(0, -extension.length || undefined),
    error: "",
    pending: false,
  };
  draw();
  const field = document.getElementById(
    "clip-rename-input",
  ) as HTMLInputElement | null;
  field?.focus();
  field?.select();
}
export function cancelRename(restore = true): void {
  const id = renaming?.id;
  renaming = undefined;
  draw();
  if (restore && id) focus(`clip-${id}-more`);
}
export function renameDraft(name: string): void {
  if (renaming) {
    renaming.name = name;
    renaming.error = "";
    draw();
  }
}
export async function submitRename(): Promise<void> {
  const current = renaming;
  if (!current || current.pending) return;
  const item = view?.library?.items.find((item) => item.id === current.id),
    name = current.name.trim();
  if (item && name + current.extension === item.name) {
    cancelRename();
    return;
  }
  const problem = fileNameProblem(name);
  const fail = (message: string): void => {
    if (renaming === current) {
      current.error = message;
      draw();
      focus("clip-rename-input");
    } else {
      libraryError = message;
      draw();
    }
    announce(message);
  };
  if (problem) {
    fail(fileNameProblemText(problem, view?.language ?? "en"));
    return;
  }
  current.pending = true;
  draw();
  try {
    const result = await window.settings.choose(`recordingFile:${current.id}`, {
      action: "rename",
      name,
    });
    const owned = renaming === current;
    render(result.view);
    if (result.applied) {
      if (owned) cancelRename(false);
      announce(
        translate("Renamed to {name}", view?.language, {
          name: name + current.extension,
        }),
      );
      if (owned && result.renamed && document.hasFocus())
        focus(`clip-${result.renamed}-open`);
    } else {
      if (owned && !view?.library?.items.some((item) => item.id === current.id))
        cancelRename(false);
      fail(
        result.failure ?? text("Could not rename the recording. Try again."),
      );
    }
  } catch {
    fail(text("Could not rename the recording. Try again."));
  } finally {
    current.pending = false;
    draw();
  }
}
export async function fileAction(
  id: string,
  action: "reveal" | "open" | "trash" | "drag",
): Promise<void> {
  menuId = undefined;
  draw();
  if (action !== "drag") {
    focus(`clip-${id}-more`);
    queueMicrotask(() => {
      if (
        !menuId &&
        !renaming &&
        !playingItem &&
        document.activeElement?.closest(".clip-menu")
      )
        focus(`clip-${id}-more`);
    });
  }
  if (fileActionsPending.has(id)) return;
  fileActionsPending.add(id);
  libraryError = undefined;
  draw();
  try {
    const result = await window.settings.choose(`recordingFile:${id}`, action);
    if (result.applied && action === "trash") trashedCards.push(id);
    render(result.view);
    if (!result.applied)
      libraryError = view?.library?.items.some((item) => item.id === id)
        ? (result.failure ?? text("Could not complete this action. Try again."))
        : text("This recording is no longer in the folder.");
    else if (action === "trash") {
      const title = text(
        platform() === "darwin"
          ? "Moved to the Trash"
          : "Moved to the Recycle Bin",
      );
      announce(view?.library?.trashed?.message ?? title);
      showToast("trashed", title, view?.library?.trashed?.name ?? "", 8000);
    }
  } catch {
    if (action !== "drag")
      libraryError = text("Could not complete this action. Try again.");
  } finally {
    fileActionsPending.delete(id);
    draw();
    if (libraryError) announce(libraryError);
  }
}
export async function undoTrash(): Promise<void> {
  const trashed = view?.library?.trashed;
  if (!trashed || undoing) return;
  undoing = true;
  draw();
  const fromToast = toastNode()?.contains(document.activeElement);
  try {
    const result = await window.settings.choose("library", "undoTrash");
    render(result.view);
    if (!result.applied) {
      announce(
        result.failure ?? text("Could not complete this action. Try again."),
      );
      return;
    }
    announce(
      translate("Restored {name}", view?.language, { name: trashed.name }),
    );
    const id = trashedCards.pop();
    showToast("restored", text("Restored"), trashed.name, 3000);
    if (
      document.hasFocus() &&
      (fromToast ||
        document.activeElement === document.body ||
        document.activeElement?.id === "tab-library")
    )
      focus(
        selectedTab === "library" && id
          ? `clip-${id}-open`
          : `tab-${selectedTab}`,
      );
  } catch {
    announce(text("Could not complete this action. Try again."));
  } finally {
    undoing = false;
    draw();
  }
}

/** Moves a recording into a folder, or with `null` into the output folder itself, and says where it went. */
export async function moveTo(id: string, folder: string | null): Promise<void> {
  menuId = undefined;
  dragging = undefined;
  const item = view?.library?.items.find((entry) => entry.id === id);
  // Its own set: the card's drag request can still be pending when the drop arrives, since the native drag may hold
  // that request until it ends, and must not refuse the move it carries.
  if (!item || (item.folder ?? null) === folder || movesPending.has(id)) {
    draw();
    return;
  }
  const focused = document.activeElement?.closest(".clip, .clip-menu") !== null;
  movesPending.add(id);
  libraryError = undefined;
  draw();
  try {
    const result = await window.settings.choose(`recordingFile:${id}`, { action: "move", folder });
    render(result.view);
    if (result.applied) {
      announce(translate("Moved {name} to {folder}", view?.language, { name: item.name, folder: folder ?? text("Unsorted") }));
      const moved = result.renamed && view?.library?.items.find((entry) => entry.id === result.renamed);
      if (focused && moved && isShown(moved) && document.hasFocus()) focus(`clip-${moved.id}-open`);
    } else libraryError = result.failure ?? text("Could not complete this action. Try again.");
  } catch {
    libraryError = text("Could not complete this action. Try again.");
  } finally {
    movesPending.delete(id);
    draw();
    if (libraryError) announce(libraryError);
  }
}
export function openFolderDialog(folder?: string): void {
  menuId = undefined;
  folderDialog = { ...(folder === undefined ? {} : { folder }), name: folder ?? "", error: "", pending: false };
  draw();
}
export function folderDraft(name: string): void {
  if (folderDialog) {
    folderDialog.name = name;
    folderDialog.error = "";
    draw();
  }
}
export function cancelFolderDialog(): void {
  const renamingFolder = folderDialog?.folder !== undefined;
  folderDialog = undefined;
  draw();
  focus(renamingFolder ? "library-folder-more" : "library-new-folder");
}
async function folderAction(choice: FolderChoice): Promise<{ applied: boolean; folder?: string; failure?: string }> {
  try {
    const result = await window.settings.choose("libraryFolder", choice);
    render(result.view);
    return result;
  } catch {
    return { applied: false };
  }
}
/** Makes the folder named in the dialog, or renames the one it was opened for, and shows that folder. */
export async function submitFolderDialog(): Promise<void> {
  const current = folderDialog;
  if (!current || current.pending) return;
  const name = current.name.trim(), language = view?.language ?? "en";
  if (current.folder !== undefined && name === current.folder) {
    cancelFolderDialog();
    return;
  }
  const fail = (message: string): void => {
    if (folderDialog === current) {
      current.error = message;
      draw();
      focus("library-folder-input");
    } else {
      libraryError = message;
      draw();
    }
    announce(message);
  };
  const problem = folderNameProblem(name);
  if (problem) {
    fail(folderProblemText(problem, language));
    return;
  }
  current.pending = true;
  draw();
  const result = await folderAction(current.folder === undefined
    ? { action: "createFolder", name }
    : { action: "renameFolder", folder: current.folder, name });
  current.pending = false;
  if (!result.applied) {
    fail(result.failure ?? text("Could not complete this action. Try again."));
    return;
  }
  // Only the dialog that asked, still open, takes the page to its folder and the focus with it: one cancelled meanwhile,
  // or a newer choice or entry, keeps what the user went to since (review pass 2, F3).
  const owned = folderDialog === current;
  if (owned) {
    folderDialog = undefined;
    if (result.folder !== undefined) shownFolder = { folder: result.folder };
  }
  draw();
  announce(translate(current.folder === undefined ? "Created {folder}" : "Renamed folder to {folder}", view?.language, { folder: result.folder ?? name }));
  if (owned) focus(result.folder !== undefined ? "library-folder-more" : "library-new-folder");
}
/** Moves an empty folder to the Trash and shows every recording. */
export async function removeFolder(folder: string): Promise<void> {
  menuId = undefined;
  if (folderPending) return;
  folderPending = true;
  libraryError = undefined;
  draw();
  try {
    const result = await folderAction({ action: "removeFolder", folder });
    if (result.applied) {
      if (shownFolder?.folder === folder) shownFolder = undefined;
      announce(translate(platform() === "darwin" ? "Moved {name} to the Trash." : "Moved {name} to the Recycle Bin.", view?.language, { name: folder }));
      focus("library-folder-all");
    } else {
      libraryError = result.failure ?? text("Could not complete this action. Try again.");
      announce(libraryError);
    }
  } finally {
    folderPending = false;
    draw();
  }
}
