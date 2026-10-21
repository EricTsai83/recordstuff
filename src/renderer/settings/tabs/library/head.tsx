/**
 * The Recordings tab's head: how many recordings and how much space they take, the search, the grid or list layout,
 * and the output folder's controls.
 */
import { Grid2X2, List, X, Search } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { InputGroup, InputGroupInput, InputGroupAddon, InputGroupButton } from "../../../components/ui/input-group";
import { ControlTooltip } from "../../../components/control-tooltip";
import { ToggleGroup, ToggleGroupItem } from "../../../components/ui/toggle-group";
import * as model from "../../settings-controller";
import { CategoryPicker } from "./category";
import { isComposing } from "./dialogs";

/** The library's count and size, beside the page's title (2026-10-09: the controls take a line of their own below). */
export function LibrarySummary() {
  const summary = model.view?.library?.summary;
  return (
    <p className="library-summary" hidden={!summary}>
      {summary}
    </p>
  );
}

/** The library's search and folder controls, on their own line in the page's fixed head above the scrolling recordings. */
export function LibraryHead() {
  const folder = model.view?.groups.find((group) => group.id === "outputFolder"),
    reveal = folder?.choices.find((choice) => choice.id === "reveal"),
    layout = model.shownLayout();
  return (
    <div className="library-head">
      <CategoryPicker />
      {/* At least 160px wide beside the others; a narrow line gives it a line of its own (ui.css .library-head). */}
      <InputGroup className="library-search darwin:window-no-drag">
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
        className="library-layout segments darwin:window-no-drag"
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
        className="darwin:window-no-drag"
        disabled={!folder?.enabled || !reveal?.enabled}
        aria-disabled={
          Boolean(model.savingOf("outputFolder")) || !folder?.enabled || !reveal?.enabled
        }
        onClick={() => {
          if (!model.savingOf("outputFolder") && folder?.enabled && reveal?.enabled)
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
