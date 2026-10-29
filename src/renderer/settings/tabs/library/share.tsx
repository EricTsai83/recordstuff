/**
 * Share… (plan 100 step 3, the maintainer's choice of 2026-10-30: the card as a little folder). A recording's versions
 * shown as the files they leave as: each a document with its format and what it is, dragged out to give it, or picked
 * for Copy and Save to… in the bar below. The Video, recommended, is picked as the panel opens; the Original always
 * carries a mark that it holds everything recorded. Sources is a folder, and More opens as one.
 *
 * Over a grid card the panel covers the whole card, picture and title row; a list row is too small, so there it opens
 * below the row as a popover.
 *
 * Selecting: a click selects a file, ⌘-click adds it or takes it away; the arrow keys move between files, Space selects,
 * ⌘C or Return copies the selection, Escape closes. Dragging a selected file drags every selected one; dragging another
 * drags it alone. A version still being prepared shows it on its icon,
 * as a ring in its corner (the maintainer's choice of 2026-10-30: one sign of progress, over the corner), so every file
 * keeps the same two lines under it; Copy and Save to… wait for it, a drag does not start.
 */
import type { ReactNode } from "react";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Copy, Download, X } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { LibraryItemView, ShareVersionView, ShareView } from "../../../../shared/settings-panel";
import { Button } from "../../../components/ui/button";
import { Popover, PopoverContent } from "../../../components/ui/popover";
import * as model from "../../settings-controller";

export function ShareOverlay({ item, layout }: { item: LibraryItemView; layout: "grid" | "list" }) {
  const share = item.share;
  if (!share) return null;
  const body = <SharePanel item={item} share={share} />;
  // A list row is too small: the panel opens below it, as a popover anchored to the row.
  if (layout === "list") {
    return (
      <Popover open onOpenChange={(open) => { if (!open) model.closeShare(); }}>
        <PopoverContent anchor={() => document.getElementById(`clip-${item.id}`)} align="end" className="share-panel share-popover" aria-label={share.heading}>
          {body}
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <div
      className="share-panel share-over-card"
      role="dialog"
      aria-label={share.heading}
      // Pressed inside, the panel is its own: the card neither plays nor starts its own drag.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); model.closeShare(); } }}
    >
      {body}
    </div>
  );
}

/** The panel's keys: arrows between files, Space selects, ⌘C and Return copy the selection. */
function onKeys(event: ReactKeyboardEvent, item: LibraryItemView, files: string[]): void {
  const at = files.indexOf((document.activeElement?.id ?? "").replace(`share-${item.id}-`, ""));
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
    event.preventDefault();
    void model.shareAction(item.id, "copy");
  } else if (event.key === "Enter" && at >= 0) {
    event.preventDefault();
    void model.shareAction(item.id, "copy");
  } else if (event.key === " " && at >= 0) {
    event.preventDefault();
    model.selectShareVersion(files[at]!, event.metaKey || event.ctrlKey);
  } else if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && files.length) {
    event.preventDefault();
    const next = Math.max(0, Math.min(files.length - 1, (at < 0 ? 0 : at) + (event.key === "ArrowRight" ? 1 : -1)));
    document.getElementById(`share-${item.id}-${files[next]}`)?.focus();
  }
}

function SharePanel({ item, share }: { item: LibraryItemView; share: ShareView }) {
  const main = share.versions.filter((version) => !version.more);
  const more = share.versions.filter((version) => version.more);
  const inMore = model.sharing?.more ?? false;
  const shown = inMore ? more : main;
  const selected = shown.filter((version) => model.sharing?.selected.includes(version.kind));
  return (
    <div className="share-body" onKeyDown={(event) => onKeys(event, item, shown.map((version) => version.kind))}>
      <div className="share-head">
        {inMore ? (
          <Button variant="ghost" size="sm" className="share-back" id={`share-${item.id}-back`} onClick={() => model.toggleShareMore()}>
            <ChevronLeft />{share.labels.share}
          </Button>
        ) : (
          <span className="share-title">{share.labels.share}</span>
        )}
        {inMore && <><ChevronRight className="share-crumb" aria-hidden="true" /><span className="share-title">{share.labels.more}</span></>}
        <span className="share-subject" title={item.title}>{item.title}</span>
        <Button variant="ghost" size="icon-sm" id={`share-${item.id}-close`} aria-label={share.labels.close} onClick={() => model.closeShare()}>
          <X />
        </Button>
      </div>
      <div className="share-files" role="listbox" aria-multiselectable="true" aria-label={share.heading}>
        {shown.map((version) => (
          <FileItem key={version.kind} item={item} share={share} version={version} picked={selected.includes(version)} />
        ))}
        {!inMore && more.length > 0 && (
          <button type="button" id={`share-${item.id}-more`} className="share-file" onClick={() => model.toggleShareMore()}>
            <span className="share-icon"><FolderGlyph /></span>
            <span className="share-name">{share.labels.more}</span>
            <span className="share-detail">{share.labels.moreCount.replace("{count}", String(more.length))}</span>
          </button>
        )}
      </div>
      <div className="share-bar">
        {selected.length ? <PickedBar item={item} share={share} selected={selected} /> : <span className="share-hint">{share.labels.drag}</span>}
      </div>
    </div>
  );
}

