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
        query={query}
        hidden={Boolean(!empty || !query.trim())}
        elsewhere={shownFolder ? (all ?? []).filter((item) => model.matchesSearch(item, query)).length : 0}
      />
      <Empty
        id="library-none-shown"
        className="library-empty py-10 text-muted-foreground [overflow-wrap:anywhere]"
        hidden={Boolean(!empty || query.trim())}
      >
        <EmptyHeader className="max-w-full">
          <EmptyMedia><Folder className="size-[38px]" /></EmptyMedia>
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

/** A search past this many characters is cut short where the empty state repeats it; the field still holds all of it. */
const QUOTED_QUERY = 40;
/** Where the search's words and the category go in the sentence, so each can be drawn as a tag of its own. */
const QUERY_MARK = "\u0000",
  FOLDER_MARK = "\u0001";

/**
 * The search found nothing in what is shown: what was searched and where, a way to clear it, and, from a category, the
 * recordings elsewhere that do match.
 */
function NoSearchMatch({ query, hidden, elsewhere }: { query: string; hidden: boolean; elsewhere: number }) {
  const language = model.view?.language,
    words = query.trim(),
    quoted = words.length > QUOTED_QUERY ? `${words.slice(0, QUOTED_QUERY).trimEnd()}…` : words,
    folder = model.shownFolder,
    folderName = folder ? (folder.folder ?? model.text("Uncategorized")) : "",
    sentence = folder
      ? translate("No recording names in {folder} contain {query}.", language, { folder: FOLDER_MARK, query: QUERY_MARK })
      : translate("No recording names contain {query}.", language, { query: QUERY_MARK }),
    // The sentence's own words, with the category and the search as tags where the translation puts them.
    parts = sentence.split(/([\u0000\u0001])/).map((part, at) =>
      part === QUERY_MARK ? (
        <span
          key={at}
          className="library-no-match-query mx-px rounded-md bg-muted px-1.5 py-px font-medium text-foreground [box-decoration-break:clone]"
          title={quoted === words ? undefined : words}
        >
          {quoted}
        </span>
      ) : part === FOLDER_MARK ? (
        <span
          key={at}
          className="library-no-match-folder mx-px inline-flex max-w-48 items-baseline gap-1 rounded-md bg-muted px-1.5 py-px align-baseline font-medium text-foreground"
          title={folderName}
        >
          <Folder className="size-3.5 shrink-0 self-center" />
          <span className="truncate">{folderName}</span>
        </span>
      ) : (
        part
      ),
    );
  // Either way the button goes, so the focus goes back to the search to type again.
  const focusSearch = () => document.getElementById("library-search")?.focus();
  return (
    <Empty id="library-no-match" className="library-empty py-10 text-muted-foreground [overflow-wrap:anywhere]" hidden={hidden}>
      <EmptyHeader className="max-w-full gap-1.5">
        <EmptyMedia>
          <NoMatchArt className="size-24" />
        </EmptyMedia>
        <EmptyTitle className="library-empty-title text-[17px] font-semibold text-foreground">{model.text("No matching recordings")}</EmptyTitle>
        <EmptyDescription className="library-empty-detail max-w-[22rem] text-[13px] leading-6">
          {parts}
        </EmptyDescription>
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
    </Empty>
  );
}
