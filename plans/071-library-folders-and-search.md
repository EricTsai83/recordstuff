# 071 — Folders and search in the Recordings tab

[English](071-library-folders-and-search.md) | [繁體中文](071-library-folders-and-search.zh-TW.md)

Status: in progress. Created: 2026-10-09. Priority: active, ahead of 070 at the maintainer's request. Hard dependencies: none. Execute the steps in order under [the plan index](README.md).

## Goal and boundaries

The Recordings tab lists only the videos directly in the output folder, newest first, with no way to organize or search them. The maintainer asked (2026-10-09) for the app to organize its own recordings and to make them easier to find. Tags were considered and deferred: they need a store of their own (app data, sidecar files or macOS-only Finder tags), each of which loses them in a common case, and two overlapping ways of sorting would burden a menu bar recorder.

Folders are real subfolders of the output folder, one level deep, so Finder and the app always agree, nothing new is stored, and a folder survives a reinstall, a sync or Clear local app data. The maintainer accepted one level (2026-10-09): a tree would need a sidebar and breadcrumbs in a window two cards wide, could crawl unrelated deep trees when the output folder is `~/Movies` or the Desktop, and would let a folder move into its own child.

Not in scope: tags, nested folders, saving new recordings into a chosen folder, remembering the selected folder or the search between window openings, and searching anything but names. Recording, capture and file writing do not change.

## Contract

- **Listing.** The output folder's direct subfolders are listed with their direct videos, except hidden folders, names that end in an extension (`iMovie Library.imovielibrary`, `Foo.app`, packages in general) and symbolic links. A folder that holds a visible file but no video is left out (unrelated folders in `~/Movies`); a completely empty folder is shown, so a new one appears. Videos deeper down are not listed and never touched. A subfolder that cannot be read is left out and logged.
- **Watching.** While the window is open the folder is watched recursively; only events on a listed name in the folder or a direct subfolder, or on a possible subfolder of the folder itself, list it again. A deeper change waits for the next focus.
- **Folder bar.** All, Unsorted (the folder itself) and each folder, with counts, then New folder. The selected folder offers Rename folder… and Delete folder. The choice lives in the page only.
- **Moving.** A card's menu gains Move to ▸ (Unsorted and each folder but its own); a card dragged onto a folder in the bar moves there. A move never replaces another file (the rename's link-then-unlink, or exclusive reservation without hard links); a taken name says so. Length and thumbnail carry over.
- **Create / rename / delete.** Names are checked as file names are and may not start with a dot or end in an extension. Rename never replaces a folder: an existing name is refused, and a case-only change is allowed. Delete is offered only for a folder with no visible file and moves it to the Trash; recordings in it still waiting for Undo go to the Trash first. A folder renamed meanwhile keeps its waiting recordings' Undo.
- **Search.** A field in the tab's head filters the selected folder's cards by name, ignoring case; with All, every folder. No match and an empty folder each say so.
- **Entry.** Show last recording and a saved notification still bring their recording into view: the page clears the search and selects All.
- **Security.** Main resolves only listed ids and listed folders; the page never sends a path.

## Implementation sequence

- [x] 1. Library: subfolder listing, recursive watch filter, shared no-replace move, `move`, `createFolder`, `renameFolder`, `removeFolder`, with module tests on real temporary folders.
- [x] 2. View and IPC: `LibraryView.folders`, `LibraryItemView.folder`, choice guards, model/window routing and the main wiring, with model and window tests.
- [x] 3. Page: folder bar, folder menu and dialogs, Move to, drop on a folder, search, empty states and entry reset, with page tests; English and Traditional Chinese copy.
- [x] 4. Documentation: [desktop design](../docs/system-design/desktop.md#recordings), function catalogue and their translations.

## Verification and limits

Settings controls, persistence and IPC: affected unit tests, `pnpm typecheck` and one `pnpm acceptance:regression` on the final build; `git diff --check`. A recording smoke round is not required: no capture or file-writing path changes.

Not provable in the background: whether a card's native drag (`webContents.startDrag`) is delivered as a drop on the same page, and the CPU of a recursive watch over a large output folder (`pnpm measure:cpu`, a desktop round; the watch exists only while the window is open). Both are reported as unverified unless the maintainer asks for a desktop round.

At closure, keep the durable contract in system design, record the evidence and limits in verification, update both indexes and remove these plan files.
