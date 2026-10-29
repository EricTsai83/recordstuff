/**
 * A recording's card or list row: its thumbnail and hover preview, its title and details, and its menu (open,
 * reveal, rename, edit (plan 085), move to a category, Move to Trash), the same as a context menu and a ⋯ button.
 */
import { useEffect, useState, useSyncExternalStore, memo } from "react";
import { Film, EllipsisVertical, Play, Volume2, VolumeX, Folder, FileText, HardDrive, FolderInput, SquarePen, Share } from "lucide-react";
import { ShareOverlay } from "./share";
import type { LibraryItemView } from "../../../../shared/settings-panel";
import { phrases, translate, type Language } from "../../../../shared/i18n";
import { Button } from "../../../components/ui/button";
import { ControlTooltip } from "../../../components/control-tooltip";
import { clearArrival, flashArrival } from "../../../lib/arrival";
import { useTruncated } from "../../../lib/use-truncated";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent } from "../../../components/ui/context-menu";
import { Card } from "../../../components/ui/card";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from "../../../components/ui/dropdown-menu";
import { flushSync } from "react-dom";
import * as model from "../../settings-controller";
import { ClipPreview, hoverClip, leaveClip, pressedOnBar, previewing, previewTime, stopPreview, subscribePreview } from "../clip-preview";

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
      `${model.menuId === item.id ? model.menuKind : ""}/${model.arrivingAt(item.id)}/${model.previewSound()}/${model.sharing?.id === item.id ? `${model.sharing.more}:${model.sharing.selected.join("+")}:${model.sharing.status ?? ""}:${model.sharing.busy ?? ""}` : ""}`,
  );
  const preview = useSyncExternalStore(subscribePreview, () => previewing() === item.id);
  const sound = model.previewSound();
  const [failed, setFailed] = useState(false),
    [portrait, setPortrait] = useState(false),
    title = useTruncated<HTMLSpanElement>();
  useEffect(() => {
    setFailed(false);
    setPortrait(false);
  }, [item.thumbnail]);
  useEffect(() => {
    if (model.takeArrival(item.id)) flashArrival(document.getElementById(`clip-${item.id}`));
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
        className="clip gap-0 overflow-visible rounded-[14px] bg-transparent p-0 shadow-none ring-0 dark:bg-transparent"
        data-id={item.id}
        draggable
        onDragStart={(event) => {
          event.preventDefault();
          // The drag starts at the card, wherever it was pressed; one pressed on the preview's seek bar seeks instead.
          // It gives the Video, what the card plays, and with ⌥ (Alt) the recording as made (plan 100).
          if (!pressedOnBar()) void model.fileAction(item.id, event.altKey ? "dragOriginal" : "drag");
        }}
        onBlur={(event) => clearArrival(event.currentTarget)}
        // ⌘C on a card copies its Video, what a drag gives (plan 100 step 3); inside Share… the panel's own ⌘C copies.
        onKeyDown={(event) => {
          if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "c" || !item.share || model.sharing?.id === item.id) return;
          if ((event.target as Element).closest("input, textarea, [contenteditable]")) return;
          event.preventDefault();
          void model.shareAction(item.id, "copy", ["video"]);
        }}
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
                  item.editable,
                  item.preparing?.label,
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
            className={`clip-thumb${failed ? " no-thumb" : ""}${portrait ? " portrait" : ""}${preview ? " previewing" : ""}`}
            // Only a mouse resting on a grid card's picture previews it; a list row's picture is too small to watch.
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse" && event.currentTarget.closest("#library")?.getAttribute("data-layout") === "grid")
                hoverClip(item.id);
            }}
            // Onto the card's speaker, the pointer stays with the preview it switches the sound of.
            onPointerLeave={(event) => {
              if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest(".clip-sound"))) leaveClip(item.id);
            }}
          >
            <Film className="clip-fallback size-9" />
            <img
              alt=""
              src={item.thumbnail}
              loading="lazy"
              decoding="async"
              onError={() => flushSync(() => { setFailed(true); setPortrait(false); })}
              // A portrait recording is shown whole (ui.css), told by its picture: the card carries no size of its own.
              onLoad={(event) => {
                const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
                flushSync(() => { setFailed(false); setPortrait(height > width); });
              }}
            />
            <span className="clip-duration" hidden={!item.duration}>
              {item.duration}
            </span>
            {preview && <ClipPreview item={item} sound={sound} />}
            {item.preparing && (
              <span className="clip-preparing" data-state={item.preparing.state}>
                <span>{item.preparing.label}</span>
                <span className="clip-preparing-hint">{item.preparing.hint}</span>
                {item.preparing.state === "preparing" && (
                  <span className="clip-preparing-bar" aria-hidden="true">
                    <span style={{ width: `${Math.round((item.preparing.progress ?? 0) * 100)}%` }} />
                  </span>
                )}
              </span>
            )}
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
              {[item.time, item.size].filter(Boolean).join(" · ")}
              <EditableMark item={item} />
            </span>
            <span className="clip-detail">
              {[item.time, item.duration, item.size].filter(Boolean).join(" · ")}
              <EditableMark item={item} />
            </span>
          </span>
        </Button>
        {/* While a preview plays, a speaker at the picture's top right turns its sound on or off; the choice is kept
            (settings `libraryPreviewSound`) and starts muted. */}
        {preview && (
          <ControlTooltip label={translate(sound ? "Mute" : "Unmute", language)}>
            <Button
              variant="secondary"
              size="icon-sm"
              id={`clip-${item.id}-sound`}
              // The preview's speaker, at the picture's top right while the preview plays.
              className="clip-sound absolute top-[7px] right-[7px]"
              aria-label={translate(sound ? "Mute" : "Unmute", language)}
              onPointerLeave={(event) => {
                const back = event.relatedTarget instanceof Node && event.currentTarget.closest(".clip")?.querySelector(".clip-thumb")?.contains(event.relatedTarget);
                if (!back) leaveClip(item.id);
              }}
              onClick={() => void model.choosePreviewSound(!sound)}
            >
              {sound ? <Volume2 /> : <VolumeX />}
            </Button>
          </ControlTooltip>
        )}
        {model.sharing?.id === item.id && (
          <ShareOverlay item={item} layout={document.getElementById("library")?.getAttribute("data-layout") === "list" ? "list" : "grid"} />
        )}
        <DropdownMenu
          open={model.menuId === item.id && model.menuKind === "dropdown"}
          onOpenChange={(open) => {
            if (open) model.openMenu(item.id);
            else if (model.menuId === item.id && model.menuKind === "dropdown") model.closeMenu();
          }}
        >
          <ControlTooltip label={translate("More actions for {title}", model.view?.language, { title: item.title })}>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon" />}
              id={`clip-${item.id}-more`}
              className="clip-more"
              aria-label={translate(
                "More actions for {title}",
                model.view?.language,
                { title: item.title },
              )}
            >
              <EllipsisVertical className="size-[18px]" strokeWidth={2.5} />
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
      {item.share && (
        <Item id={`${prefix}-share`} onClick={() => model.openShare(item.id)}>
          <Share />
          <span className="menu-label">{t("Share…")}</span>
        </Item>
      )}
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
      <Item
        id={`${prefix}-edit`}
        onClick={() => void model.openEditor(item)}
      >
        <SquarePen />
        <span className="menu-label">{t(item.edited ? "Continue editing…" : "Edit…")}</span>
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

/**
 * An editable recording's mark on its card (2026-10-26, the maintainer's request): under the pointer it reads as a link,
 * and a click on it opens the edit view rather than playing the recording. Inside the card's own button, so it is not a
 * control of its own: the keyboard and assistive technology reach the edit view by the card's menu, Edit…. A recording
 * that holds an edit is not marked on its card (the maintainer's call of 2026-10-26: shown whether or not it had been
 * exported, the mark said nothing to act on); its menu offers Continue editing….
 */
function EditableMark({ item }: { item: LibraryItemView }) {
  return (
    <>
      {item.editable && (
        <>
          {" · "}
          <ControlTooltip label={item.editableHint ?? item.editable} enabled={Boolean(item.editableHint)}>
            <span
              className="clip-editable"
              // Pressed, it is the mark's own: the card neither plays nor starts a drag from it.
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void model.openEditor(item);
              }}
            >
              {item.editable}
            </span>
          </ControlTooltip>
        </>
      )}
    </>
  );
}

