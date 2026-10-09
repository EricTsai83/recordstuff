/**
 * The Recordings tab: cards or a list by day, a card's menu, renaming, the embedded player dialog, and its folders and
 * search (plan 071).
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore, memo } from "react";
import { Film, MoreHorizontal, Play, Grid2X2, List, Folder, FileText, HardDrive, X, Maximize, Search, FolderInput, SearchX, FolderOpen, ChevronDown, Check, Plus, Star, Settings2 } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "../../components/ui/popover";
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

/** A key an input method is still composing with (keyCode 229 where `isComposing` is not set): it is the method's, not ours. */
function isComposing(event: React.KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

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
          if (!pressedOnBar()) void model.fileAction(item.id, "drag");
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
  // Every place but its own: out of its folder for one in a folder, and each other folder.
  const targets: Array<{ folder: string | null; label: string }> = [
    ...(item.folder === undefined ? [] : [{ folder: null, label: t("Uncategorized") }]),
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

/** The library's count and size, beside the page's title (2026-10-09: the controls take a line of their own below). */
export function LibrarySummary() {
  const summary = model.view?.library?.summary;
  return (
    <p className="library-summary" hidden={!summary}>
      {summary}
    </p>
  );
}

/**
 * The category selector (2026-10-09): one button naming the category shown, whose list holds every recording,
 * Uncategorized, the favorites first and then every other category, filtered as one types, with New category at its foot.
 * Categories are the output folder's subfolders; favorites are only a group of this list, never a line of their own.
 */
function CategoryPicker() {
  const library = model.view?.library,
    language = model.view?.language,
    items = library?.items ?? [],
    folders = library?.folders ?? [],
    favorites = new Set(library?.favorites ?? []),
    shown = model.shownFolder;
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  // New category hands the focus to its dialog; any other way the list closes gives it back to the selector (review F4).
  const toDialog = useRef(false);
  const count = (folder: string | null | undefined): number =>
    folder === undefined ? items.length : items.filter((item) => (item.folder ?? null) === folder).length;
  type Option = { id: string; label: string; scope: { folder: string | null } | undefined; group: "top" | "favorites" | "others" };
  const words = filter.trim().toLocaleLowerCase();
  const options: Option[] = [
    { id: "all", label: model.text("All"), scope: undefined, group: "top" as const },
    { id: "none", label: model.text("Uncategorized"), scope: { folder: null }, group: "top" as const },
    ...(library?.favorites ?? []).map((name) => ({ id: `f-${name}`, label: name, scope: { folder: name }, group: "favorites" as const })),
    ...folders.filter((entry) => !favorites.has(entry.name)).map((entry) => ({ id: `c-${entry.name}`, label: entry.name, scope: { folder: entry.name }, group: "others" as const })),
  ].filter((option) => !words || option.label.toLocaleLowerCase().includes(words));
  const at = Math.min(active, Math.max(0, options.length - 1));
  const isCurrent = (option: Option): boolean =>
    option.scope === undefined ? shown === undefined : shown !== undefined && shown.folder === option.scope.folder;
  const label = shown === undefined ? model.text("All") : shown.folder === null ? model.text("Uncategorized") : shown.folder;
  const choose = (option: Option | undefined): void => {
    if (!option) return;
    setOpen(false);
    model.showFolder(option.scope);
    model.focus("library-category");
  };
  const optionId = (option: Option): string => `library-category-option-${options.indexOf(option)}`;
  // The option the arrows reach stays in view when many categories scroll inside the list (review F5).
  useEffect(() => {
    if (open) document.getElementById(`library-category-option-${at}`)?.scrollIntoView({ block: "nearest" });
  }, [open, at]);
  const group = (name: Option["group"], heading?: string) => {
    const members = options.filter((option) => option.group === name);
    if (!members.length) return null;
    return (
      <div role="group" aria-label={heading} className="library-category-group">
        {heading && <div className="library-category-heading" aria-hidden="true">{heading}</div>}
        {members.map((option) => (
          <div
            key={option.id}
            id={optionId(option)}
            role="option"
            aria-selected={isCurrent(option)}
            data-active={options.indexOf(option) === at ? "" : undefined}
            className="library-category-option"
            onPointerMove={() => setActive(options.indexOf(option))}
            onClick={() => choose(option)}
          >
            <Check className="library-category-check" aria-hidden="true" />
            <span className="library-category-label">{option.label}</span>
            <span className="library-category-count">{count(option.scope?.folder)}</span>
          </div>
        ))}
      </div>
    );
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        setOpen(next);
        if (next) {
          toDialog.current = false;
          setFilter("");
          setActive(0);
        }
        // Escape gives the focus back to the selector (review F4); leaving by Tab or a click keeps it where it went
        // (review pass 2, F1), and choosing a category moves it itself.
        else if (!toDialog.current && details.reason === "escape-key") model.focus("library-category");
      }}
    >
      <PopoverTrigger
        render={<Button variant="outline" />}
        id="library-category"
        // At most 200px; on a short line it gives way first, down to 96px, its name cut by an ellipsis (ui.css .library-head).
        className="library-category min-w-0 max-w-[200px] darwin:wide:window-no-drag"
        disabled={!library || Boolean(library.status)}
        aria-label={translate("Category: {name}", language, { name: label })}
      >
        <FolderOpen />
        <span className="library-category-current">{label}</span>
        <ChevronDown className="opacity-60" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        data-folder-actions=""
        className="library-category-popup w-64 gap-1 p-1.5"
        initialFocus={() => document.getElementById("library-category-filter")}
        finalFocus={false}
      >
        <InputGroup className="mb-1">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            id="library-category-filter"
            role="combobox"
            aria-expanded="true"
            aria-controls="library-category-list"
            aria-activedescendant={options[at] ? optionId(options[at]) : undefined}
            aria-label={model.text("Search categories")}
            placeholder={model.text("Search categories")}
            value={filter}
            spellCheck={false}
            autoComplete="off"
            onInput={(event) => {
              setFilter(event.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              // An input method's Enter or arrows choose its characters, not a category (review pass 2, F2).
              if (isComposing(event)) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setActive((at + step + options.length) % Math.max(1, options.length));
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(options[at]);
              }
            }}
          />
        </InputGroup>
        <div id="library-category-list" role="listbox" aria-label={model.text("Categories")} className="library-category-list">
          {group("top")}
          {group("favorites", model.text("Favorites"))}
          {group("others", model.text("All categories"))}
          {!options.length && (
            <p className="library-category-none">{translate("No categories match “{query}”.", language, { query: filter.trim() })}</p>
          )}
        </div>
        <div className="library-category-separator" role="separator" />
        <Button
          id="library-category-new"
          variant="ghost"
          className="library-category-new"
          onClick={() => {
            toDialog.current = true;
            setOpen(false);
            model.openFolderDialog();
          }}
        >
          <Plus />
          {model.text("New category")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The category shown, above its recordings (2026-10-09): its name and count, and for a category of the user's, its
 * favorite star and settings (rename, delete; the star alone adds or removes the favorite). Every recording has no
 * heading; Uncategorized has no actions.
 */
function CategoryHeader() {
  const library = model.view?.library,
    language = model.view?.language,
    shown = model.shownFolder;
  if (!library || !shown) return null;
  const folder = shown.folder;
  const count = library.items.filter((item) => (item.folder ?? null) === folder).length;
  const favorite = typeof folder === "string" && (library.favorites ?? []).includes(folder);
  const name = folder ?? model.text("Uncategorized");
  const favoriteLabel = model.text(favorite ? "Remove from favorites" : "Add to favorites");
  return (
    <div className="library-category-head" id="library-category-head">
      <h2 className="library-category-title">{name}</h2>
      <span className="library-category-total">{translate(count === 1 ? "1 recording" : "{count} recordings", language, { count })}</span>
      {typeof folder === "string" && (
        <span className="library-category-actions">
          <ControlTooltip label={favoriteLabel}>
            <Button
              id="library-category-favorite"
              variant="ghost"
              size="icon-lg"
              // A favorite's star takes the primary colour, filled; any other is the plain outline.
              className={favorite ? "text-primary hover:text-primary" : undefined}
              aria-label={favoriteLabel}
              aria-pressed={favorite}
              onClick={() => void model.favorite(folder, !favorite)}
            >
              <Star className={favorite ? "fill-current" : undefined} />
            </Button>
          </ControlTooltip>
          <DropdownMenu>
            <ControlTooltip label={translate("Category settings for {folder}", language, { folder })}>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-lg" />}
                id="library-category-settings"
                aria-label={translate("Category settings for {folder}", language, { folder })}
              >
                <Settings2 />
              </DropdownMenuTrigger>
            </ControlTooltip>
            <DropdownMenuContent data-folder-actions="" align="end" className="clip-menu w-auto min-w-[196px] whitespace-nowrap" finalFocus={false}>
              <DropdownMenuItem id="library-category-rename" onClick={() => model.openFolderDialog(folder)}>
                <FileText />
                <span className="menu-label">{model.text("Rename category…")}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem id="library-category-delete" variant="destructive" onClick={() => void model.removeFolder(folder)}>
                <HardDrive />
                <span className="menu-label">{model.text("Delete category")}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      )}
    </div>
  );
}

/** The library's search and folder controls, on their own line in the page's fixed head above the scrolling recordings. */
export function LibraryHead() {
  const library = model.view?.library,
    folder = model.view?.groups.find((group) => group.id === "outputFolder"),
    reveal = folder?.choices.find((choice) => choice.id === "reveal"),
    layout = model.optimisticLayout ?? library?.layout ?? "grid";
  return (
    <div className="library-head">
      <CategoryPicker />
      {/* At least 160px wide beside the others; a narrow line gives it a line of its own (ui.css .library-head). */}
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
            if (event.key === "Escape" && model.query && !isComposing(event)) {
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
              ? model.text("New category")
              : translate("New name for {title}", language, { title: dialog.folder })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {model.text(dialog?.folder === undefined ? "New category" : "Rename category…")}
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel className="sr-only" htmlFor="library-folder-input">
            {model.text("Category name")}
          </FieldLabel>
          <InputGroup className="clip-rename-field bg-card">
            <InputGroupInput
              id="library-folder-input"
              value={dialog?.name ?? ""}
              placeholder={model.text("Category name")}
              spellCheck={false}
              autoComplete="off"
              aria-describedby={dialog?.error ? "library-folder-error" : undefined}
              aria-invalid={Boolean(dialog?.error)}
              onInput={(event) => model.folderDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !isComposing(event)) {
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
    // The field shows each key at once; the list follows a deferred copy of the search, re-rendered in the background and
    // dropped for a newer one while typing goes on (React's useDeferredValue), so a long list never holds the typing up.
    // An entry that cleared the search takes the live one, so the card it brings is there to focus (model.queryNow).
    deferredQuery = useDeferredValue(model.query),
    query = model.queryNow ? model.query : deferredQuery,
    items = useMemo(() => model.shownItems(library, query), [all, shownFolder, query]),
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
      <CategoryHeader />
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
              : model.text("This category is empty.")}
          </EmptyTitle>
          <EmptyDescription className="library-empty-detail" hidden={Boolean(query.trim())}>
            {model.text("Choose Move to in a recording's menu to add it here.")}
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
                if (event.key === "Enter" && !isComposing(event)) {
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
