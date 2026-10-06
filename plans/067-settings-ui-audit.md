# 067 — Audit and improve the complete Settings UI

[English](067-settings-ui-audit.md) | [繁體中文](067-settings-ui-audit.zh-TW.md)

Created: 2026-10-06. Status: planned; implementation and fresh screenshot acceptance have not started. Source: the maintainer requested a comprehensive assessment of Settings presentation and usability, including typography, spacing and layout, followed by screenshot-led improvements with as much agent automation as possible. This document is the executable plan; its creation does not claim the redesign is complete.

Execute after [066](066-playwright-background-testing.md) closes, following [the plan index](README.md). This is a queue dependency: reuse the resulting background fixtures, but do not mix acceptance migration into the redesign. Select checks using the testing policy in force at execution; the commands below describe the inspected policy, not a waiver of later requirements.

## Outcome and scope

Audit every part of the Settings window, including Recordings, Recording settings, General, Failures, navigation, status, footer, explanations, menus, rename, embedded playback, dialogs and transient feedback. Improve confirmed problems in readability, visual hierarchy, discoverability, interaction, responsive layout and accessibility. Keep the current React/Base UI/shadcn system and its state/persistence contracts. Do not add features, replace the UI framework or introduce a new visual style solely for novelty.

The agent owns inventory, screenshots, measurements, diagnosis, implementation, before/after review, selected checks and final reporting. Routine reversible UI choices and fixes can proceed under the original request. Ask only for a real unresolved product decision or an unavailable prerequisite; desktop readiness is a separate, required handoff. Do not commit, push, open a PR, publish, change TCC or manufacture signing credentials.

## Starting evidence and files

The working tree inspected on 2026-10-06 already contains extensive React/shadcn, player, settings, testing and documentation edits. Preserve them. Record HEAD, working-tree diff and untracked runtime inputs at execution; HEAD alone cannot identify this baseline. Existing pictures under `docs/verification/measurements/2026-10-05T15-14-43-988Z-ui-preview/` illustrate the earlier default/narrow layout, not verified current pixels. Four pictures were inspected during planning: Recording settings in Traditional Chinese/light/default, General in Traditional Chinese/dark/default, Recording settings in English/light/narrow, and the Traditional Chinese/light Recordings list. Their styles differ from current sources; do not use them as final evidence or a fresh before baseline.

| Area | Current entry points | Questions to resolve with fresh evidence |
| --- | --- | --- |
| Shell and preferences | `src/renderer/settings/settings-app.tsx`, `settings-controller.ts`, `src/main/settings/settings-model.ts`, `src/shared/settings-panel.ts` | Grouping, page names, selected tab, setting/value relationships, immediate save, errors, focus and recording locks |
| Typography and layout | `src/renderer/ui.css`, `src/renderer/components/ui/` | Root font is 13px; rem-based `text-xs` and control dimensions may become much smaller. Measure computed pixels before deciding. Check 600px navigation and 420px row breakpoints, alignment and long text |
| Window and zoom | `src/main/settings/settings-window-state.ts`, `settings-window.ts`, `src/shared/window-controls.ts`, `src/renderer/settings/zoom-toast.tsx` | Default 960×640, minimum 380×360, saved size/zoom, titlebar clearance, zoom feedback and reachability |
| Library and player | `settings-app.tsx`, `player.tsx`, `player-state.ts`, `video-app.tsx` | Grid/list density, long names, menu discovery, rename/trash/undo, overlays and embedded/full-screen consistency |
| Copy | `src/shared/i18n.ts` | English/Traditional Chinese clarity, placeholders, truncation and icon-only accessible names |
| Automation | `scripts/preview-ui.mts`, `scripts/fixtures/ui-preview.ts`, `tests/ui/`, settings/player/native runners | Reuse production pages/preloads and isolated demonstration data; inventory actual scenario coverage and missing states |

## 1. Establish identity and the screenshot baseline