function FileItem({ item, share, version, picked }: { item: LibraryItemView; share: ShareView; version: ShareVersionView; picked: boolean }) {
  const extension = version.kind === "sources" ? undefined : /\.([^.]+)$/.exec(version.fileName)?.[1]?.toUpperCase();
  return (
    <button
      type="button"
      id={`share-${item.id}-${version.kind}`}
      className="share-file"
      role="option"
      aria-selected={picked}
      aria-label={[version.label, version.detail, version.fileName].filter(Boolean).join(", ")}
      data-picked={picked || undefined}
      data-state={version.state}
      title={version.fileName}
      draggable
      tabIndex={picked ? 0 : -1}
      onClick={(event) => {
        // A failed version picked again is tried again.
        if (version.state === "failed") void window.settings.choose(`recordingShare:${item.id}`, { action: "open" });
        model.selectShareVersion(version.kind, event.metaKey || event.ctrlKey);
      }}
      onDragStart={(event) => {
        event.preventDefault();
        // The panel's drag, not the card's under it (which would give the card's Video).
        event.stopPropagation();
        // A selected file takes the whole selection with it; another goes alone.
        const kinds = model.sharing?.selected.includes(version.kind) ? model.sharing.selected : [version.kind];
        void model.shareAction(item.id, "drag", kinds);
      }}
    >
      <span className="share-icon" data-kind={version.kind} data-state={version.state}
        style={version.state === "preparing" ? { ["--share-progress" as string]: `${Math.round((version.progress ?? 0) * 100)}%` } : undefined}>
        {version.kind === "sources" ? <FolderGlyph /> : <DocumentGlyph kind={version.kind} extension={extension} />}
        {version.state === "preparing" ? (
          <span className="share-mark share-mark-progress" role="img" aria-label={`${share.labels.preparing} ${Math.round((version.progress ?? 0) * 100)}%`} />
        ) : version.state === "failed" ? (
          <span className="share-mark share-mark-failed" title={share.labels.failed}>!</span>
        ) : version.recommended ? (
          <span className="share-mark share-mark-recommended" title={share.labels.recommended}><Check strokeWidth={3} /></span>
        ) : version.kind === "original" ? (
          <span className="share-mark share-mark-warning" title={version.note}><AlertTriangle strokeWidth={2.5} /></span>
        ) : null}
      </span>
      <span className="share-name">{version.label}</span>
      <span className="share-detail">{version.detail}</span>
    </button>
  );
}

/**
 * The bar: the file selected (or how many), what it holds or how far it is, and Copy and Save to…, which wait for a
 * version still being prepared. What the last action did is said here, and read out.
 */
function PickedBar({ item, share, selected }: { item: LibraryItemView; share: ShareView; selected: ShareVersionView[] }): ReactNode {
  const one = selected.length === 1 ? selected[0]! : undefined;
  const preparing = selected.find((version) => version.state === "preparing");
  const failed = selected.find((version) => version.state === "failed");
  const status = model.sharing?.status;
  const note = status ?? (failed ? share.labels.failedNote
    : preparing ? share.labels.preparingNote.replace("{percent}", String(Math.round((preparing.progress ?? 0) * 100)))
      : one?.note ?? share.labels.drag);
  const warning = !status && !failed && !preparing && one?.kind === "original";
  const busy = model.sharing?.busy === true;
  return (
    <>
      <span className="share-picked">
        <span className="share-picked-name" title={one?.fileName}>{one ? one.fileName : share.labels.selected.replace("{count}", String(selected.length))}</span>
        <span className={warning ? "share-picked-note share-picked-warning" : "share-picked-note"} aria-live="polite">{note}</span>
      </span>
      <Button variant="outline" size="sm" id={`share-${item.id}-copy`} disabled={busy || Boolean(failed)} onClick={() => void model.shareAction(item.id, "copy")}>
        <Copy />{share.labels.copy}
      </Button>
      <Button variant="outline" size="sm" id={`share-${item.id}-save`} disabled={busy || Boolean(failed)} onClick={() => void model.shareAction(item.id, "save")}>
        <Download />{share.labels.saveTo}
      </Button>
    </>
  );
}

/** A page, the version's sign on it and its format at its foot; its top right corner is the marks' place. */
function DocumentGlyph({ kind, extension }: { kind: ShareVersionView["kind"]; extension: string | undefined }) {
  return (
    <svg viewBox="0 0 40 48" className="share-doc" aria-hidden="true">
      <rect className="share-doc-page" x="3.5" y="1.5" width="33" height="45" rx="5" />
      <g className="share-doc-sign">
        {kind === "sound" ? (
          <path d="M13 22v6M17 18v14M21 20v10M25 23v4M29 21v8" />
        ) : kind === "screenOnly" ? (
          <><rect x="11" y="17" width="18" height="12" rx="2" /><path d="M17 33h6M20 29v4" /></>
        ) : (
          <path className="share-doc-play" d="M16.5 18.5v11l9-5.5Z" />
        )}
      </g>
      {extension && <text className="share-doc-extension" x="20" y="41.5" textAnchor="middle">{extension}</text>}
    </svg>
  );
}

function FolderGlyph() {
  return (
    <svg viewBox="0 0 48 40" className="share-folder" aria-hidden="true">
      <path className="share-folder-back" d="M4 8a3.5 3.5 0 0 1 3.5-3.5h11l4 4.5h18A3.5 3.5 0 0 1 44 12.5V33a3.5 3.5 0 0 1-3.5 3.5h-33A3.5 3.5 0 0 1 4 33Z" />
      <path className="share-folder-front" d="M4 15.5A3.5 3.5 0 0 1 7.5 12h33a3.5 3.5 0 0 1 3.5 3.5V33a3.5 3.5 0 0 1-3.5 3.5h-33A3.5 3.5 0 0 1 4 33Z" />
    </svg>
  );
}
