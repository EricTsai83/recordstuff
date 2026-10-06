# Plan 066 — Background Playwright migration ledger

[English](playwright-migration-066.md) | [繁體中文](../zh-TW/verification/playwright-migration-066.md)

Every assertion of the desktop runners that plan 066 moved to the background suite, with its stable ID, its destination and the evidence it now gives. The [background UI suite](../system-design/tooling.md#background-ui-suite) describes the hosts and the boundary; the [closure record](history-2026-10.md#plan-066-closure--2026-10-06) holds the final results.

## Starting point

- Revision `b9271c9c573350e9bbb7da9b333a8ff24b9ac505`, working tree clean: the React/shadcn and offscreen Playwright work the plan was written against had been committed as `3e0f58e3` and `c634a2eb` the same day. Electron 44.3.0, Playwright 1.63.0, Node 24.21.0, macOS 26 (Darwin 25.6.0) arm64.
- Former command graph: `acceptance:regression` = `check` → `test:ui` (13 component tests, no desktop) → `acceptance:settings` (516 cases, a desktop round) → the shortcut fixture's normal, restart and settings phases (57 cases, a desktop round). `acceptance:player` (19 cases) was a separate desktop round.
- Timing reused, not re-measured (same machine and day, revision `bcf744af`, before the module regrouping): recipe `settings` 182.26 s, of which `test:ui` 23.52 s, the settings fixture 88.59 s and the shortcut fixture 39.36 s held the desktop (`2026-10-06T05-27-52-850Z-recipe-settings`). The case names below come from that round's `results.json`/`summary.json` and from the player round `2026-10-06T05-31-01-485Z-player-acceptance` (17/19; its two failures were the fixture races fixed before the regrouping).

## Evidence kinds

| Kind | Meaning |
| --- | --- |
| BG-page | Background suite: Playwright input (CDP) on the production page and preload in a hidden offscreen window; the page's DOM focus, rendering and geometry |
| BG-IPC | Background suite: a real IPC round trip to the view host's handlers over the real `settingsView`, `RecordingResults`, `RecordingsLibrary` and media scheme |
| BG-main | Background suite: the production `out/main/index.js` with its storage and window controllers; OS effects are adapter calls (a request production made, not an OS effect) |
| BG-media | Background suite: real decoding of the checked-in clips (tests/ui/media), muted |
| Native | A desktop runner on a shown window: OS window state, focus, frame or full screen on the display |

Input changed kind for every moved case: the former fixtures sent Electron `sendInputEvent` events to an active window; the background suite sends Playwright input to a hidden window whose document keeps focus. Keys main intercepts before the page are sent with `sendInputEvent` there too. A former case gated on OS activation (plan 057) now judges the page's own focus behaviour; OS activation itself is the Native rows.

## Settings (former `pnpm acceptance:settings`, 516 cases)

IDs follow the 115 case groups of the former run, in order; `×n` is the loop expansion (language × theme × size × state). All are BG-page with BG-IPC unless marked.

| IDs | Behaviour | Count | Destination | Disposition |
| --- | --- | --- | --- | --- |
| S001 | The window has the app's frame | 1 | Native: `acceptance:settings-native` N-S001 | Retained native (an offscreen window has no frame) |
| S002–S009 | Shipped CSP and no console errors, compact header, bridge keys, no Node API, URL language, committed values, unavailable option, refused-shortcut note | 8 | settings-panel.spec.ts | Moved; console errors now fail every test at teardown |
| S010–S013 | A change reaches main as ids, re-renders, no failure text; an uncommitted choice reports it | 4 | settings-panel.spec.ts | Moved |
| S014–S015 | Two held saves with an older push; final completion | 2 | settings-panel.spec.ts | Moved |
| S016–S021 | Notification card: one card, pane button ids, switch off, held saves ×2 (on, off) preserving control/focus/scroll, restrictions dim | 8 | settings-panel.spec.ts | Moved |
| S022 | The library reads names, dates, sizes and lengths | 1 | settings-panel.spec.ts | Moved |
| S023 | No horizontal or outer-page overflow | 120 (2×2×3×10) | settings-matrix.spec.ts | Moved |
| S024 | Nothing clickable under the window controls | 120 | settings-matrix.spec.ts | Moved |
| S025 | Status card speaks only when needed; Quit alone in the sidebar foot | 24 | settings-matrix.spec.ts | Moved |
| S026 | First Tab from the top reaches the tabs | 4 | settings-matrix.spec.ts | Moved |
| S027, S035, S036 | Recordings by day; empty folder; unreadable folder | 12 each | settings-matrix.spec.ts | Moved |
| S028 | Thumbnails over `recordstuff-media:`, one fallback | 4 | settings-matrix.spec.ts | Moved; the fallback's expected 404 is declared |
| S029–S031 | Player over Recordings for an unplayable file: named controls, corner, Close | 12 each | settings-matrix.spec.ts | Moved |
| S032–S034 | Card menu: corner, hover lights one item legibly, ⋯ and right-click open it inside, Escape returns focus | 12 each | settings-matrix.spec.ts | Moved (activation-gated before; page focus now) |
| S037–S038 | Countdown sound switch click; disabled under countdown Off | 2 | settings-panel.spec.ts | Moved |
| S039–S041 | Status card: no Start when ready; Change output folder…; Relaunch link | 3 | settings-panel.spec.ts | Moved |
| S042–S043 | ⓘ by hover (above, gap, kept, hidden) and by Tab with Escape | 2 each (en/minimum, zh-TW/default) | settings-panel.spec.ts | Moved |
| S044–S048 | Update checks: repeated states keep nodes; Tab+Enter one check; busy focus ring; next Tab continues | 5 | settings-panel.spec.ts | Moved |
| S049–S052 | Scroll cue | 4 | settings-panel.spec.ts | Moved |
| S053–S057 | Footer wide and narrow; Show log row; failed link Retry and its focus | 5 | settings-panel.spec.ts | Moved |
| S058–S066 | Shortcut editor by keyboard, focus rings, listening, Control+F12, Confirm, Shift+Tab, forced colors, reduced motion | 9 | settings-panel.spec.ts | Moved; media emulation through Playwright instead of the debugger |
| S067–S086 | Failure history: pending, partial ×4, acknowledge, reopen, entry, unread, stale press, persistence ×2, retries ×2, consecutive, removal, empty state | 25 | settings-results.spec.ts | Moved (production `RecordingResults`, controlled store) |
| S087–S088 | Loading status ×2; automatic retry | 3 | settings-results.spec.ts | Moved |
| S089–S093 | 150 ms (en) and 2000 ms (zh-TW) durable saves | 10 | settings-results.spec.ts | Moved |
| S094–S102, S104, S106–S109 | Failures tab: no history elsewhere ×2, tab strip ×2, tab keys, day groups, header keys, independent rows, focus borders, pointer, rollover, Technical details, per-tab scroll, entry, count | 16 | settings-results.spec.ts | Moved |
| S103 | An inactive window shows no focus border and it returns | 1 | Native: N-S103 | Retained native (needs another window in front) |
| S105 | A day rollover while inactive keeps the focused action | 1 | Native: N-S105 | Retained native |
| S110–S115 | Keyboard focus ring of tab, menu, segment, switch, button, row action | 4 each | settings-results.spec.ts | Moved |

Totals: 513 moved to the background, 3 retained native, 0 removed. The former screenshots are kept as pictures in `test-results/ui/`; 36 of them (recording, General and Recordings states) are compared with reviewed macOS 26 baselines.

## Shortcut integration (former `pnpm acceptance:shortcut`, 57 cases)

| IDs | Behaviour | Destination | Evidence | Native counterpart |
| --- | --- | --- | --- | --- |
| K-N01–K-N14 | Normal phase: preview unchanged until Confirm; refused registration saved; note; notification once per request; Off; card explains the Settings shortcut; notification preference; retry; invalid candidate; other preferences; failed selection left; resize persisted | shortcut-integration.spec.ts | BG-main | K-N01–K-N04 also as N-K01–N-K04 with Electron's real registration refused through `setSuspended`, and K-N10 (Retry recovers) as N-K04b with real registration |
| K-R01–K-R04 | Restart: size, failed custom selection, registration retried and rendered, notification requested | shortcut-integration.spec.ts (same test, a second launch on the same data) | BG-main | — |
| K-S01–K-S08 | Dark appearance at startup; legacy key ownership; tray explanation; preview; recovery; three appearances | shortcut-integration.spec.ts | BG-main | — |
| K-S09 | The callback restores a minimized window without duplication | K-S09a: the restore, show and focus production asks for | BG-main | N-K05: a real minimized window restored and focused |
| K-S10–K-S32 | Capture suspension; reserved key; failed registrations in the tray ×2; no retry on refresh; renderer crash and replacement; editor limit, timeout and clearing ×2; Control+W capture and save; held saves across close, reopen and crash | shortcut-integration.spec.ts | BG-main (the held save is a test gate on settings.json's rename) | The close key on a focused window: N-K06 |
| K-S33–K-S38 | Two entry rounds: size survives, the shortcut reuses one window, the close key keeps the app and the tray reopens | shortcut-integration.spec.ts | BG-main (visible/focused are requests) | N-K06–N-K08 on real windows |
| K-S39 | Entry cycles start no capture and change no preference | shortcut-integration.spec.ts | BG-main | N-K08 checks the preferences too |

The runner's `--drill-failure` and `--drill-timeout` stay on `pnpm acceptance:shortcut-native`.

## Player (former `pnpm acceptance:player`, 19 cases)

| IDs | Behaviour | Destination | Evidence | Native counterpart |
| --- | --- | --- | --- | --- |
| P01–P10 | The clip listed with its length; a card plays it; named controls and title; rest and wake; pause; Space/K/→/M; seek drag; volume slider; the corner | player.spec.ts | BG-page, BG-media | — |
| P11 | Full screen with the name, controls and the time handed over, covering the display | player.spec.ts: the window production asks to cover the display (bounds, full-screen request) and its page | BG-main, BG-media | N-P01: a shown window covering the display |
| P12–P13 | Rest and wake in full screen | player.spec.ts | BG-page | — |
| P14 | F leaves and the player carries on | player.spec.ts | BG-media | N-P02: Settings has its focus back |
| P15 | Double-click full screen, Escape leaves with the player open | player.spec.ts | BG-page | N-P03 |
| P16–P18 | Title strip; Close releases the file; 16:9 stage with a portrait clip | player.spec.ts | BG-page, BG-media | — |
| P19 | No console errors | Every test's teardown | — | N-P00 |

The clips are now checked in (480 × 270 and 270 × 480 instead of 1280 × 720 and 720 × 1280); P18 expects the portrait clip's own size. The 1280 × 720 clip's FFmpeg prerequisite is gone from both the background suite and the desktop runner.

## Component checks (former `tests/ui/components.spec.ts` on `fixture.cjs`, 13 tests)

All 13 kept their assertions on the view host's `components` mode; the cleanup helper test now also confirms that the helper's process ended.

## New background coverage

| IDs | Behaviour | Destination |
| --- | --- | --- |
| S116 | The window-drag strip covers no tab at the top of a narrow window (darwin and win32 layouts) | settings-panel.spec.ts; added after the first Windows CI run found the strip over the tabs |
| C01–C06 | Countdown overlay: digits in a hidden, non-activating overlay sized for the display; updates; fade and destruction on dismissal; cancel; the tick flag on load and a replaced page; a muted page | countdown.spec.ts |
| D01–D10 | Cleanup drills: failed launch, assertion failure, timeout, renderer crash, hung main, containment violation, SIGINT; bypasses of the real dialog, notification, activation and unmute; a violation before the app quits itself; a foreign process naming the folder | drills.spec.ts (`pnpm test:ui:drills`) |

## Native counterparts

| ID | Runner | Behaviour |
| --- | --- | --- |
| N-S001, N-S103, N-S105 | `pnpm acceptance:settings-native` | Frame; focus border with another window in front; rollover while it is |
| N-K01–N-K04b | `pnpm acceptance:shortcut-native` (registration) | Preview; real registration refused and saved; note; notification request; Retry registers it for real |
| N-K05–N-K08 | `pnpm acceptance:shortcut-native` (windows) | Real minimize/restore/focus; close key; one visible focused window from the shortcut; tray reopen without preference changes |
| N-P01–N-P03 | `pnpm acceptance:player` | Full screen covers the display; F leaves and focus returns; double-click and Escape |

`pnpm acceptance:recipe -- native-ui` runs the three with one build. Their results are in the [closure record](history-2026-10.md#plan-066-closure--2026-10-06).
