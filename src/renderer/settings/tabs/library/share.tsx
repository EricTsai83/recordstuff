/**
 * Share… (plan 100 step 3, the maintainer's choice of 2026-10-30: the card as a little folder). A recording's versions
 * shown as the files they leave as: each a document with its format and its name, dragged out to give it, or picked
 * for Copy and Save to… in the bar below, which says what the picked file is and what it is for (2026-11-01: the few
 * words under each file read as nothing). The Video is picked as the panel opens. Every icon is grey; the picked ones
 * carry a translucent red check in their corner. Sources is a folder, and More opens as one, named in a breadcrumb.
 *
 * The panel sits in the window's middle over a dimmed page, in either layout (2026-11-01): the card's picture grows and
 * floats there as it opens, turning into the panel, and shrinks back into the card as it closes. The breadcrumb stays
 * at the top and the bar at the foot; only the files between them scroll, with no scroll bar, the app's blurred edges
 * saying there is more.
 *
 * Selecting: a click selects a file, ⌘-click adds it or takes it away; the arrow keys move between files, Space selects,
 * ⌘C or Return copies the selection, Escape closes. Dragging a selected file drags every selected one; dragging another
 * drags it alone. A version still being prepared shows it on its icon,
 * as a ring in its corner (the maintainer's choice of 2026-10-30: one sign of progress, over the corner); Copy and
 * Save to… wait for it, a drag does not start.
 */
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, Copy, Download, X } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { LibraryItemView, ShareVersionView, ShareView } from "../../../../shared/settings-panel";
import { ScrollFades } from "../../../components/scroll-fades";
import { useShownWhile } from "../../../lib/use-shown-while";
import { stopPreview } from "../clip-preview";
import { Button } from "../../../components/ui/button";
import { ControlTooltip } from "../../../components/control-tooltip";
import * as model from "../../settings-controller";

export function ShareOverlay({ item }: { item: LibraryItemView }) {
  const share = item.share;
  const dialog = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // The card's hover preview stops under the panel, once the morph has taken its picture (the panel is drawn in the
    // transition's update): its decoder would otherwise run on, hidden, beside the version being prepared.
    stopPreview();
    // The page under the panel takes no focus while it is open; the backdrop already takes the pointer. Kept here rather
    // than by making the page inert, which every element inherits: toggling it restyled the whole page as the morph
    // began and ended (2026-11-01, some 25 ms with 210 recordings listed).
    const focusables = (): HTMLElement[] => [...(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex]:not([tabindex='-1'])") ?? [])];
    const back = (event: FocusEvent): void => {
      const panel = dialog.current;
      if (panel && event.target instanceof Node && !panel.contains(event.target)) (panel.querySelector<HTMLElement>("[role=option][tabindex='0']") ?? focusables()[0])?.focus({ preventScroll: true });
    };
    const wrap = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") return;
      const all = focusables();
      const first = all[0], last = all.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("focusin", back);
    document.addEventListener("keydown", wrap);
    return () => { document.removeEventListener("focusin", back); document.removeEventListener("keydown", wrap); };
  }, []);
  if (!share) return null;
  // In the window's middle, over a dimmed page, whatever the layout (2026-11-01): opening, the card's picture grows into
  // it (model.openShare's view transition), and closing, it shrinks back.
  return createPortal(
    <>
      <div className="share-backdrop" aria-hidden="true" onPointerDown={(event) => { event.stopPropagation(); model.closeShare(); }} />
      <div
        ref={dialog}
        className="share-panel"
        role="dialog"
        aria-modal="true"
        aria-label={share.heading}
        // Pressed inside, the panel is its own: the card it is drawn from in the React tree neither plays nor drags.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); model.closeShare(); } }}
      >
        <SharePanel item={item} share={share} />
      </div>
    </>,
    document.body,
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
  const scroll = useRef<HTMLDivElement>(null);
  return (
    <div className="share-body" onKeyDown={(event) => onKeys(event, item, shown.map((version) => version.kind))}>
      <div className="share-head">
        {/* Where the panel is, as a breadcrumb: Share, or Share › More with Share the way back. The recording's name is the
            bar's, so it is not said twice. */}
        <nav className="share-crumbs" aria-label={share.heading}>
          {inMore ? (
            <>
              <button type="button" className="share-crumb-link" id={`share-${item.id}-back`} onClick={() => model.toggleShareMore()}>
                {share.labels.share}
              </button>
              <ChevronRight className="share-crumb-separator" aria-hidden="true" />
              <span className="share-title" aria-current="page">{share.labels.more}</span>
            </>
          ) : (
            <span className="share-title" aria-current="page">{share.labels.share}</span>
          )}
        </nav>
        <Button variant="ghost" size="icon-sm" id={`share-${item.id}-close`} aria-label={share.labels.close} onClick={() => model.closeShare()}>
          <X />
        </Button>
      </div>
      <div className="share-scroll-frame">
        <div ref={scroll} className="share-scroll">
          <div className="share-files" role="listbox" aria-multiselectable="true" aria-label={share.heading}>
            {shown.map((version) => (
              <FileItem key={version.kind} item={item} share={share} version={version} picked={selected.includes(version)} />
            ))}
            {!inMore && more.length > 0 && (
              <button type="button" id={`share-${item.id}-more`} className="share-file"
                aria-label={`${share.labels.more}, ${share.labels.moreCount.replace("{count}", String(more.length))}`}
                onClick={() => model.toggleShareMore()}>
                <span className="share-icon"><FolderGlyph /></span>
                <span className="share-name">{share.labels.more}</span>
              </button>
            )}
          </div>
        </div>
        <ScrollFades scrollRef={scroll} contentRevision={inMore} clear={24} topSize={18} bottomSize={22} />
      </div>
      <div className="share-bar">
        {selected.length ? <PickedBar item={item} share={share} selected={selected} /> : <span className="share-hint">{share.labels.drag}</span>}
      </div>
    </div>
  );
}

