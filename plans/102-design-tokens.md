# 102 — One scale of design tokens for every page

[English](102-design-tokens.md) | [繁體中文](102-design-tokens.zh-TW.md)

Status: in progress; steps 1 (the Recordings tab, the pilot), 2 (the shared preference layout: General and Recording settings) 3 (the Recording Studio and Keyboard Shortcuts) 4 (Troubleshooting and the onboarding guide) 5 (the shared chrome) and 6 (the edit view and player) done on 2026-10-31. Created: 2026-10-31 at the maintainer's request: "use shadcn as the base for the whole CSS, avoid Tailwind's defaults and hard-coded pixels, keep everything consistent, and show before and after pictures of every change." Hard dependencies: none open. It builds on the closed 067 (the type scale, targets and contrast) and 069 (the style layers and `tests/style-guard.test.ts`). Execute in order under the [plan index](README.md).

## The problem today

Colours are tokens everywhere (069's style guard refuses a literal colour), but sizes are not:

- `src/renderer/ui.css` holds 763 lines with a pixel value: margins, paddings and gaps in 32 different values (1, 2, 3, 4, 5, 5.5, 6, 7, 8, 8.5, 9, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 40, 44, 46, 56, 64, 72), font sizes in 11 (7.5 to 30), radii in 6 written beside `--radius-*`.
- The pages' TSX holds 92 Tailwind arbitrary values with pixels (`text-[13px]`, `gap-[6px]`, `min-w-[196px]`, `rounded-[14px]`, …).
- The same role has different values on different pages: a heading above a list is 14/10, 18/12, 20/16 or 12/4 px; the space between sections 22, 28 or 44 px; a row's padding 12 or 14 px. The design note says page titles are 24px; the CSS draws 26px.

## What shadcn and Tailwind provide

- Tailwind v4 has one spacing variable, `--spacing` (4px); `p-3`, `gap-6` and CSS's `--spacing(3)` are multiples of it, half steps included. Its type scale (`text-xs` … `text-2xl`) and radii are theme variables an app may redefine.
- shadcn/ui defines colour tokens and one `--radius` with `--radius-sm/md/lg/xl` derived from it; its components use Tailwind's spacing and type names, at web density (36px controls, 14px text).
- RecordStuff keeps macOS density (the maintainer's choice, 2026-10-31): 067 redefined `text-xs` as 13px; controls are 28px high.

## Design

- **Spacing:** `--spacing(n)` in CSS and Tailwind's numeric names in TSX, on the steps 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12 (2–48px). Values off the scale move to the nearest step.
- **Type:** `--text-3xs` 11px (densest captions only), `--text-2xs` 12px (help, metadata, counts), `--text-xs` 13px (body and controls, 067), Tailwind's `--text-sm`/`base`/`lg` where used, and `--text-title` for page titles, set to the 24px the design note gives (today 26px; step 2 shows both).
- **Radii:** `--radius-xs` (radius − 6px) beside shadcn's `sm`/`md`/`lg`/`xl`.
- **Roles, one value each:** a heading above a list `--spacing(5)` above and `--spacing(3)` under; sections `--spacing(6)` apart; a row's padding `--spacing(3)`; a card grid `--spacing(6)` by `--spacing(5)`.
- **Kept as pixels, by design:** 1px hairlines, focus-ring and scrubber geometry, layout breakpoints and container-query widths (a container query cannot read a variable), size floors such as the 272px card, the timeline's geometry that `editor-geometry.ts` tests, and the countdown overlay's own stylesheet (069).

## Steps

Each step: before pictures, the change, after pictures paired with `pnpm preview:ui`'s `shots.json` or the pilot's side-by-side diff (changed regions boxed), the affected `pnpm test:scope` scopes, a Codex GPT-6.1 Sol review, then a commit of its own. The pictures go to the maintainer with the step's report.

1. **Recordings tab (pilot) — done 2026-10-31.** The tokens above; the tab's CSS and TSX on them. Shared `.day-heading` and `.result-day` brought Troubleshooting's day spacing along.
2. **General and Recording settings — done 2026-10-31.** The shared preference layout (page head, title, sections, section headings 20/12 like the Recordings tab, rows 52px with 12px padding, controls, the about block, the cleanup section, the status card, hints); `--text-title` is the 30px the page head draws (the design note's 24px was stale; step 7 updates it). Being shared, it reached every preference page and the Recordings head (2px lower).
3. **Recording Studio and Keyboard Shortcuts — done 2026-10-31.** The Studio's stage, toolbar and control tokens (same pixels: 32px controls, 28px sources), sources, pickers, number fields, inputs, live controls, stage notes and the camera preview's status pill; the shortcut rows' notes, capture help and capture area. Snaps: 5px paddings and gaps to 4px, a picker's choice to shadcn's 6 by 8, the live controls' top padding 14 to 12 (the Studio's own gap). Kept: the stage floor, the live controls' 340px cap, the meter's segments, the listening indicator's glyph, 1px nudges. Only the Studio's pictures moved (the live controls 2px up); the shared notes kept their pixels.
4. **Troubleshooting** (rows, guidance, actions, details) and the onboarding guide — **done 2026-10-31.** Their CSS and TSX on the tokens; snaps: a diagnostic's 9px to 8, a row heading's 7px gap to 8, a day's 18px foot to 20, the outcome badge's 3px corner to `rounded-xs` and the empty state's icon to the Recordings tab's `size-10`; the unread dot's offset and size kept. Done with a script that rewrites only pure pixel lists of spacing, size, type and radius in the step's rules, every change read before it was applied.
5. **Shared chrome:** sidebar, page head, dialogs, menus, toasts, the zoom notice, tooltips; the shadcn primitives' arbitrary values moved into variants — **done 2026-10-31.** Every remaining settings rule outside the edit view, player and Share… (with the leftovers of earlier pages: Test camera and microphone, the display arrangement, the Studio's record and view controls, the meters); the primitives in exact quarter steps so their geometry holds (tabs `p-0.75`, the switch `h-4.5 w-7.5`, a toggle `h-6.5`, the media button `size-9.5`); the dialog title 15px to `text-base`, the camera preview's 14px padding to 12. Kept as pixels: the sidebar tab's selected bar, notice dots, popover arrows, a card's focus offset, the macOS brand's 30px top beside the traffic lights, the slider's 3px track and 13px media thumb, the tab indicator's 3px, the tooltip arrow's 2px corner, and the 7px and 14px nested radii; `calc()` expressions and custom properties keep theirs.
6. **Edit view and player:** spacing and type only; timeline geometry stays — **done 2026-10-31.** The edit view's panels, actions, options and copies, Share…'s panel and files, the frame peek, and the player's chrome in the dialog and full screen; snaps: the edit panel's 14px sides to 12, the options' 14px to 12, the player's 14/18px edges to 12/20 and full screen's 26/28px to 24, the player's 15px title and seek label to `text-base` and full screen's 22px title to `text-2xl`, the edit and player dialogs' 14px corner to `rounded-xl`. Kept: the timeline's ruler, playhead, trimmer, split mark, progress and camera handles, the scrubber, Share…'s drawn files and marks, the player's seek arrows and spinner.
7. **Guard:** extend `tests/style-guard.test.ts` to refuse a new pixel margin, padding, gap, font size or radius in `ui.css` outside the kept list, and a Tailwind arbitrary pixel value in TSX, as it refuses a colour; update the design note (desktop.md, type scale) and close the plan.

## Verification

Background suite per step (`pnpm test:scope` for the touched tabs, `layout` for shared chrome), `pnpm preview:ui` pairs for every page in both languages and themes at the default, narrow and minimum sizes. A desktop round only at step 7, to look at the real window once on the M1 Pro; the background suite draws the same pages offscreen.

## Risks

- Snapping moves things by 2–4px; a page can get a line longer or shorter. Each step's pictures show it before it is committed.
- A shared rule changed for one page changes others (as `.day-heading` did in step 1); each step lists the pages a shared rule reaches.
