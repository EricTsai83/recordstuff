# 099 — Separate switches for the menu bar, the Dock and the desktop, with the strips they hold cropped

[English](099-system-ui-crop.md) | [繁體中文](099-system-ui-crop.zh-TW.md)

Status: planned; not started. Created: 2026-10-28 at the maintainer's request. Hard dependencies: none open. It changes the switch added by the closed plan 076 (D6). Execute in order under the [plan index](README.md). This task writes the plan only. Nothing below has been implemented, measured or verified.

## Goal and current state

The maintainer found (2026-10-28) that with Hide menu bar and Dock on, a recording has an empty strip across its top. The menu bar is left out of the picture, but on the screen it is still there, so macOS still keeps windows below it: a maximized browser stops at the menu bar's lower edge, and the recording shows the wallpaper (or nothing) where the menu bar was. A Dock that is not set to hide automatically does the same on its own edge.

Current state:

- **One switch, one filter.** `hideSystemUi` ([settings.ts](../src/main/settings/settings.ts), [protocol.ts](../src/shared/protocol.ts)) leaves out, in one go, the menu bar and its status items, the Dock, desktop icons and widgets. [content.rs](../native/capture/src/mac/content.rs) (`system_ui_windows`, `filter`) lists their windows as exceptions to the display's filter and sets `includeMenuBar` off on macOS 14.2 and later.
- **The whole display is always recorded.** A display recording has no `sourceRect` ([session.rs](../native/capture/src/mac/session.rs)). Only the development `area` source sets one (`content::area_rect`), from a rectangle in the display's pixels.
- **The switch is shown twice:** in Recording settings (`hideSystemUiGroup`, [recording.ts](../src/main/settings/model/recording.ts)) and in the Studio's Screen picker (`studioScreenGroups`, [studio.ts](../src/main/settings/model/studio.ts)). On Windows it is shown unavailable, as Hide taskbar.

The goal:

1. Three switches in place of one: **Hide menu bar**, **Hide Dock** and **Hide desktop icons and widgets**, each independent.
2. Where a hidden part keeps a strip of the screen to itself, the recording leaves that strip out, so no empty band is recorded. A part that keeps no strip, such as a menu bar or Dock set to hide automatically, is left out of the picture and nothing is cropped.

## Design (proposed)

### Knowing which strips are kept: the display's work area

macOS publishes what the menu bar and Dock keep as each screen's `visibleFrame`, the area windows may use. Electron reports it as `Display.workArea`, beside `Display.bounds`, in points. RecordStuff already reads it to place the countdown and the Settings window ([countdown.ts](../src/shared/countdown.ts), [settings-window.ts](../src/main/settings/settings-window.ts)).

The difference between the two gives each kept strip on the display being recorded:

| Situation | `bounds` − `workArea` |
| --- | --- |
| Menu bar shown | top inset of the menu bar's height (about 24 pt; 37–38 pt beside a notch) |
| Menu bar set to hide automatically | no top inset |
| Dock kept on screen, at the bottom, left or right | an inset on that edge of the Dock's size |
| Dock set to hide automatically | none, or a few points (to be measured in step 0) |
| Dock on another display | none on this one |

So the Dock's automatic hiding does not need to be read on its own: the work area already reflects it, per display, along with the Dock's edge and size. A notched MacBook's screen below the menu bar is exactly 16:10 (for example 1512 × 945 pt out of 1512 × 982 pt).

The crop:

- Top inset only when Hide menu bar is on; the Dock's edge only when Hide Dock is on. A switch that is off crops nothing, because that part is recorded.
- Points become pixels by the display's scale, rounded inwards to even sizes for H.264.
- It is fixed when recording starts. If the Dock moves, changes size or its hiding changes during a recording, the recording keeps its size: a strip may show or be cut until the next recording. This is said in the switches' help.
- The live preview in the Studio shows the same crop, so what it shows is what will be recorded.

**If the work area proves wrong** in step 0 (in some arrangement, such as a full-screen Space, Stage Manager or a display without the menu bar), the fallback reads `com.apple.dock` `autohide` and `orientation` with CFPreferences for whether and where the Dock stays, and measures its strip from the Dock's window in `SCShareableContent`; the menu bar's height comes from `NSStatusBar.system.thickness` or the notch's `safeAreaInsets.top`. This is used only for the case the work area gets wrong, not as a second path for every recording.

### The engine: a display recording with a source rectangle

The capture request gains an optional crop for a display recording, in the display's pixels. The engine already sets `sourceRect` for an area: a cropped display uses that path (`area_rect`), with the display's filter and the hidden windows as now. `source_size` returns the cropped size, so the quality's output size, the camera bubble's place and the preview all follow the cropped picture. The bubble's layout is relative to the output frame ([camera-layout](../src/shared/camera-layout.ts)); step 0 confirms nothing assumes the full display's size.

### The output size: the cropped proportions as they are

The recording keeps the cropped proportions (for example 2560 × 1415 on a 2560 × 1440 external display with the menu bar hidden). It is neither scaled nor padded to 16:9: players and sites show it in its own proportions, and the difference from 16:9 is under 2%. The area source already records any proportions. (D3.)

