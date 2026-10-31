/**
 * The category selector and the shown category's head: every recording, Uncategorized, the favorites and every other
 * category, filtered as one types, with New category; rename, delete and favorite from its settings menu.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, HardDrive, Search, FolderOpen, ChevronDown, Plus, Star, Settings2 } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "../../../components/ui/popover";
import { translate } from "../../../../shared/i18n";
import { Button } from "../../../components/ui/button";
import { InputGroup, InputGroupInput, InputGroupAddon } from "../../../components/ui/input-group";
import { ControlTooltip } from "../../../components/control-tooltip";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "../../../components/ui/dropdown-menu";
import * as model from "../../settings-controller";
import { isComposing } from "./dialogs";

/**
 * The category selector (2026-10-09): one button naming the category shown, whose list holds every recording,
 * Uncategorized, the favorites first and then every other category, filtered as one types, with New category at its foot.
 * Categories are the output folder's subfolders; favorites are only a group of this list, never a line of their own.
 */
export function CategoryPicker() {
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
  // Counted once per listing, not per option and keystroke: the list shows a count beside every category.
  const counts = useMemo(() => {
    const byFolder = new Map<string | null, number>();
    for (const item of items) byFolder.set(item.folder ?? null, (byFolder.get(item.folder ?? null) ?? 0) + 1);
    return byFolder;
  }, [items]);
  const count = (folder: string | null | undefined): number => folder === undefined ? items.length : counts.get(folder) ?? 0;
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
            <span className="choice-radio" aria-hidden="true" />
            <span className="library-category-label">{option.label}</span>
            <span className="library-category-count tabular-nums text-muted-foreground">{count(option.scope?.folder)}</span>
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
        className="library-category min-w-0 max-w-50 darwin:window-no-drag"
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
            <p className="library-category-none p-2 text-2xs text-muted-foreground wrap-anywhere">{translate("No categories match “{query}”.", language, { query: filter.trim() })}</p>
          )}
        </div>
        <div className="h-px my-1 mx-0.5 bg-border" role="separator" />
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
export function CategoryHeader() {
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
      <span className="library-category-total flex-none text-xs text-muted-foreground">{translate(count === 1 ? "1 recording" : "{count} recordings", language, { count })}</span>
      {typeof folder === "string" && (
        <span className="flex gap-0.5 ml-auto text-muted-foreground">
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
            <DropdownMenuContent data-folder-actions="" align="end" className="clip-menu w-auto min-w-49 whitespace-nowrap" finalFocus={false}>
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