- [ ] Confirm 066's closure and read its resulting commands, fixtures and evidence boundaries. Re-read the testing policy and native acceptance skill before native rounds. Recheck concurrent work and edit only owned, relevant changes; do not reset, stash, revert or delete someone else's edits.
- [ ] Create a unique local evidence directory under `docs/verification/measurements/<timestamp>-settings-ui-audit/`. Store a source/dependency/configuration identity, selected task-local test recipe, environment, artifact paths, scenario manifest, audit report and screenshots. Keep large/raw evidence local; put durable conclusions in tracked design/verification documents at closure.
- [ ] If any desktop round will be needed, start `caffeinate -d -i -t 5400` in the background before the first implementation edit, retain its PID, and stop that owned process after cleanup or early termination. It never unlocks a session. Planning-only work does not start it.
- [ ] Build the current baseline once with `pnpm build` if no valid same-task baseline artifact exists; run `pnpm preview:ui -- --out <unique-before-directory>` serially against that build. This gallery is offscreen and muted; no desktop handoff is needed. The later final revision needs its own selected composite check.
- [ ] Inspect every baseline picture as a local image, at readable resolution. Contact sheets aid coverage but do not replace full-resolution reading of small text. Check cleanup and list missing/failed scenarios. Do not treat gallery generation as visual approval.

Output: a complete screenshot manifest and an auditable baseline tied to the actual working tree.

## 2. Complete the audit matrix and prioritize findings

Use the existing preview matrix first; extend shared scenario preparation or Playwright only where coverage is missing. Planned additions below are not current CLI flags. Keep data synthetic and preferences isolated; do not delete or rename the maintainer's recordings.

| Dimension | Required coverage |
| --- | --- |
| Pages | All four tabs, top and bottom of every scrollable section; every preference/control; window shell/status/footer |
| Language and appearance | English and Traditional Chinese × light and dark; exercise System appearance and its selected state; cross the full four-tab baseline with both languages/themes |
| Size | Default 960×640, narrow 440×760, minimum 380×360; probe 599/600/601px and 419/420/421px at a fixed height for breakpoint regressions; one larger window for excessive empty space |
| Zoom | 100%, 125%, 150%, 200% on representative dense Recording/General pages in both languages; minimum size and enlarged default window. Use the app's zoom path, record applied zoom and logical viewport, and verify every action remains reachable |
| Window/controls | Active/inactive, idle/disabled/saving, hover/focus/selected, success/error/retry; popovers and menus near viewport edges; keyboard-only paths |
| Library | Empty, loading, load failure/retry, grid/list, many clips, missing thumbnail, long English/Chinese names, rename valid/invalid/pending, trash/undo and undo expiry |
| Settings and status | Idle, starting, recording, saving, missing permission, save failure, invalid file-name template, long folder path, shortcut listening/conflict/timeout/retry, update pending/error and local-data confirmation |
| Failures and overlays | Empty/populated, unread/acknowledged, multiple expanded rows, recovery actions/technical details; help popover, rename dialog, toast and zoom notice; embedded player playing/paused, menus/sliders and full-screen handoff if affected |

Cross all four tabs with both languages/themes and default/narrow/minimum sizes (48 baseline frames), then cover other states using representative combinations chosen for the risk they expose. Record the case for every setting and every transient UI; add combinations when a shared change could affect them. Capture scrolled bottom content separately. Do not multiply every state by every dimension without a question to answer.

For each finding record: ID, page/state/language/theme/size/zoom, screenshot and source location, measured issue, user impact, severity, proposed fix, verification case and final disposition. Use P0 for inaccessible/data-risk actions, P1 for unusable/clipped/unreadable controls or broken interactions, P2 for recurring hierarchy/discoverability/spacing problems, and P3 for cosmetic polish. Mark each item confirmed, candidate or accepted tradeoff. A complete audit may find a page already satisfactory; state the evidence and retain it.

Evaluate these subjects on every applicable surface:

1. Information architecture: grouping/order, clear labels, current location, relationship between setting and current value, primary/secondary/destructive actions and redundant controls.
2. Typography: computed font size/line height/weight, Chinese glyph clarity, short labels versus long explanations, numeric alignment, root/rem interactions, truncation and zoom. Record actual computed styles rather than assuming Tailwind token names equal pixel values.
3. Layout: spacing rhythm, row alignment, control widths, card padding, section separation, sidebar density, useful content width, scroll affordance, reachability, titlebar exclusion and footer placement.
4. Interaction: tab discovery in narrow mode, help discoverability, immediate-save feedback, pending/disabled explanations, keyboard navigation, focus return, retry and undo; no action available only on pointer hover.
5. Appearance/accessibility: contrast in both themes, meaningful selected/disabled/error states, visible focus, accessible names and descriptions, reduced motion, forced colors and optional screen-reader observations. Do not claim VoiceOver acceptance from DOM attributes.

Output: an issue ledger covering the entire UI, with evidence-backed priorities and a per-page verdict. No global claim that the UI is good or bad before this stage.

## 3. Set shared design rules and implement confirmed improvements

The following are initial product targets, to validate against the baseline and native desktop density; font/spacing numbers are design choices, not WCAG requirements:

