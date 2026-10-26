# Recordings Tab Performance

[English](library-performance.md) | [繁體中文](../zh-TW/system-design/library-performance.md)

Updated: 2026-10-27.

This is a design record for how the Recordings tab stays responsive as the output folder grows: what it does, what it deliberately does not do, and when that should be revisited. What the tab shows and how it behaves is in [desktop features](desktop.md#recordings); the code is [recordings-library.ts](../../src/main/library/recordings-library.ts) in main and [library.tsx](../../src/renderer/settings/tabs/library.tsx), [clip.tsx](../../src/renderer/settings/tabs/library/clip.tsx) and [clip-preview.tsx](../../src/renderer/settings/tabs/clip-preview.tsx) in the page.

## The approach

Every listed recording is a real card in the DOM; the list is not virtualized. The tab stays cheap by keeping the expensive work bounded instead: reading the disk, decoding video and laying out the page. Each part below is limited, cached, deferred or skipped off screen, so its cost follows what is on screen or what changed, not the size of the folder.

The scale this was designed and measured for is tens to hundreds of recordings. The thumbnail measurement uses 240 real videos.

## Where the cost is and what bounds it

### Thumbnails

A thumbnail is a QuickLook read of the video (`nativeImage.createThumbnailFromPath`, [video-thumbnail.ts](../../src/main/library/video-thumbnail.ts)): disk I/O plus a decode, the most expensive thing a card asks for.

| Measure | Effect | Cost accepted |
| --- | --- | --- |
| `<img loading="lazy" decoding="async">` | Only cards near the view ask for a picture; decoding the JPEG does not block the page | A card scrolled to quickly shows its fallback icon for a moment |
| At most four made at once (`THUMBNAILS_AT_ONCE`), the rest waiting **newest asked first** | A fast scroll does not start hundreds of QuickLook reads together; after it, the cards in view are made before those passed on the way | Cards passed on the way get their pictures late |
| Served as `immutable` under an address that names the file's version (`thumb/<id>?v=<version>`) | Switching tabs, scrolling back or reopening the window asks main for nothing; a changed file gets a new address, so a stale picture is never kept | A file changed since it was listed is answered with `no-cache`, so the page asks again |
| Main keeps the 64 most recently shown in memory (`THUMBNAILS_KEPT`, least recently shown dropped first) | A menu bar app that runs for days does not grow with the folder; each JPEG is some tens of kilobytes | A picture dropped from memory and no longer in the page's cache is made again |
| Pictures at 960×540 as JPEG at quality 85 | Sharp in a three-column grid on a Retina display, several times smaller than PNG | Larger than a one-column grid needs |

Four was measured, not guessed (`pnpm measure:thumbnails`, [thumbnails.measure.ts](../../tests/ui/measure/thumbnails.measure.ts), M1 Pro, 2026-10-08): over 240 real videos scrolled to the bottom and back, four made the pictures as fast as no limit, while three left them waiting several times longer. The measurement compares configurations on one machine and is not a budget.

### Hover previews

Playing a recording in a card means a decoder, the most expensive thing on the page while it runs.

- **One preview at a time.** The card the pointer leaves unloads its video, so passing over many cards never holds more than one decoder.
- **A 400 ms rest starts it** (`PREVIEW_DELAY_MS`), so moving across the grid starts none.
- **A window without the focus starts none**, and a preview stops when the window hides or another app takes the focus (2026-10-15, after a preview left looping behind another app took about 30% of a core).
- **The seek bar's frame picture is a second video, loaded only while the pointer is on the bar's strip.**
- **List rows and reduced motion never preview.**

Cost accepted: two cards cannot preview side by side, which the tab does not need.

### Lengths

A recording's length is read from its MP4 boxes, not by decoding. The capture host writes fragmented MP4, so the length is the last complete fragment's `tfdt` plus its sample durations, and only box headers are read on the way.

- **The listing is shown first**, and unknown lengths are read afterwards, **one file at a time**.
- Lengths are **published at most every 500 ms** (`LENGTHS_PUBLISH_MS`) and once at the end. Until 2026-10-04 they were published only once every file was read, which left a folder of long recordings without lengths for a long time.
- Lengths are cached per file version, so a later listing reads only new or changed files. A rename or a move keeps them.
- **Closing or hiding the window stops the reads** before the next file (2026-10-08). Before that, a large folder kept being parsed after the window was gone, even while the next recording was being written.

Cost accepted: lengths fill in over the first moments in a large folder, and each publication recomputes the page's list and its grouping by day. The cards themselves do not render again (see below).

### Listing and watching

- **One listing reads the folder at a time**, and requests made in the meantime share one listing after it. For example, opening Settings asks once for the show and once for the focus.
- The folder is **watched only while the window is open** (`fs.watch`, FSEvents on macOS, event-driven, never polled). A burst of events is listed once, 250 ms after it settles (`WATCH_SETTLE_MS`). A hidden or closed window watches nothing and runs no timer.

### Rendering the page

| Measure | Effect | Cost accepted |
| --- | --- | --- |
| `Clip` is `memo`, compared **field by field** | IPC clones the whole view on every update (a saved layout preference, a length published), so a reference comparison would render every card again; only cards whose values changed render | The comparison is a loop over each card's fields on every update |
| `content-visibility: auto` on each day (`.library-day`, [ui.css](../../src/renderer/ui.css)) with `contain-intrinsic-size: auto 500px` | A day out of view skips style, layout and paint, so resizing the window (a title-bar double-click animates through dozens of widths) lays out only the visible days | It saves no React work and no DOM nodes. A day is the unit, so one day holding hundreds of recordings is laid out whole while any of it is in view. A day never shown is guessed at 500 px until it has rendered once, so the scrollbar can shift on the first pass |
| `overflow-clip-margin: 8px` on the same element | The paint containment that `content-visibility` brings does not cut the cards' state outlines, drawn 5 px outside each card | — |
| Search filters a deferred copy of the query (`useDeferredValue`) | The field answers every key at once, and the list follows in an interruptible background render, with no fixed delay as a debounce would add | The list briefly lags the field. A search the app clears itself (an entry bringing a recording) uses the live value (`queryNow`) so the card it focuses exists, at the price of one synchronous render |

## What is deliberately not done

### List virtualization

Rendering only the cards in view, for example with `@tanstack/react-virtual`, would make the page's cost follow the window instead of the folder. It is not done because, at the scale above, what it would save has not been shown to matter, and what it would cost is certain:

- **Behaviour that relies on every card being in the DOM.** ⌘F finds a card by name. Tab moves through every card. Assistive technology reads the whole list. An entry from a notification or Show last recording focuses and scrolls to a card directly. When a card goes to the Trash, focus moves to its neighbour. With virtualization, each of these would need its own handling and its own tests.
- **A grouped grid is the hard case.** Rows depend on the window's width (one to three cards a row), days have headings, and the hover preview, the open menu and focus all live on a card that could be unmounted under them.
- **`content-visibility` already removes the cost most visible at this scale** (layout while resizing) with one CSS rule and no change to the components.

What this leaves unbounded, and has not been measured:

- **Mounting every card** the first time the tab is shown and when the category changes.
- **The list diff** on each length publication.

Both grow with the number of recordings.

### Smaller refinements not taken

- **Lower-cased titles computed ahead of the search.** Matching titles is not where the time goes, and the saving was too small to measure.
- **Debouncing the search.** The list is filtered in memory with no I/O per key, so a debounce would only add a fixed delay and still block when its timer fires. `useDeferredValue` fits this case better (see [the learning note](../learning/deferred-search-in-react.html)).

## When to revisit

Reconsider virtualization when **both** hold:

1. Libraries of **a thousand or more recordings** occur in real use, or a single day commonly holds hundreds.
2. A **measurement** shows a visible stall: opening the tab, switching category, clearing the search or scrolling, with long tasks over one frame in a trace.

Before full virtualization, try the cheaper step first: split a day into fixed-size blocks (for example 30 cards), each with its own `content-visibility: auto`, so a crowded day is no longer laid out whole. Neither change is needed while both conditions are unmet.

Lowering `THUMBNAILS_AT_ONCE`, `THUMBNAILS_KEPT` or the publication interval should be measured with `pnpm measure:thumbnails` (thumbnails) or a large real folder (lengths), as the current values were.
