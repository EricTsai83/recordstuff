/** The Recordings tab: its layout, a card's menu, renaming, file actions and undoing a move to the Trash. */
import { translate } from "../../../shared/i18n";
import type { LibraryLayout } from "../../../shared/appearance";
import { fileNameProblem, fileNameProblemText } from "../../../shared/file-name";
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
/** Only the latest layout request's answer ends the optimistic layout: an earlier one would flash back its choice. */
let layoutRequest = 0;
let undoing = false;
const trashedCards: string[] = [];
const fileActionsPending = new Set<string>();
/** Another tab, or an explicit entry, closes a card's menu and its rename without a draw of their own. */
export function dismissLibraryOverlays(): void {
  menuId = undefined;
  renaming = undefined;
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
export const undoPending = (): boolean => undoing;
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
