/**
 * The Recordings tab: cards or a list by day, a card's menu, renaming, the embedded player dialog, and its folders and
 * search (plan 071).
 */
import { useDeferredValue, useEffect, useMemo } from "react";
import { Film, Folder } from "lucide-react";
import type { LibraryItemView } from "../../../shared/settings-panel";
import { translate } from "../../../shared/i18n";
import { Button } from "../../components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "../../components/ui/empty";
import * as model from "../settings-controller";
import { stopPreview } from "./clip-preview";
import { CategoryHeader } from "./library/category";
import { Clip } from "./library/clip";
import { NoMatchArt } from "./library/no-match-art";

// The tab's parts live under library/; these are what Settings imports, as before the split.
export { LibraryHead, LibrarySummary } from "./library/head";
export { FolderDialog, PlayerDialog, RenameDialog } from "./library/dialogs";
export { EditorDialog } from "./library/editor";

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
    // Nothing to show where something could be: the search or the category shown leaves no card.
    empty = !items.length && !library?.status && Boolean(library) && (narrowed || Boolean(shownFolder)),
    layout = model.shownLayout();
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
        {/* A failure's way out (plan 100), while the error it came with is the one shown. */}
        {model.libraryError && model.libraryHelp?.for === model.libraryError && (
          <>
            {" "}
            <Button id="library-error-help" variant="link" size="sm" className="h-auto px-0 align-baseline" onClick={() => void model.runFailureHelp(model.libraryHelp!)}>
              {model.libraryHelp.label}
            </Button>
          </>
        )}
      </p>
      <p className="library-status" hidden={!library?.status}>
        {library?.status}
      </p>
      <NoSearchMatch
        hidden={Boolean(!empty || !query.trim())}
        elsewhere={shownFolder ? (all ?? []).filter((item) => model.matchesSearch(item, query)).length : 0}
      />
      <Empty
        id="library-none-shown"
        className="library-empty py-10 text-muted-foreground [overflow-wrap:anywhere]"
        hidden={Boolean(!empty || query.trim())}
      >
        <EmptyHeader className="max-w-full">
          <EmptyMedia><Folder className="size-10" /></EmptyMedia>
          <EmptyTitle className="library-empty-title text-base">{model.text("This category is empty.")}</EmptyTitle>
          <EmptyDescription className="library-empty-detail">
            {model.text("Choose Move to in a recording's menu to add it here.")}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
      <Empty
        className="library-empty py-10 text-muted-foreground [overflow-wrap:anywhere]"
        hidden={Boolean(all?.length || library?.status || !library || shownFolder)}
      >
        <EmptyHeader className="max-w-full">
        <EmptyMedia><Film className="size-10" /></EmptyMedia>
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

/** The search found nothing in what is shown: a way to clear it and, from a category, the recordings elsewhere that match. */
function NoSearchMatch({ hidden, elsewhere }: { hidden: boolean; elsewhere: number }) {
  const language = model.view?.language;
  // Either way the button goes, so the focus goes back to the search to type again.
  const focusSearch = () => document.getElementById("library-search")?.focus();
  return (
    <Empty id="library-no-match" className="library-empty py-10 text-muted-foreground [overflow-wrap:anywhere]" hidden={hidden}>
      {/* Hidden, it holds nothing: no button of it stays in the page for the keyboard or a page-wide query to find. */}
      {!hidden && (
        <>
          <EmptyHeader className="max-w-full gap-1.5">
            <EmptyMedia>
              <NoMatchArt className="size-24" />
            </EmptyMedia>
            <EmptyTitle className="library-empty-title text-lg font-semibold text-foreground">{model.text("No matching recordings")}</EmptyTitle>
          </EmptyHeader>
          <EmptyContent className="mt-1 flex-row flex-wrap justify-center">
            {elsewhere > 0 && (
              <Button
                id="library-no-match-all"
                onClick={() => {
                  model.showFolder(undefined);
                  focusSearch();
                }}
              >
                {translate("Search all recordings ({count})", language, { count: elsewhere })}
              </Button>
            )}
            <Button
              id="library-no-match-clear"
              variant="outline"
              onClick={() => {
                model.search("");
                focusSearch();
              }}
            >
              {model.text("Clear search")}
            </Button>
          </EmptyContent>
        </>
      )}
    </Empty>
  );
}