function FileItem({ item, share, version, picked }: { item: LibraryItemView; share: ShareView; version: ShareVersionView; picked: boolean }) {
  const extension = version.kind === "sources" ? undefined : /\.([^.]+)$/.exec(version.fileName)?.[1]?.toUpperCase();
  const preparing = useShownWhile(version.state === "preparing", { since: version.since, cut: version.state === "failed" });
  // Made while still shown, it stays full for the rest of its time.
  const progress = version.state === "preparing" ? (version.progress ?? 0) : 1;
  // No tooltip of its own (2026-11-01: the system's was the app's only one left): the picked file's name is the bar's,
  // and the app's tooltip, opening on focus, would come up at every arrow and take the panel's Escape.
  return (
    <button
      type="button"
      id={`share-${item.id}-${version.kind}`}
      className="share-file"
      role="option"
      aria-selected={picked}
      aria-label={`${version.label}, ${version.fileName}`}
      data-picked={picked || undefined}
      data-state={version.state}
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
      <span className="share-icon" data-kind={version.kind} data-state={version.state}>
        {version.kind === "sources" ? <FolderGlyph /> : <DocumentGlyph kind={version.kind} extension={extension} />}
        {/* The corner says what the file is to you (picked) or that it could not be made; being prepared is a bar under
            the icon, as Finder draws a file still being copied, so a picked file keeps its check meanwhile. */}
        {version.state === "failed" ? (
          <ControlTooltip label={share.labels.failed}><span className="share-mark share-mark-failed">!</span></ControlTooltip>
        ) : picked ? (
          <span className="share-mark share-mark-picked" aria-hidden="true"><Check strokeWidth={3} /></span>
        ) : null}
        {preparing && (
          <span className="share-progress" role="progressbar" aria-label={share.labels.preparing} aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}>
            <span style={{ transform: `scaleX(${progress})` }} />
          </span>
        )}
      </span>
      <span className="share-name">{version.label}</span>
    </button>
  );
}

/**
 * The bar: the file selected (or how many) beside Copy and Save to…, which wait for a version still being prepared, and
 * under them, across the bar, what the file is or how far it is. What the last action did is said there, and read out.
 */
function PickedBar({ item, share, selected }: { item: LibraryItemView; share: ShareView; selected: ShareVersionView[] }): ReactNode {
  const one = selected.length === 1 ? selected[0]! : undefined;
  const preparing = selected.find((version) => version.state === "preparing");
  const failed = selected.find((version) => version.state === "failed");
  // What a drag that found its files still being prepared said holds until they are ready, or could not be made.
  const waiting = model.sharing?.waiting;
  const settled = waiting !== undefined && waiting.every((kind) => share.versions.find((version) => version.kind === kind)?.state !== "preparing");
  const status = settled ? undefined : model.sharing?.status;
  // That a picked file is being prepared takes the place of what it is while its bar shows, on the same timing; how far
  // it is, is the bar's alone, so the panel does not count twice (2026-11-01, the maintainer's choice).
  const shownPreparing = useShownWhile(Boolean(preparing), { since: preparing?.since, cut: Boolean(failed) });
  const note = status ?? (failed ? share.labels.failedNote : shownPreparing ? share.labels.preparingNote : one ? one.note : share.labels.drag);
  const busy = model.sharing?.busy === true;
  return (
    <>
      <ControlTooltip label={one?.fileName} delay={1000}><span className="share-picked-name">{one ? one.fileName : share.labels.selected.replace("{count}", String(selected.length))}</span></ControlTooltip>
      <span className="share-picked-note" aria-live="polite">{note}</span>
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