### The settings

- Settings version 4 → 5: `hideSystemUi` is replaced by `hideMenuBar`, `hideDock` and `hideDesktop`. A version 4 file with `hideSystemUi` on turns all three on; off, all three off. Each new field read as a non-boolean falls back to off with a warning, as now.
- The native request carries the three choices and the crop; `system_ui_windows` picks windows by switch: menu bar (`MENU_BAR_LEVEL`, `STATUS_LEVEL`, `includeMenuBar`), Dock (`DOCK_LEVEL` owned by `com.apple.dock`), desktop (`DESKTOP_OWNERS` below level 0).
- Recording settings and the Studio's Screen picker show the three switches, each with its own help. The menu bar's says the strip it holds is not recorded; the Dock's says the same for a Dock kept on screen. Windows keeps its one unavailable Hide taskbar.
- i18n: the new labels and help in English and Traditional Chinese; the old two strings removed.

### Not in this plan

- Changing the system's own menu bar or Dock hiding during a recording (rejected below).
- Windows: Windows.Graphics.Capture still cannot leave the taskbar out.
- Window and app recordings: they have no menu bar or Dock strip to crop.

### Rejected alternatives

- **Turning on the system's automatic hiding while recording** (`autohide menu bar` through System Events, the Dock's `autohide`). Windows already maximized do not grow; it changes a global setting that a crash would leave changed; it needs the Automation permission; and pointing at the top shows the menu bar again.
- **Making the menu bar transparent with yabai's scripting addition.** Needs System Integrity Protection partly off.
- **Padding or scaling to 16:9.** Adds a band or a resampling to every recording to fix a difference of under 2% (D3).

## Decisions

- **D1 — three switches or two.** Proposal: three (menu bar; Dock; desktop icons and widgets). The alternative keeps desktop icons and widgets with the Dock.
- **D2 — the Dock's crop.** Decided by the maintainer on 2026-10-28: a Dock kept on screen is cropped as the menu bar is.
- **D3 — the cropped proportions.** Proposal: keep them, as above. The alternative is padding to the nearest standard proportion.

## Steps

- [ ] **0. Start.** Read 076's closure and the [desktop design](../docs/system-design/desktop.md) on the switch. On this Mac, record `bounds` and `workArea` for: the built-in notched display, an external display, menu bar shown and hiding, Dock at the bottom, left and right, kept and hiding, Dock on the other display, a full-screen Space, Stage Manager on. Decide from them whether the work area alone suffices or the fallback is needed. Confirm where the full display's size is assumed (camera layout, preview, `quality` output size, notifications that state the size). Start `caffeinate -d -i -t 5400` before the first desktop round, per [AGENTS.md](../AGENTS.md).
- [ ] **1. The crop as a pure function.** From `bounds`, `workArea`, scale and the two switches to a pixel rectangle; even sizes; no crop when nothing is kept. Tests cover each row of the table above and the measured cases from step 0.
- [ ] **2. Settings and protocol.** Version 5, migration from `hideSystemUi`, the three fields, the native request's choices and crop with their validators. Tests: migration both ways of the old switch, malformed fields, the protocol's refusals.
- [ ] **3. The engine.** `system_ui_windows` by switch; a display recording with a crop sets `sourceRect` and reports the cropped size. Engine tests for the rectangle and the size; the live test records a cropped display.
- [ ] **4. Settings and Studio UI.** The three switches in Recording settings and the Screen picker, help in both languages, the Windows row unchanged. The preview shows the crop.
- [ ] **5. The app.** After the "好了" handoff, on a fresh signed bundle: with a browser maximized, record with each switch alone and all three, on the built-in display and an external one, with the Dock kept and hiding. For each: the recording's size equals the work area's (or the full display for a switch off) by ffprobe, its top row is the browser's and not the wallpaper, the Dock and menu bar are absent, a menu opened from the menu bar is still recorded below its strip, and the camera bubble sits where the preview showed it. Restore settings, close the app and confirm its processes exited.
- [ ] **6. Document and close.** [desktop design](../docs/system-design/desktop.md) (the three switches, the crop and its limits), [design decisions](../docs/system-design/decisions.md) if the alternatives above are kept as decisions, the verification record, translations, this plan's removal and the index.

## Verification

- Steps 1–4: `pnpm test:scope -- recording-settings studio settings-bridge` and the engine's capture tests while working; `pnpm check` before step 5, because the settings file, the capture protocol and the engine's source change.
- Step 5: desktop round after the "好了" handoff, with the [native acceptance skill](../.agents/skills/native-acceptance/SKILL.md); serialize `out/` and `dist/` consumers; one owner for the desktop.
- Report separately: automated results, the work-area measurements of step 0, which display and Dock arrangements were recorded and checked, and what stayed unverified (for example a display arrangement not available on this Mac, or macOS before 14.2, where `includeMenuBar` is missing).

## Execution and closure contract

Follow the [plan index](README.md) for order, decision points, desktop handoff and closure. D1 and D3 must be answered before step 2. No commit, push, PR or release is part of this plan unless requested.