| Subject | Initial target and acceptance rule |
| --- | --- |
| Type scale | Main labels/values about 13–14 CSS px, help/metadata at least 12px, page title about 22–24px; line height around 1.4–1.5 for prose. Essential text below 12px needs a documented exception; measure final computed sizes, including rem utilities |
| Spacing | A small common scale based on 4/8px steps; related controls closer than separate sections; consistent card/row padding. Longer content can grow vertically |
| Controls | Main control height about 28–32px; inspect actual hit rectangles. Target small icon controls at least 24×24 CSS px, or document the applicable spacing/equivalent-control exception; enlarge hit area without requiring a huge glyph |
| Contrast | Normal meaningful text ≥4.5:1; large text ≥3:1; necessary control/state graphics ≥3:1 against adjacent colors. Measure computed/composited colors; decorative and disabled cases have their own exceptions |
| Responsive layout | No unintended outer horizontal overflow, overlapping labels/controls or unreachable actions. Wrap long paths/help; intentional filename ellipsis must offer a way to obtain the full name. At 200% zoom use scrolling/reflow without hiding essential actions |
| Navigation and state | Current tab identifiable beyond color; other tabs understandable with mouse and keyboard in narrow mode; error/pending/disabled information discoverable; immediate changes acknowledged without stealing focus |

The contrast and hit-target references are W3C's [text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) and [target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html). Use these as selected accessibility checks, not a claim of complete WCAG conformance.

- [ ] Resolve P0/P1 before density/polish, then P2 and justified P3. Each confirmed item receives a fix or an explicit reason for deferral; unresolved required items prevent unconditional completion.
- [ ] Fix shared type/spacing/control tokens first, then shell/navigation/responsiveness, then individual pages, menus/dialogs/help and feedback. Reuse existing primitives and variants. Scope changes when only Settings needs them.
- [ ] Preserve committed-value behavior, focus ownership, shortcut capture, locking and IPC contracts. If changing semantics is needed for a confirmed UX defect, update the controller/model and add meaningful regression coverage rather than masking it with CSS.
- [ ] Update both translations for copy changes and retain placeholders. Add explanations where they help a user decide; avoid technical implementation copy in product flows.
- [ ] Follow callers of shared `ui.css` and primitives into countdown, embedded player and full-screen video. A root/rem/token change can affect them even if no player file changes. Include their screenshots and required behavior checks where affected.
- [ ] Use focused checks during edits only to answer specific questions. Generate targeted candidate screenshots for unresolved design choices; the agent inspects and iterates without routine user approvals.

Output: implemented fixes tied to ledger IDs and a final design-token/interaction rationale.

## 4. Automate before/after review and regression checks

- [ ] Reuse production renderer/preload, existing offscreen preview and the Playwright fixtures resulting from 066. Add small shared scenario helpers instead of a second app mock or a new testing framework. Keep native OS proof in native runners.
- [ ] Make scenarios reproducible: fixed fixture times, long names/paths, library content, window dimensions and state; mute playback; wait for readiness, loaded fonts/images and stable layout. Use fresh isolated profile/output directories and retain cleanup outcomes.
- [ ] Where necessary extend the preview manifest with tab/state/language/theme/size/zoom, applied pixel dimensions and source/artifact identity. Add a separate small measurement artifact for computed fonts, bounding boxes, overflow, hit targets and selected contrast pairs.
- [ ] Add Playwright assertions for concrete defects: clipped controls, horizontal overflow, inaccessible lower content, popover/menu collision, keyboard-reachable actions, focus restoration, zoom and long text. Avoid tests that merely freeze arbitrary spacing values or mirror implementation.
- [ ] Generate the same complete matrix after final edits; pair every before/after case by manifest, not filename guesses. Create a local HTML comparison gallery and issue-linked report using actual unaltered application PNGs. Do not use image generation/editing to fabricate improved UI evidence.
- [ ] Agent-inspect every final baseline frame and the transient/edge cases; confirm intended fixes and check adjacent pages for regressions. Pixel differences can identify changes, but cannot establish usability. If snapshot assertions are introduced, review images before updating their baselines; isolate OS/font-dependent expectations.

Output: real before/after PNGs, comparison gallery, measurements, regression assertions and a completed issue ledger. Shell automation captures/measures/asserts; the agent supplies visual judgment. Do not claim an unattended CLI makes subjective design decisions or fixes its own code.

## 5. Select the final verification recipe and run it once

