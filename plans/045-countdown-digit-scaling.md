# 045 — Countdown digit scaled to the display

[English](045-countdown-digit-scaling.md) | [繁體中文](045-countdown-digit-scaling.zh-TW.md)

Status: planned, not implemented. Created: 2026-09-27. Queue before [035](035-guided-native-acceptance.md), which stays last. Execution order: see [queue](README.md#order-and-status).

## Purpose and boundary

The countdown digit ([desktop design](../docs/system-design/desktop.md#countdown-overlay)) is the same on every display: SF Pro Rounded 56 pt inside an 88 × 88 pt window. On the maintainer's primary display, a 27-inch 1920 × 1080 panel whose short side is 1080 pt ([040 closure](../docs/verification/history-2026-09.md#plan-040-closure--2026-09-26)), the font size is about 5% of the screen height, and the maintainer reported on 2026-09-27 that the digit is too small and should follow the screen's size. This plan makes the digit's size a fraction of the recorded display, so it reads the same on a laptop, a large external display and a portrait display.

Everything else chosen in 040 stays: the top-right position and its insets, 28% white with no box, background, border, ring or blur, the font and weight, the reduced-motion and reduced-transparency variants, every timing value including the 300 ms lead before capture, the cancel paths, the tray and the settings. No size setting is added to Settings, and the digit does not move to the centre of the screen.

Scaling uses the display's logical size in points, not its physical size: Electron's `Display` exposes points and a scale factor but no physical dimensions, and a screen is usually viewed from a distance that grows with it, so the same fraction of the screen reads similarly on each.

## Scaling rule

Initial targets, to be replaced by the maintainer's choice in the first step below:

- **Reference length:** the shorter side of the recorded display's `bounds`. The work area is not used, because the Dock's position and auto-hide would change the digit's size. The shorter side gives a portrait display the same digit as the same panel in landscape.
- **Font size:** 10% of the reference length, clamped to 56–216 pt. The minimum is today's size, so no display gets a smaller digit; the maximum is reached by a 4K display at 1× (2160 pt) and only bounds unusually large virtual displays.
- **Window:** a square whose side is the font size × 88 / 56, rounded to whole points, keeping 040's digit-to-window ratio so "10" still fits. The page derives the font size from the window, so the rendered size is the window side × 56 / 88.
- **Insets:** unchanged at 16 pt from the right edge and 12 pt below the top of the work area. The transparent margin inside the window grows with it, so the digit moves slightly further from the corner as it grows.
- **Outline and shadows:** proportional to the font size, so at 56 pt they equal 040's values exactly, including the reduced-transparency outline.

| Short side (example) | Font size | Window |
| --- | --- | --- |
| 768 pt (1366 × 768) | 77 pt | 121 pt |
| 982 pt (14-inch MacBook Pro default) | 98 pt | 154 pt |
| 1080 pt (the maintainer's 1920 × 1080 primary and 1080 × 1920 portrait displays) | 108 pt | 170 pt |
| 1440 pt (27-inch 5K default, 2560 × 1440) | 144 pt | 226 pt |
| 2160 pt and above | 216 pt (maximum) | 339 pt |

## Implementation contract

- [ ] **Maintainer choice first.** Before the source changes, show the maintainer the digit at 8, 10, 12 and 14% of the short side (86, 108, 130 and 151 pt on the 1080 pt primary display), drawn at its real position with the real colour, outline and shadows over a dark app, a white document and a bright photo. Static HTML drafts opened full screen on that display are enough; they are not repository artifacts. Record the chosen fraction, and any change to the clamp or insets the maintainer asks for, in this plan before implementing; if the maintainer keeps 10%, say so.
- [ ] **Shared values.** In [shared/countdown.ts](../src/shared/countdown.ts), replace the fixed `sizePt` and `font.sizePt` with the scaling constants (fraction, minimum and maximum font size, digit-to-window ratio), each commented as an initial target or the maintainer's choice, keeping the module free of Electron and DOM imports. `overlayBounds` takes the display's bounds and work area and returns the scaled square at the unchanged insets, in whole points.
- [ ] **Overlay page.** [renderer/countdown.ts](../src/renderer/countdown.ts) and [countdown.css](../src/renderer/countdown.css) size the digit from the window through viewport units (`vmin`) and express the outline widths and shadow offsets and blurs in `em`. The window's bounds become the only carrier of size: the preload, the value channel and the rule that the page only renders what main sends stay unchanged, and no new IPC is added. Custom properties are still set through the CSSOM, which the page's CSP allows.
- [ ] **Overlay window.** [countdown-overlay.ts](../src/main/countdown-overlay.ts) creates the window at the primary display's scaled bounds and, in `show`, sets the recorded display's scaled bounds before the first value is sent, as it sets the position today. The placement log line keeps its format, which [countdown-evidence](../scripts/lib/countdown-evidence.mts) parses, and now reports the scaled size. The window is shown at opacity 0 and fades in over 120 ms, so a resize between displays of different sizes should not show a frame at the old size; if the native check below sees one, fix it in main without giving the page a way to reply. Window options, levels, focus and click-through are unchanged.
- [ ] **Evidence tooling.** `digitRegion` already scales any logged window into the recorded frame; add a scaled window (for example 170 × 170 pt on a 1920 × 1080 display) to its tests. No runner change is expected; if the larger crop exposes a problem in the region or flash-frame logic, fix it there.
- [ ] **Documentation.** Update in both languages: the desktop design's countdown overlay paragraphs (the rule and its examples instead of 88 × 88 pt and 56 pt), the [function reference](../docs/system-design/functions.md) entry for `overlayBounds`, the countdown row in [design decisions](../docs/system-design/decisions.md) (the digit scales with the recorded display) and the countdown row in the [acceptance guide](../docs/acceptance.md) (the digit's size suits each display). The website's copy says "a faint 3, 2, 1", which stays true; compare the hero scene's digit (a 1600 × 900 scene) with the chosen fraction and resize it only if it no longer represents the app.

## Verification and exclusions

- [ ] Unit tests: `overlayBounds` for a landscape display, a portrait display with the same short side (same size, placed at that display's top-right), a small display clamped to the minimum (88 pt, today's window), a large one clamped to the maximum, rounding, and a secondary display with a negative origin. The overlay, through the fake window: creation at the primary display's scaled bounds, `setBounds` with the recorded display's scaled bounds before the first value, and the log line with the scaled size. The page: `overlayStyle` sizes the digit in `vmin` and the outline and shadows in `em`, and at the 88 pt window those resolve to 040's 56 px font, 1 px and 1.5 px outlines and shadow values. The evidence parser and region with a scaled window.
- [ ] `pnpm check`. The settings panel, its text and its IPC are unchanged, so `pnpm acceptance:settings` and `pnpm acceptance:regression` are not required.
- [ ] One `pnpm acceptance -- --skip-cancel` round on a fresh `pnpm start:app` bundle with the default 3 seconds: the log places a window of the expected size for the recorded display, the file passes media verification, and the crops of the now larger digit region from the first 15 frames match the frames of the same flash phase 2 seconds later within the threshold of 3, so the bigger digit still never appears in the recording. The cancel case is skipped because no cancel or quit path changes.
- [ ] Native observation by the agent through the [native acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) or screenshots, starting from the shortcut (tray clicks were blocked for computer use in 040): the digit during a countdown on the 1080 pt primary display, then with the portrait secondary display selected (the same size, at that display's top-right), and a two-digit "10" during a 10-second countdown that is then cancelled (it fits inside the window; no recording needed). If a display with a different short side is available, such as the built-in display, capture one countdown there too and watch the first digit for a jump in size; otherwise record that case as not run.
- [ ] If the hero scene changed: `pnpm site:check` and inspection of the scene's paused frames.
- [ ] Exclusions: the quality and audio matrices, long recordings, permissions, the tray and the cancel and quit paths (capture, encoding, the start sequence and the countdown timing are unchanged); keyboard focus and click-through (window options are unchanged; 035's N34 still covers them); Windows appearance (macOS-only verification; the rule is platform-neutral and no Windows appearance is claimed). Whether the chosen size is right over white documents, dark apps and bright photos is the maintainer's judgement and belongs to 035's N32.

## Completion and evidence handling

Follow the [shared testing policy](../docs/testing.md) and [plan completion](README.md#completing-a-plan). Serialize shared builds; one desktop/audio/shortcut owner per round. Restore changed settings, close test UI, quit the tested app and confirm process exit; incomplete cleanup blocks the next round.

- [ ] Record checks/results, scope exclusions and required-but-unverified cases separately; mocked boundaries are not native proof. Missing prerequisites are blocked. Run `git diff --check` on the implementation.
- [ ] Reconcile 035 in both languages: N32 judges the digit's size as well as its transparency, and N34's secondary-display case checks that the size follows the display; update 035's reconciliation note to name 045.
- [ ] Preserve durable conclusions in bilingual design/verification docs, update both indexes, then remove this plan and translation only after completion. Do not commit, push or publish without a separate request.

Planning-only validation: relative links/anchors, command names, bilingual coverage and `git diff --check`; no App build, tests, launch or recording just to write this plan.
