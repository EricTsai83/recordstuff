/**
 * The Recordings tab: its layout, a card's menu, renaming, file actions and undoing a move to the Trash, and its
 * folders and search (plan 071): which folder is shown and what is searched live in the page only.
 */
import { sentences, translate } from "../../../shared/i18n";
import type { LibraryLayout } from "../../../shared/appearance";
import type { FailureHelp, FolderChoice, LibraryItemView, LibraryView, ShareChoice } from "../../../shared/settings-panel";
import { fileNameProblem, fileNameProblemText, folderNameProblem, folderProblemText } from "../../../shared/file-name";
import {
  announce,
  choose,
  draw,
  failureOf,
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
/** A way out beside `libraryError` (plan 100), only while that error is the one it came with. */
export let libraryHelp: (FailureHelp & { for: string }) | undefined;
/** Opens a failure's way out (System Settings' Storage, RecordStuff's data folder, the log) and says if it could not. */
export async function runFailureHelp(help: FailureHelp): Promise<void> {
  try {
    const result = await window.settings.choose("failureHelp", help.action);
    render(result.view);
    if (!result.applied) announce(failedText(result.failure));
  } catch {
    announce(failedText());
  }
}
export let menuId: string | undefined;
export let menuKind: "dropdown" | "context" = "dropdown";
export let renaming:
  | {
      id: string;
      name: string;
      extension: string;
      error: string;
      /** A way out beside `error` (plan 100). */
      help?: FailureHelp | undefined;
      pending: boolean;
    }
  | undefined;
/**
 * One of the tab's own choices, shown at once while main saves it: only the latest request's answer ends it, since an
 * earlier one would flash its choice back. A failure is said; the view then shows main's value.
 */
class OptimisticChoice<T> {
  value: T | undefined;
  private request = 0;

  async choose(value: T, choice: string): Promise<void> {
    const request = ++this.request;
    this.value = value;
    draw();
    try {
      const result = await window.settings.choose("library", choice);
      render(result.view);
      if (!result.applied) announce(failedText(result.failure));
    } catch {
      announce(failedText());
    } finally {
      if (request === this.request) {
        this.value = undefined;
        draw();
      }
    }
  }
}
/** The grid or list layout just chosen (settings `libraryLayout`). */
const layoutChoice = new OptimisticChoice<LibraryLayout>();
/** The preview sound just chosen (settings `libraryPreviewSound`). */
const previewSoundChoice = new OptimisticChoice<boolean>();
/** What a library action that failed says when main gave no reason of its own. */
function failedText(failure?: string): string {
  return failure ?? text("Could not complete this action. Try again.");
}
/**
 * The category shown: every recording (undefined), those directly in the output folder (`{ folder: null }`, Uncategorized)
 * or one subfolder's. Main remembers it (settings `libraryShown`), so the tab opens on it again in a new window or launch.
 */
export let shownFolder: { folder: string | null } | undefined;
/** The remembered category is taken once, from the first listing: later views must not undo a choice made since. */
let shownTaken = false;
/** The search typed in the tab's head; it narrows the shown folder's recordings by name. */
export let query = "";
/**
 * The list follows `query` at once rather than a deferred copy: an entry cleared the search to bring a recording into view,
 * and its card must be there when the entry focuses and scrolls to it (review 2026-10-09). Typing defers it again.
 */
export let queryNow = false;
/** New folder or Rename folder…, while its dialog is open. */
export let folderDialog:
  | { folder?: string; name: string; error: string; help?: FailureHelp | undefined; pending: boolean }
  | undefined;
let folderPending = false;
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
/** An entry bringing a recording into view: every category and no search, so its card is there. */
export function showEveryRecording(): void {
  query = "";
  queryNow = true;
  // Before the first listing too, so the remembered category is never applied over the recording asked for (review F1);
  // main hears of it only when something other than every recording was shown or remembered.
  shownTaken = true;
  if (shownFolder || view?.library?.shown) showFolder(undefined, false);
}
/** The first listing opens the tab on the category it showed last, as main remembers it, when it is still there. */
export function takeShown(library: LibraryView | undefined): void {
  if (shownTaken || !library || library.status) return;
  shownTaken = true;
  shownFolder = library.shown;
}
/** Whether `item`'s name holds the search `text`, ignoring case and whatever category it is in. */
export function matchesSearch(item: LibraryItemView, text = query): boolean {
  const words = text.trim().toLocaleLowerCase();
  return !words || item.title.toLocaleLowerCase().includes(words);
}
/** Whether `item` is in the shown folder and matches the search, ignoring case. */
export function isShown(item: LibraryItemView, text = query): boolean {
  if (shownFolder && (item.folder ?? null) !== shownFolder.folder) return false;
  return matchesSearch(item, text);
}
/** The cards for the search `text`: the tab passes a deferred copy of `query`, so typing never waits for the list. */
export function shownItems(library: LibraryView | undefined, text = query): LibraryItemView[] {
  return library?.items.filter((item) => isShown(item, text)) ?? [];
}
/** Shows a category at once and has main remember it; a failed save leaves it shown, and says nothing. */
export function showFolder(folder: { folder: string | null } | undefined, redraw = true): void {
  shownFolder = folder;
  shownTaken = true;
  menuId = undefined;
  // A failure said about the category left behind belongs to it, not to the one shown now.
  libraryError = undefined;
  if (redraw) draw();
  void window.settings
    .choose("libraryFolder", folder ? { action: "showFolder", folder: folder.folder } : { action: "showAll" })
    .catch(() => undefined);
}
export function search(text: string): void {
  query = text;
  queryNow = false;
  draw();
}
/**
 * A category gone from the output folder, renamed or deleted elsewhere, is no longer shown: every recording is.
 * Uncategorized always stays, as the selector always offers it (review F2).
 */
export function forgetMissingFolder(library: LibraryView | undefined): void {
  const shown = shownFolder?.folder;
  if (typeof shown === "string" && !library?.status && !library?.folders?.some((entry) => entry.name === shown))
    shownFolder = undefined;
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
export function chooseLayout(layout: LibraryLayout): Promise<void> {
  return layoutChoice.choose(layout, layout);
}
/** The layout the tab shows: the choice being saved, else the saved one (a grid by default). */
export function shownLayout(): LibraryLayout {
  return layoutChoice.value ?? view?.library?.layout ?? "grid";
}
/** Whether a grid card's hover preview plays its sound: the choice being saved, else the saved one (muted by default). */
export function previewSound(): boolean {
  return previewSoundChoice.value ?? view?.library?.previewSound ?? false;
}
export function choosePreviewSound(on: boolean): Promise<void> {
  return previewSoundChoice.choose(on, on ? "previewSound:on" : "previewSound:off");
}
export async function revealFolder(): Promise<void> {
  await choose("outputFolder", "reveal", "library-reveal");
  const failure = failureOf("outputFolder");
  if (failure) {
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
/**
 * Share… (plan 100 step 3): the recording whose versions are shown, whether More is open, the versions selected (the
 * recommended one as it opens; ⌘-click adds or takes one away), and what the last action said.
 */
export let sharing: { id: string; more: boolean; selected: string[]; status?: string | undefined; busy?: boolean } | undefined;
const versionsOf = (id: string) => view?.library?.items.find((entry) => entry.id === id)?.share?.versions ?? [];
export function openShare(id: string): void {
  if (!view?.library?.items.some((entry) => entry.id === id)) return;
  menuId = undefined;
  const recommended = versionsOf(id).find((version) => version.recommended)?.kind;
  sharing = { id, more: false, selected: recommended ? [recommended] : [] };
  draw();
  focus(recommended ? `share-${id}-${recommended}` : `share-${id}-close`);
  // What it offers and is not made yet is prepared now: a clear sign it will be wanted.
  // Their progress arrives with main's pushes, so the answer itself is not drawn.
  void window.settings.choose(`recordingShare:${id}`, { action: "open" }).catch(() => undefined);
}
export function closeShare(): void {
  const id = sharing?.id;
  sharing = undefined;
  draw();
  if (id) focus(`clip-${id}-more`);
}
export function toggleShareMore(): void {
  if (!sharing) return;
  // Into More, its first file is selected; back out, the recommended one again.
  const versions = versionsOf(sharing.id);
  const more = !sharing.more;
  const first = more ? versions.find((version) => version.more)?.kind : versions.find((version) => version.recommended)?.kind;
  sharing = { ...sharing, more, selected: first ? [first] : [], status: undefined };
  draw();
  if (first) focus(`share-${sharing.id}-${first}`);
}
/** Selects `kind` alone, or with `extend` (⌘-click) adds it to the selection or takes it away. */
export function selectShareVersion(kind: string, extend = false): void {
  if (!sharing) return;
  const selected = !extend ? [kind]
    : sharing.selected.includes(kind) ? sharing.selected.filter((entry) => entry !== kind) : [...sharing.selected, kind];
  sharing = { ...sharing, selected, status: undefined };
  draw();
}
/**
 * Copy, Save to… or a drag of the versions `kinds` of the recording `id` (the selection when none are named): a copy or
 * a save waits for what is still being prepared; a drag must have its files now. What happened is said in the bar.
 */
export async function shareAction(id: string, action: "copy" | "save" | "drag", kinds?: string[]): Promise<void> {
  const chosen = kinds ?? (sharing?.id === id ? sharing.selected : ["video"]);
  if (!chosen.length) return;
  const labels = view?.library?.items.find((entry) => entry.id === id)?.share?.labels;
  if (sharing?.id === id && action !== "drag") { sharing = { ...sharing, busy: true, status: undefined }; draw(); }
  try {
    const result = await window.settings.choose(`recordingShare:${id}`, { action, kinds: chosen } as ShareChoice);
    render(result.view);
    const status = result.applied ? (action === "copy" ? labels?.copied : action === "save" ? labels?.saved : undefined) : result.failure;
    if (sharing?.id === id) sharing = { ...sharing, busy: false, status };
    else if (!result.applied && result.failure) libraryError = result.failure;
    if (status) announce(status);
  } catch {
    if (sharing?.id === id) sharing = { ...sharing, busy: false, status: failedText() };
  } finally {
    draw();
  }
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
  // An editable recording's marker stays with the extension (plan 100, D3): the field holds its title alone.
  const extension = item.title && item.name.startsWith(item.title) && item.name.length > item.title.length
    ? item.name.slice(item.title.length) : /\.[^.]+$/.exec(item.name)?.[0] ?? "";
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
    renaming.help = undefined;
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
  const fail = (message: string, help?: FailureHelp): void => {
    if (renaming === current) {
      current.error = message;
      current.help = help;
      draw();
      focus("clip-rename-input");
    } else {
      libraryError = message;
      libraryHelp = help ? { ...help, for: message } : undefined;
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
        result.failureHelp,
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
  /** `revealCopy:<index>`: one of its saved copies shown in Finder (plan 100, D4). */
  action: "reveal" | "open" | "trash" | "drag" | "dragOriginal" | `revealCopy:${number}`,
): Promise<void> {
  menuId = undefined;
  draw();
  const dragging = action === "drag" || action === "dragOriginal";
  if (!dragging) {
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
        ? (failedText(result.failure))
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
    if (!dragging)
      libraryError = failedText();
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
        failedText(result.failure),
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
    announce(failedText());
  } finally {
    undoing = false;
    draw();
  }
}

/** Moves a recording into a folder, or with `null` into the output folder itself, and says where it went. */
export async function moveTo(id: string, folder: string | null): Promise<void> {
  menuId = undefined;
  const item = view?.library?.items.find((entry) => entry.id === id);
  // Its own set: a move must not wait for, nor be refused by, the card's other file actions.
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
      announce(translate("Moved {name} to {folder}", view?.language, { name: item.name, folder: folder ?? text("Uncategorized") }));
      const moved = result.renamed && view?.library?.items.find((entry) => entry.id === result.renamed);
      if (focused && moved && isShown(moved) && document.hasFocus()) focus(`clip-${moved.id}-open`);
    } else {
      libraryError = failedText(result.failure);
      libraryHelp = result.failureHelp ? { ...result.failureHelp, for: libraryError } : undefined;
    }
  } catch {
    libraryError = failedText();
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
    folderDialog.help = undefined;
    draw();
  }
}
export function cancelFolderDialog(): void {
  const renamingFolder = folderDialog?.folder !== undefined;
  folderDialog = undefined;
  draw();
  focus(renamingFolder ? "library-category-settings" : "library-category");
}
async function folderAction(choice: FolderChoice): Promise<{ applied: boolean; folder?: string; failure?: string; failureHelp?: FailureHelp }> {
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
  const fail = (message: string, help?: FailureHelp): void => {
    if (folderDialog === current) {
      current.error = message;
      current.help = help;
      draw();
      focus("library-folder-input");
    } else {
      libraryError = message;
      libraryHelp = help ? { ...help, for: message } : undefined;
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
    fail(failedText(result.failure), result.failureHelp);
    return;
  }
  // Only the dialog that asked, still open, takes the page to its folder and the focus with it: one cancelled meanwhile,
  // or a newer choice or entry, keeps what the user went to since (review pass 2, F3).
  const owned = folderDialog === current;
  if (owned) {
    folderDialog = undefined;
    // A new category is shown and remembered; a renamed one main already carried to its new name.
    if (result.folder !== undefined && current.folder === undefined) showFolder({ folder: result.folder }, false);
    else if (result.folder !== undefined) shownFolder = { folder: result.folder };
  }
  draw();
  announce(translate(current.folder === undefined ? "Created {folder}" : "Renamed category to {folder}", view?.language, { folder: result.folder ?? name }));
  if (owned) focus(current.folder === undefined ? "library-category" : "library-category-settings");
}
/** Moves an empty folder to the Trash and shows every recording. */
export async function removeFolder(folder: string): Promise<void> {
  menuId = undefined;
  if (folderPending) return;
  folderPending = true;
  draw();
  const trash = text(platform() === "darwin" ? "Moved to the Trash" : "Moved to the Recycle Bin");
  try {
    const result = await folderAction({ action: "removeFolder", folder });
    if (result.applied) {
      if (shownFolder?.folder === folder) shownFolder = undefined;
      announce(translate(platform() === "darwin" ? "Moved {name} to the Trash." : "Moved {name} to the Recycle Bin.", view?.language, { name: folder }));
      showToast("notice", trash, folder, 5000);
      focus("library-category");
    } else {
      // Said in a toast that leaves by itself, not a line that stays over the recordings (2026-10-09). A category that
      // still holds recordings says how many and what to do.
      const left = view?.library?.items.filter((item) => item.folder === folder).length ?? 0;
      const why = left
        ? translate(platform() === "darwin"
          ? (left === 1 ? "“{name}” still holds 1 recording. Move it to another category or to the Trash first." : "“{name}” still holds {count} recordings. Move them to another category or to the Trash first.")
          : (left === 1 ? "“{name}” still holds 1 recording. Move it to another category or to the Recycle Bin first." : "“{name}” still holds {count} recordings. Move them to another category or to the Recycle Bin first."),
          view?.language, { name: folder, count: left })
        : (failedText(result.failure));
      const title = translate("Could not delete “{name}”", view?.language, { name: folder });
      announce(sentences([title, why], view?.language));
      showToast("notice", title, why, 6000);
    }
  } finally {
    folderPending = false;
    draw();
  }
}

/** Adds the category to the selector's favorites, or takes it out; main keeps them across launches. */
export async function favorite(folder: string, on: boolean): Promise<void> {
  try {
    const result = await window.settings.choose("libraryFolder", { action: "favorite", folder, favorite: on });
    render(result.view);
    if (result.applied) announce(translate(on ? "Added {name} to favorites" : "Removed {name} from favorites", view?.language, { name: folder }));
    else failFavorite(result.failure);
  } catch {
    failFavorite(undefined);
  } finally {
    draw();
  }
}
function failFavorite(failure: string | undefined): void {
  const title = text("Could not update favorites"), why = failedText(failure);
  announce(sentences([title, why], view?.language));
  showToast("notice", title, why, 6000);
}
