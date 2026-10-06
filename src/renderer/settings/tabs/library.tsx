/** The Recordings tab: cards or a list by day, a card's menu, renaming, and the embedded player dialog. */
import { useEffect, useRef, useState, useSyncExternalStore, memo } from "react";
import { Film, MoreHorizontal, Play, Grid2X2, List, Folder, FileText, HardDrive, X, Maximize } from "lucide-react";
import type { LibraryItemView } from "../../../shared/settings-panel";
import { phrases, translate } from "../../../shared/i18n";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { Card } from "../../components/ui/card";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "../../components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "../../components/ui/dialog";
import { flushSync } from "react-dom";
import { Player } from "../../player/player";
import * as model from "../settings-controller";

export const Clip = memo(function Clip({
  item,
  language,
}: {
  item: LibraryItemView;
  language: string;
}) {
  useSyncExternalStore(
    model.subscribe,
    () =>
      `${model.menuId === item.id}/${model.view?.libraryFocus === item.id ? model.view.resultFocus : ""}`,
  );
  const [failed, setFailed] = useState(false),
    [arrived, setArrived] = useState(false),
    title = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    setFailed(false);
  }, [item.thumbnail]);
  useEffect(() => {
    if (model.view?.libraryFocus === item.id && model.view.resultFocus)
      setArrived(true);
  }, [item.id, model.view?.resultFocus]);
  const tooltip = (): void => {
    const node = title.current;
    if (!node) return;
    if (
      node.scrollHeight > node.clientHeight + 1 ||
      node.scrollWidth > node.clientWidth + 1
    )
      node.title = item.title;
    else node.removeAttribute("title");
  };
  const p = model.platform(),
    t = model.text;
  return (
    <Card
      id={`clip-${item.id}`}
      className={`clip gap-0 p-0${arrived ? " arrived" : ""}`}
      data-id={item.id}
      draggable
      title={t("Drag into another app to share.")}
      onDragStart={(event) => {
        event.preventDefault();
        void model.fileAction(item.id, "drag");
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        model.openMenu(item.id);
      }}
      onAnimationEnd={() => setArrived(false)}
      onBlur={() => setArrived(false)}
    >
      <Button
        variant="ghost"
        size="clip"
        id={`clip-${item.id}-open`}
        // The list layout lays a card out in one line, leaving room on the right for its menu button.
        className="clip-open in-data-[layout=list]:flex-row in-data-[layout=list]:items-center in-data-[layout=list]:pr-10"
        aria-label={translate(
          "Play {title}",
          language === "zh-TW" ? "zh-TW" : "en",
          {
            title: phrases(
              [
                item.title,
                item.day,
                item.time,
                item.duration,
                item.size,
              ].filter((part): part is string => Boolean(part)),
              language === "zh-TW" ? "zh-TW" : "en",
            ),
          },
        )}
        onClick={() => model.openPlayer(item)}
      >
        <span className={`clip-thumb${failed ? " no-thumb" : ""}`}>
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
          <span className="clip-play" aria-hidden="true">
            <Play className="play-icon size-[18px] in-data-[layout=list]:size-[13px]" />
          </span>
        </span>
        <span className="clip-text">
          <span
            ref={title}
            className="clip-title"
            onMouseEnter={tooltip}
            onMouseMove={tooltip}
          >
            {item.title}
          </span>
          <span className="clip-meta">
            {[item.time, item.size].join(" · ")}
          </span>
          <span className="clip-detail">
            {[item.time, item.duration, item.size].filter(Boolean).join(" · ")}
          </span>
        </span>
      </Button>
      <DropdownMenu
        open={model.menuId === item.id}
        onOpenChange={(open) => {
          if (open) model.openMenu(item.id);
          else if (model.menuId === item.id) model.closeMenu();
        }}
      >
        <DropdownMenuTrigger
          render={<Button variant="secondary" size="icon-sm" />}
          id={`clip-${item.id}-more`}
          className="clip-more"
          aria-label={translate(
            "More actions for {title}",
            model.view?.language,
            { title: item.title },
          )}
          title={translate("More actions for {title}", model.view?.language, {
            title: item.title,
          })}
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
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
          <DropdownMenuItem
            id="clip-menu-reveal"
            onClick={() => void model.fileAction(item.id, "reveal")}
          >
            <Folder />
            <span className="menu-label">
              {t(p === "darwin" ? "Show in Finder" : "Open folder")}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            id="clip-menu-open"
            onClick={() => void model.fileAction(item.id, "open")}
          >
            <Play />
            <span className="menu-label">{t("Open")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            id="clip-menu-rename"
            onClick={() => model.openRename(item.id)}
          >
            <FileText />
            <span className="menu-label">{t("Rename…")}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            id="clip-menu-trash"
            variant="destructive"
            onClick={() => void model.fileAction(item.id, "trash")}
          >
            <HardDrive />
            <span className="menu-label">
              {t(p === "darwin" ? "Move to Trash" : "Move to Recycle Bin")}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Card>
  );
});
export function Library() {
  const library = model.view?.library,
    items = library?.items ?? [],
    days = [...new Set(items.map((item) => item.day))],
    folder = model.view?.groups.find((group) => group.id === "outputFolder"),
    reveal = folder?.choices.find((choice) => choice.id === "reveal"),
    layout = model.optimisticLayout ?? library?.layout ?? "grid";
  return (
    <section id="library" aria-labelledby="tab-library" data-layout={layout}>
      <div className="library-head">
        <p className="library-summary" hidden={!library?.summary}>
          {library?.summary}
        </p>
        <ToggleGroup
          className="library-layout segments rounded-[8px] bg-muted p-0.5"
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
          <ToggleGroupItem
            id="library-layout-grid"
            value="grid"
            aria-label={model.text("Grid")}
            title={model.text("Grid")}
          >
            <Grid2X2 />
          </ToggleGroupItem>
          <ToggleGroupItem
            id="library-layout-list"
            value="list"
            aria-label={model.text("List")}
            title={model.text("List")}
          >
            <List />
          </ToggleGroupItem>
        </ToggleGroup>
        <Button
          id="library-reveal"
          variant="outline"
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
      <p
        className="library-error"
        hidden={!model.libraryError && !library?.notice}
      >
        {model.libraryError ?? library?.notice}
      </p>
      <p className="library-status" hidden={!library?.status}>
        {library?.status}
      </p>
      <div
        className="library-empty"
        hidden={Boolean(items.length || library?.status || !library)}
      >
        <Film className="empty-icon" />
        <p className="library-empty-title">{model.text("No recordings yet")}</p>
        <p className="library-empty-detail">
          {translate(
            "Recordings saved to {path} appear here.",
            model.view?.language,
            { path: library?.folder ?? "" },
          )}
        </p>
      </div>
      <div className="library-days">
        {days.map((day) => (
          <section className="library-day" key={day}>
            <h2 className="day-heading">{day}</h2>
            <div className="library-grid">
              {items
                .filter((item) => item.day === day)
                .map((item) => (
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
        className="clip-rename"
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
        <DialogTitle id="clip-rename-label">
          {translate("New name for {title}", model.view?.language, {
            title: item?.title ?? "",
          })}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {model.text("Rename…")}
        </DialogDescription>
        <Label className="sr-only" htmlFor="clip-rename-input">
          {model.text("Rename")}
        </Label>
        <span className="clip-rename-field">
          <Input
            id="clip-rename-input"
            value={rename?.name ?? ""}
            spellCheck={false}
            autoComplete="off"
            aria-describedby="clip-rename-error"
            aria-invalid={Boolean(rename?.error)}
            onInput={(event) => model.renameDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void model.submitRename();
              }
            }}
          />
          <span className="clip-rename-extension">{rename?.extension}</span>
        </span>
        <p
          id="clip-rename-error"
          className="clip-rename-error"
          hidden={!rename?.error}
        >
          {rename?.error}
        </p>
        <div className="clip-rename-buttons">
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
        </div>
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
              <Button
                variant="media"
                size="icon-media"
                id="player-fullscreen"
                aria-label={model.text("Full screen")}
                title={model.text("Full screen")}
                onClick={() => void model.playFullScreen()}
              >
                <Maximize />
              </Button>
            }
            close={
              <Button
                variant="media"
                size="icon-media"
                id="player-close"
                aria-label={model.text("Close")}
                title={model.text("Close")}
                onClick={() => model.closePlayer()}
              >
                <X />
              </Button>
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
