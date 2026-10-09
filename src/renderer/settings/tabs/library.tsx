/**
 * The Recordings tab: cards or a list by day, a card's menu, renaming, the embedded player dialog, and its folders and
 * search (plan 071).
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, memo } from "react";
import { Film, MoreHorizontal, Play, Grid2X2, List, Folder, FileText, HardDrive, X, Maximize, Search, FolderPlus, FolderInput, SearchX } from "lucide-react";
import type { LibraryItemView } from "../../../shared/settings-panel";
import { phrases, translate, type Language } from "../../../shared/i18n";
import { Button } from "../../components/ui/button";
import { Field, FieldLabel, FieldError } from "../../components/ui/field";
import { InputGroup, InputGroupInput, InputGroupAddon, InputGroupText, InputGroupButton } from "../../components/ui/input-group";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "../../components/ui/empty";
import { ControlTooltip } from "../../components/control-tooltip";
import { useTruncated } from "../../lib/use-truncated";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent } from "../../components/ui/context-menu";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { Card } from "../../components/ui/card";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from "../../components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogHeader, DialogFooter } from "../../components/ui/dialog";
import { flushSync } from "react-dom";
import { Player } from "../../player/player";
import * as model from "../settings-controller";
import { ClipPreview, hoverClip, leaveClip, pressedOnBar, previewing, previewTime, stopPreview, subscribePreview } from "./clip-preview";

export const Clip = memo(function Clip({
  item,
  language,
}: {
  item: LibraryItemView;
  language: Language;
}) {
  useSyncExternalStore(
    model.subscribe,
    () =>
      `${model.menuId === item.id ? model.menuKind : ""}/${model.arrivingAt(item.id)}`,
  );
  const preview = useSyncExternalStore(subscribePreview, () => previewing() === item.id);
  const [failed, setFailed] = useState(false),
    [arrived, setArrived] = useState(false),
    title = useTruncated<HTMLSpanElement>();
  useEffect(() => {
    setFailed(false);
  }, [item.thumbnail]);
  useEffect(() => {
    if (model.takeArrival(item.id)) setArrived(true);
  });
  return (
    <ContextMenu
      open={model.menuId === item.id && model.menuKind === "context"}
      onOpenChange={(open) => {
        if (open) model.openMenu(item.id, "context");
        else if (model.menuId === item.id && model.menuKind === "context") model.closeMenu();
      }}
    >
      <ContextMenuTrigger render={<Card />}
        id={`clip-${item.id}`}
        className={`clip gap-0 overflow-visible rounded-[14px] bg-transparent p-0 shadow-none ring-0 dark:bg-transparent${arrived ? " arrived" : ""}`}
        data-id={item.id}
        draggable
        onDragStart={(event) => {
          event.preventDefault();
          // The drag starts at the card, wherever it was pressed; one pressed on the preview's seek bar seeks instead.
          // A folder in the tab's head takes the card if it is dropped there (plan 071).
          if (!pressedOnBar()) {
            model.startDragging(item.id);
            void model.fileAction(item.id, "drag");
          }
        }}
        onAnimationEnd={() => setArrived(false)}
        onBlur={() => setArrived(false)}
      >
        <Button
          variant="ghost"
          size="clip"
          id={`clip-${item.id}-open`}
          // The list layout lays a card out in one line, leaving room on the right for its menu button.
          // Its focus line is drawn round the whole card (ui.css), not inside it.
          // No transition and no hover fill: a card stays still under the pointer, and animating the list's padding
          // would reflow every card on each frame.
          className="clip-open transition-none rounded-none border-0 hover:bg-transparent dark:hover:bg-transparent active:not-aria-[haspopup]:translate-y-0 focus-visible:outline-none! focus-visible:ring-0 in-data-[layout=list]:flex-row in-data-[layout=list]:items-center in-data-[layout=list]:pr-10"
          aria-label={translate(
            "Play {title}",
            language,
            {
              title: phrases(
                [
                  item.title,
                  item.day,
                  item.time,
                  item.duration,
                  item.size,
                ].filter((part): part is string => Boolean(part)),
                language,
              ),
            },
          )}
          // A card whose preview has moved plays on from the moment it shows.
          onClick={() => {
            const start = previewTime(item.id);
            stopPreview();
            model.openPlayer(item, start);
          }}
        >
          <span
            className={`clip-thumb${failed ? " no-thumb" : ""}${preview ? " previewing" : ""}`}
            // Only a mouse resting on a grid card's picture previews it; a list row's picture is too small to watch.
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse" && event.currentTarget.closest("#library")?.getAttribute("data-layout") === "grid")
                hoverClip(item.id);
            }}
            onPointerLeave={() => leaveClip(item.id)}
          >
            <Film className="clip-fallback size-9" />
            <img
              alt=""
              src={item.thumbnail}
              loading="lazy"
              decoding="async"
              onError={() => flushSync(() => setFailed(true))}
              onLoad={() => flushSync(() => setFailed(false))}
            />
            <span className="clip-duration" hidden={!item.duration}>
              {item.duration}
            </span>
            {preview && <ClipPreview item={item} />}
          </span>
          <span className="clip-text">
            <ControlTooltip label={item.title} enabled={title.truncated} delay={1000}>
              <span
                ref={title.ref}
                className="clip-title"
                onPointerEnter={() => flushSync(title.measure)}
                onPointerMove={() => flushSync(title.measure)}
              >
                {item.title}
              </span>
            </ControlTooltip>
            <span className="clip-meta">
              {[item.time, item.size].join(" · ")}
            </span>
            <span className="clip-detail">
              {[item.time, item.duration, item.size].filter(Boolean).join(" · ")}
            </span>
          </span>
        </Button>
        <DropdownMenu
          open={model.menuId === item.id && model.menuKind === "dropdown"}
          onOpenChange={(open) => {
            if (open) model.openMenu(item.id);
            else if (model.menuId === item.id && model.menuKind === "dropdown") model.closeMenu();
          }}
        >
          <ControlTooltip label={translate("More actions for {title}", model.view?.language, { title: item.title })}>
            <DropdownMenuTrigger
              render={<Button variant="secondary" size="icon-sm" />}
              id={`clip-${item.id}-more`}
              className="clip-more"
              aria-label={translate(
                "More actions for {title}",
                model.view?.language,
                { title: item.title },
              )}
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
          </ControlTooltip>
          <DropdownMenuContent
            finalFocus={false}
            id="clip-menu"
            // As wide as its longest item, never wrapping one (as a macOS menu), whatever the ⋯ button's width.
            className="clip-menu w-auto min-w-[196px] whitespace-nowrap"
            align="end"
            onKeyDown={(event) => {
              if (event.key === "Tab") {
                event.preventDefault();
                event.stopPropagation();
                model.closeMenu();
              }
            }}
          >
            <ClipMenuActions item={item} />
          </DropdownMenuContent>
        </DropdownMenu>
      </ContextMenuTrigger>
      <ContextMenuContent
        id="clip-context-menu"
        className="clip-menu w-auto min-w-[196px] whitespace-nowrap"
        finalFocus={false}
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            event.preventDefault();
            event.stopPropagation();
            model.closeMenu();
          }
        }}
      >
        <ClipMenuActions item={item} context />
      </ContextMenuContent>
    </ContextMenu>
  );
}, (previous, next) => previous.language === next.language &&
  // IPC clones the whole view when a layout preference is saved. Compare the file's
  // values so unchanged cards keep their menus/tooltips without rendering them again.
  (Object.keys(previous.item) as (keyof LibraryItemView)[]).length === Object.keys(next.item).length &&
  (Object.keys(previous.item) as (keyof LibraryItemView)[]).every(key => previous.item[key] === next.item[key]));

function ClipMenuActions({ item, context = false }: { item: LibraryItemView; context?: boolean }) {
  const Item = context ? ContextMenuItem : DropdownMenuItem;
  const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
  const Sub = context ? ContextMenuSub : DropdownMenuSub;
  const SubTrigger = context ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
  const SubContent = context ? ContextMenuSubContent : DropdownMenuSubContent;
  const prefix = context ? "clip-context-menu" : "clip-menu";
  const p = model.platform(), t = model.text;
  // Every place but its own: Unsorted for one in a folder, and each other folder.
  const targets: Array<{ folder: string | null; label: string }> = [
    ...(item.folder === undefined ? [] : [{ folder: null, label: t("Unsorted") }]),
    ...(model.view?.library?.folders ?? []).filter((entry) => entry.name !== item.folder).map((entry) => ({ folder: entry.name, label: entry.name })),
  ];
  return (
    <>
      <Item
        id={`${prefix}-reveal`}
        onClick={() => void model.fileAction(item.id, "reveal")}
      >
        <Folder />
        <span className="menu-label">
          {t(p === "darwin" ? "Show in Finder" : "Open folder")}
        </span>
      </Item>
      <Item
        id={`${prefix}-open`}
        onClick={() => void model.fileAction(item.id, "open")}
      >
        <Play />
        <span className="menu-label">{t("Open")}</span>
      </Item>
      <Item
        id={`${prefix}-rename`}
        onClick={() => model.openRename(item.id)}
      >
        <FileText />
        <span className="menu-label">{t("Rename…")}</span>
      </Item>
      {targets.length > 0 && (
        <Sub>
          <SubTrigger id={`${prefix}-move`}>
            <FolderInput />
            <span className="menu-label">{t("Move to")}</span>
          </SubTrigger>
          <SubContent className="clip-menu w-auto min-w-[160px] whitespace-nowrap">
            {targets.map((target, index) => (
              <Item
                key={target.folder ?? ""}
                id={`${prefix}-move-${index}`}
                onClick={() => void model.moveTo(item.id, target.folder)}
              >
                <Folder />
                <span className="menu-label">{target.label}</span>
              </Item>
            ))}
          </SubContent>
        </Sub>
      )}
      <Separator />
      <Item
        id={`${prefix}-trash`}
        variant="destructive"
        onClick={() => void model.fileAction(item.id, "trash")}
      >
        <HardDrive />
        <span className="menu-label">
          {t(p === "darwin" ? "Move to Trash" : "Move to Recycle Bin")}
        </span>
      </Item>
    </>
  );
}

/** The library's summary and folder controls, drawn in the page's fixed head above the scrolling recordings. */
export function LibraryHead() {
  const library = model.view?.library,
    folder = model.view?.groups.find((group) => group.id === "outputFolder"),
    reveal = folder?.choices.find((choice) => choice.id === "reveal"),
    layout = model.optimisticLayout ?? library?.layout ?? "grid";
  return (
    <div className="library-head">
      <p className="library-summary" hidden={!library?.summary}>
        {library?.summary}
      </p>
      <InputGroup className="library-search darwin:wide:window-no-drag">
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          id="library-search"
          type="text"
          value={model.query}
          placeholder={model.text("Search recordings")}
          aria-label={model.text("Search recordings")}
          spellCheck={false}
          autoComplete="off"
          onInput={(event) => model.search(event.currentTarget.value)}
          onKeyDown={(event) => {
            // Escape clears a search first; with nothing typed it closes the window as anywhere else.
            if (event.key === "Escape" && model.query) {
              event.preventDefault();
              model.search("");
            }
          }}
        />
        {model.query && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              id="library-search-clear"
              size="icon-sm"
              aria-label={model.text("Clear search")}
              onClick={() => {
                model.search("");
                document.getElementById("library-search")?.focus();
              }}
            >
              <X />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
      <ControlTooltip label={model.text("New folder")}>
        <Button
          id="library-new-folder"
          variant="ghost"
          size="icon"
          className="library-new-folder darwin:wide:window-no-drag"
          aria-label={model.text("New folder")}
          disabled={!library}
          onClick={() => model.openFolderDialog()}
        >
          <FolderPlus />
        </Button>
      </ControlTooltip>
      <ToggleGroup
        className="library-layout segments darwin:wide:window-no-drag"
        variant="segmented"
        size="segment"
        spacing={0.5}
        aria-label={model.text("Layout")}
        value={[layout]}
        onValueChange={(values) => {
          const value = values[0];
          if (value === "grid" || value === "list")
            void model.chooseLayout(value);
        }}
      >
        <ControlTooltip label={model.text("Grid")}>
          <ToggleGroupItem
            id="library-layout-grid"
            value="grid"
            aria-label={model.text("Grid")}
          >
            <Grid2X2 />
          </ToggleGroupItem>
        </ControlTooltip>
        <ControlTooltip label={model.text("List")}>
          <ToggleGroupItem
            id="library-layout-list"
            value="list"
            aria-label={model.text("List")}
          >
            <List />
          </ToggleGroupItem>
        </ControlTooltip>
      </ToggleGroup>
      <Button
        id="library-reveal"
        variant="outline"
        className="darwin:wide:window-no-drag"
        disabled={!folder?.enabled || !reveal?.enabled}
        aria-disabled={
          Boolean(model.saving) || !folder?.enabled || !reveal?.enabled
        }
        onClick={() => {
          if (!model.saving && folder?.enabled && reveal?.enabled)
            void model.revealFolder();
        }}
      >
        {reveal?.label ??
          model.text(
            model.platform() === "darwin" ? "Show in Finder" : "Open folder",
          )}
      </Button>
    </div>
  );
}

/**
 * The head's second line (plan 071): every recording, Unsorted (the output folder itself) and each folder, with their
 * counts, then the shown folder's actions. It stays above the scrolling cards, so a card dragged from
 * anywhere in the list can be dropped on a folder.
 */
export function LibraryFolders() {
  const library = model.view?.library,
    items = library?.items ?? [],
    folders = library?.folders ?? [],
    shown = model.shownFolder,
    selected = typeof shown?.folder === "string" ? folders.find((entry) => entry.name === shown.folder) : undefined,
    language = model.view?.language;
  const [over, setOver] = useState<string | null | undefined>(undefined);
  const count = (folder: string | null): number => items.filter((item) => (item.folder ?? null) === folder).length;
  // A card dragged from this page, and only that card's own file, moves where it is dropped.
  const target = (folder: string | null) => ({
    onDragOver: (event: React.DragEvent) => {
      if (!model.dragging || !event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      setOver(folder);
    },
    onDragLeave: () => setOver(undefined),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      setOver(undefined);
      const id = model.dragging, files = event.dataTransfer.files,
        item = items.find((entry) => entry.id === id);
      // A stale id, from a drag that ended outside the page, must not move a recording for another file dropped here
      // (review pass 1, F1): the dropped file must be the card's own by name and size.
      if (id && item && files.length === 1 && files[0]?.name === item.name && (item.bytes === undefined || files[0].size === item.bytes))
        void model.moveTo(id, folder);
      else model.stopDragging();
    },
  });
  const chip = (id: string, label: string, pressed: boolean, choose: () => void, folder?: string | null) => (
    <Button
      key={id}
      id={id}
      variant="ghost"
      size="sm"
      className="library-folder"
      aria-pressed={pressed}
      data-drop={folder !== undefined && over === folder ? "" : undefined}
      onClick={choose}
      {...(folder === undefined ? {} : target(folder))}
    >
      <span className="library-folder-name">{label}</span>
      <span className="library-folder-count">{folder === undefined ? items.length : count(folder)}</span>
    </Button>
  );
  // Until there is a folder, All and Unsorted would show the same cards: the line is not drawn, and New folder waits in
  // the head's first line.
  if (!library || !folders.length) return null;
  return (
    <div className="library-folders darwin:wide:window-no-drag">
      <div className="library-folder-list" role="group" aria-label={model.text("Folders")}>
        {chip("library-folder-all", model.text("All"), shown === undefined, () => model.showFolder(undefined))}
        {chip("library-folder-unsorted", model.text("Unsorted"), shown?.folder === null, () => model.showFolder({ folder: null }), null)}
        {folders.map((entry, index) =>
          chip(`library-folder-${index}`, entry.name, shown?.folder === entry.name, () => model.showFolder({ folder: entry.name }), entry.name))}
      </div>
      {selected && (
        <DropdownMenu>
          <ControlTooltip label={translate("Folder actions for {folder}", language, { folder: selected.name })}>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-sm" />}
              id="library-folder-more"
              aria-label={translate("Folder actions for {folder}", language, { folder: selected.name })}
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
          </ControlTooltip>
          <DropdownMenuContent data-folder-actions="" className="clip-menu w-auto min-w-[180px] whitespace-nowrap" finalFocus={false}>
            <DropdownMenuItem id="library-folder-rename" onClick={() => model.openFolderDialog(selected.name)}>
              <FileText />
              <span className="menu-label">{model.text("Rename folder…")}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem id="library-folder-delete" variant="destructive" onClick={() => void model.removeFolder(selected.name)}>
              <HardDrive />
              <span className="menu-label">{model.text("Delete folder")}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** New folder, or Rename folder… for the folder shown: one name, checked as main will before it is sent. */
export function FolderDialog() {
  const dialog = model.folderDialog,
    language = model.view?.language;
  return (
    <Dialog
      open={Boolean(dialog)}
      onOpenChange={(open) => {
        if (!open) model.cancelFolderDialog();
      }}
    >
      <DialogContent
        id="library-folder-dialog"
        className="clip-rename max-h-[calc(100dvh-32px)] overflow-y-auto"
        showCloseButton={false}
        initialFocus={() => {
          const field = document.getElementById("library-folder-input") as HTMLInputElement | null;
          field?.select();
          return field;
        }}
        finalFocus={false}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            model.cancelFolderDialog();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="[overflow-wrap:anywhere]">
            {dialog?.folder === undefined
              ? model.text("New folder")
              : translate("New name for {title}", language, { title: dialog.folder })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {model.text(dialog?.folder === undefined ? "New folder" : "Rename folder…")}
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel className="sr-only" htmlFor="library-folder-input">
            {model.text("Folder name")}
          </FieldLabel>
          <InputGroup className="clip-rename-field bg-card">
            <InputGroupInput
              id="library-folder-input"
              value={dialog?.name ?? ""}
              placeholder={model.text("Folder name")}
              spellCheck={false}
              autoComplete="off"
              aria-describedby={dialog?.error ? "library-folder-error" : undefined}
              aria-invalid={Boolean(dialog?.error)}
              onInput={(event) => model.folderDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void model.submitFolderDialog();
                }
              }}
            />
          </InputGroup>
          <FieldError role={undefined} id="library-folder-error" className="clip-rename-error" hidden={!dialog?.error}>
            {dialog?.error}
          </FieldError>
        </Field>
        <DialogFooter className="clip-rename-buttons">
          <Button id="library-folder-cancel" variant="outline" onClick={() => model.cancelFolderDialog()}>
            {model.text("Cancel")}
          </Button>
          <Button id="library-folder-confirm" aria-disabled={dialog?.pending} onClick={() => void model.submitFolderDialog()}>
            {model.text(dialog?.folder === undefined ? "Create" : "Rename")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Library() {
  const library = model.view?.library,
    all = library?.items,
    shownFolder = model.shownFolder,
    query = model.query,
    items = useMemo(() => model.shownItems(library), [all, shownFolder, query]),
    narrowed = Boolean(all?.length) && (shownFolder !== undefined || query.trim() !== ""),
    layout = model.optimisticLayout ?? library?.layout ?? "grid";
  const days = useMemo(() => {
    const groups = new Map<string, LibraryItemView[]>();
    for (const item of items ?? []) {
      const group = groups.get(item.day);
      if (group) group.push(item);
      else groups.set(item.day, [item]);
    }
    return [...groups];
  }, [items]);
  // A preview belongs to the grid on a shown tab: switching to the list, or to another tab while the pointer stays
  // where the picture was (this tab stays mounted, only hidden), ends it, and one waiting to start never does.
  const shown = model.selectedTab === "library";
  useEffect(() => {
    if (layout !== "grid" || !shown) stopPreview();
  }, [layout, shown]);
  return (
    <section id="library" aria-labelledby="tab-library" data-layout={layout}>
      <p
        className="library-error"
        hidden={!model.libraryError && !library?.notice}
      >
        {model.libraryError ?? library?.notice}
      </p>
      <p className="library-status" hidden={!library?.status}>
        {library?.status}
      </p>
      <Empty
        id="library-none-shown"
        className="library-empty py-10 text-muted-foreground [overflow-wrap:anywhere]"
        hidden={Boolean(items.length || library?.status || !library || !(narrowed || shownFolder))}
      >
        <EmptyHeader className="max-w-full">
          <EmptyMedia>{query.trim() ? <SearchX className="size-[38px]" /> : <Folder className="size-[38px]" />}</EmptyMedia>
          <EmptyTitle className="library-empty-title text-base">
            {query.trim()
              ? translate("No recordings match “{query}”.", model.view?.language, { query: query.trim() })
              : model.text("This folder is empty.")}
          </EmptyTitle>
          <EmptyDescription className="library-empty-detail" hidden={Boolean(query.trim())}>
            {model.text("Drag a recording here, or choose Move to in its menu.")}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
      <Empty
        className="library-empty py-10 text-muted-foreground [overflow-wrap:anywhere]"
        hidden={Boolean(all?.length || library?.status || !library || shownFolder)}
      >
        <EmptyHeader className="max-w-full">
        <EmptyMedia><Film className="size-[38px]" /></EmptyMedia>
        <EmptyTitle className="library-empty-title text-base">{model.text("No recordings yet")}</EmptyTitle>
        <EmptyDescription className="library-empty-detail">
          {translate(
            "Recordings saved to {path} appear here.",
            model.view?.language,
            { path: library?.folder ?? "" },
          )}
        </EmptyDescription>
        </EmptyHeader>
      </Empty>
      <div className="library-days">
        {days.map(([day, dayItems]) => (
          <section className="library-day" key={day}>
            <h2 className="day-heading" data-count={dayItems.length}>{day}</h2>
            <div className="library-grid">
              {dayItems.map((item) => (
                  <Clip
                    key={item.id}
                    item={item}
                    language={model.view?.language ?? "en"}
                  />
                ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
export function RenameDialog() {
  const rename = model.renaming,
    item = model.view?.library?.items.find((item) => item.id === rename?.id);
  return (
    <Dialog
      open={Boolean(rename)}
      onOpenChange={(open) => {
        if (!open) model.cancelRename();
      }}
    >
      <DialogContent
        id="clip-rename"
        className="clip-rename max-h-[calc(100dvh-32px)] overflow-y-auto"
        showCloseButton={false}
        initialFocus={() => {
          const field = document.getElementById(
            "clip-rename-input",
          ) as HTMLInputElement | null;
          field?.select();
          return field;
        }}
        finalFocus={false}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            model.cancelRename();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle id="clip-rename-label" className="[overflow-wrap:anywhere]">
            {translate("New name for {title}", model.view?.language, {
              title: item?.title ?? "",
            })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {model.text("Rename…")}
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel className="sr-only" htmlFor="clip-rename-input">
            {model.text("Rename")}
          </FieldLabel>
          <InputGroup className="clip-rename-field bg-card">
            <InputGroupInput
              id="clip-rename-input"
              value={rename?.name ?? ""}
              spellCheck={false}
              autoComplete="off"
              aria-describedby={rename?.error ? "clip-rename-error" : undefined}
              aria-invalid={Boolean(rename?.error)}
              onInput={(event) => model.renameDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void model.submitRename();
                }
              }}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupText className="clip-rename-extension">{rename?.extension}</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
          <FieldError role={undefined}
            id="clip-rename-error"
            className="clip-rename-error"
            hidden={!rename?.error}
          >
            {rename?.error}
          </FieldError>
        </Field>
        <DialogFooter className="clip-rename-buttons">
          <Button
            id="clip-rename-cancel"
            variant="outline"
            onClick={() => model.cancelRename()}
          >
            {model.text("Cancel")}
          </Button>
          <Button
            id="clip-rename-confirm"
            aria-disabled={rename?.pending}
            onClick={() => void model.submitRename()}
          >
            {model.text("Rename")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
export function PlayerDialog() {
  const cached = useRef<LibraryItemView | undefined>(undefined);
  if (model.playingItem) cached.current = model.playingItem;
  const item = cached.current;
  return (
    <Dialog
      open={Boolean(model.playingItem)}
      onOpenChange={(open, details) => {
        if (!open) {
          if (details.reason === "escape-key") model.markEscapeClosed();
          model.closePlayer();
        }
      }}
    >
      <DialogContent
        keepMounted
        // The player's stage: as wide as the window allows at 16:9, black in both themes, below the title bar on macOS.
        overlayClassName="bg-media-backdrop supports-backdrop-filter:backdrop-blur-[3px]"
        className="player aspect-video rounded-[14px] shadow-player ring-0 w-[min(860px,calc(100vw-48px),calc((100dvh-72px)*16/9))] max-w-none gap-0 overflow-hidden bg-media p-0 text-media-foreground sm:max-w-none darwin:top-[calc(50%+24px)]"
        data-id={item?.id}
        showCloseButton={false}
        initialFocus={() => model.playerVideo}
        finalFocus={false}
        onKeyDown={(event) => {
          if (
            event.key === "Escape" &&
            (event.repeat || model.fullScreenPending)
          )
            event.preventDefault();
        }}
      >
        <DialogTitle id="player-title" className="sr-only">
          {item?.title}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {model.text("Play")}
        </DialogDescription>
        {item && (
          <Player
            id="player"
            source={model.playingItem?.video ?? ""}
            title={item.title}
            meta={[
              phrases([item.day, item.time], model.view?.language),
              item.duration,
              item.size,
            ]
              .filter(Boolean)
              .join(" · ")}
            language={model.view?.language ?? "en"}
            videoRef={model.attachVideo}
            onError={model.playerFailed}
            onDoubleClick={() => void model.playFullScreen()}
            onPlay={() => {
              if (model.fullScreenPending) model.playerVideo?.pause();
            }}
            fullScreen={() => void model.playFullScreen()}
            error={model.playerError}
            trailing={
              <ControlTooltip label={model.text("Full screen")}>
                <Button
                  variant="media"
                  size="icon-media"
                  id="player-fullscreen"
                  aria-label={model.text("Full screen")}
                  onClick={() => void model.playFullScreen()}
                >
                  <Maximize />
                </Button>
              </ControlTooltip>
            }
            close={
              <ControlTooltip label={model.text("Close")}>
                <Button
                  variant="media"
                  size="icon-media"
                  id="player-close"
                  aria-label={model.text("Close")}
                  onClick={() => model.closePlayer()}
                >
                  <X />
                </Button>
              </ControlTooltip>
            }
          />
        )}
        <p
          id="player-feedback"
          className="sr-only"
          role="status"
          aria-live="polite"
        >
          {model.feedbackText}
        </p>
      </DialogContent>
    </Dialog>
  );
}