Write the actual recipe in task-local notes after classifying the final diff and callers under [the testing policy](../docs/testing.md). Combine applicable rows, including tests/scripts and shared renderer impacts. Reuse only evidence whose inputs, artifact, environment and case remain valid inside this task.

| Impact | Required recipe on the inspected policy | Conditions/exclusions |
| --- | --- | --- |
| Planning documents only | Relative links/anchors, package command names, bilingual consistency and `git diff --check` | No app launch/build/recording or caffeinate for this planning turn |
| Settings visual/interaction implementation | `pnpm acceptance:regression`, then `pnpm preview:ui` against the same final `out/`; inspect screenshots; `git diff --check` | Regression includes `pnpm check`, build and Playwright; do not run the same check/build separately. After 066 use its approved current equivalent, preserving all required coverage |
| Shared player/video presentation or interaction, including indirect token impacts | Add `pnpm acceptance:player` against the same final `out/` | FFmpeg clip is synthetic; no screen/system-audio recording is needed merely for visual player changes |
| Window options, `window-controls.ts` or top-left page drawing | Fresh `pnpm start:app`, then `pnpm acceptance:settings-shortcut -- --observe`; inspect `settings-window.png` | Native frame cannot be judged from offscreen screenshots. `--quit` is an existing cleanup option when ending this round; confirm exit and retain cleanup evidence |
| Capture settings/locks or other runtime behavior changes | Add the affected testing-policy rows and one relevant signed-bundle recording smoke if required | A visual depiction of a lock does not test actual recording behavior. Folder/quality persistence, shortcut delivery, timers/CPU and permissions need their actual cases when changed |
| Preview/test-runner changes | Typecheck plus relevant tests and an actual run of the changed path, including affected failure/cleanup paths | Can be covered by the selected composite where it includes them; preserve failure classification and supervision |

Serialize all `out/`/`dist/` builds and runners. Under the inspected policy, regression includes desktop settings/shortcut fixtures: do not launch that composite before readiness. After 066, establish that its replacement is actually background-only before omitting the handoff. Offscreen preview and background Playwright require no handoff.

Before any desktop round, name the exact cases, pointer/keys/focus/screen/audio impact, ask the user to reply “好了”, then stop output and wait. One reply covers the stated uninterrupted round and cleanup. Use the [native acceptance skill](../.agents/skills/native-acceptance/SKILL.md): project runners operate covered actions; Computer Use handles remaining UI and screenshot observations. No improvised AppleScript/IPC substitutes for native input. Locked session, missing permission/tool/signing identity or interference is blocked; do independent work, retain evidence and never call it not applicable.

Every complete app round restores changed preferences, closes test UI, quits the tested app normally and confirms its process/helpers exited; leave it closed. Player and fixture cleanup obey their runners; do not close unrelated apps. Record cleanup even on failure/interruption. Stop the owned caffeinate process when the task ends. Required checks must pass before completion; after a further edit rerun only invalidated checks. Stop once the required scope passes.

Recording/audio matrix, long capture, CPU benchmarking, installation, notification delivery and website checks are excluded for appearance-only changes. Reclassify if dependencies/behavior make them applicable. Screen/system-audio capture, subjective listening, real VoiceOver and Windows hardware remain unverified unless actually exercised; background/fixture passes do not establish them.

## 6. Acceptance, reporting and closure

- [ ] All four pages, every setting and shared/transient surface have a verdict; all required baseline/edge cases have screenshots or an explicit blocker. No silent skipped case.
- [ ] P0/P1 resolved; P2/P3 implemented or explicitly dispositioned with evidence and user impact. No confirmed regression remains. Design measurements and visual observations meet the selected targets or document a justified exception.
- [ ] A reader can pair actual before/after frames, reproduce each fix, identify source/artifact/environment and tell scripted evidence from agent observation and manual evidence.
- [ ] Required checks pass on final inputs; cleanup is evidenced. Report checks/results, scope-based exclusions and required-but-unverified/blockers separately. Include counts of findings fixed/deferred and cases pass/fail/blocked/not run, useful before/after images, per-file purpose and links to evidence. Explain any remaining limit without claiming the entire app or all platforms were verified.
- [ ] Write durable design decisions and closure evidence to the relevant system-design/verification documents and their translations; update both indexes; only then remove this completed plan and its translation under [the completion rule](README.md#completing-a-plan).

When desktop evidence is reported, retain this reminder in the user's language: 「測試期間若有測試步驟以外的人為桌面操作，可能影響焦點、截圖與判讀結果；目前流程不會自動偵測所有干擾。」
