# 073 — One place that lists every shortcut

[English](073-shortcut-list.md) | [繁體中文](073-shortcut-list.zh-TW.md)

Status: planned; not started. Created: 2026-10-13. Priority: after 072. Hard dependencies: none. Execute the steps in order under [the plan index](README.md).

## Goal and boundaries

Give the RecordStuff window one place that lists every keyboard shortcut a user can use and shows whether each one currently works. Success is a list that covers every category inventoried below, shows the right keys per platform (⌘⌥⇧⌃ symbols on macOS, `Ctrl+Shift+…` on Windows), reflects the recording shortcut's current choice and registration status, and cannot drift from the key handling it describes.

This plan adds a view only. The recording shortcut is still changed only in the General tab's existing Shortcut card; no shortcut becomes configurable, no existing shortcut changes its keys or behavior, and no global shortcut is added. The website's help page is out of scope unless the maintainer asks for it.

## Current state

Nothing in the app lists every shortcut. The Shortcut card shows the recording shortcut, the tray menu and the macOS Record/Dock menus show the recording and Open shortcuts, and the undo toast shows ⌘Z. The website's help page (`website/src/components/HelpContent.astro`) and the README mention only ⇧⌘1 and ⌥⌘,. Shortcuts inventoried on 2026-10-13:

| Category | Keys (macOS / Windows) | Action | Defined in |
| --- | --- | --- | --- |
| Global | ⇧⌘1 / Ctrl+Shift+1 by default; custom or Off | Start/stop recording; also cancels a countdown or a start that has lasted 1 s | `src/shared/hotkey.ts` (`DEFAULT_HOTKEY`), `src/main/shortcuts/hotkey.ts` |
| Global | ⌥⌘, / Ctrl+Shift+,, fixed | Open RecordStuff; not registered when it equals the recording shortcut (conflict) | `settingsShortcut()`, `src/main/shortcuts/settings-hotkey.ts` |
| Window | ⌘W / Ctrl+W, Esc | Close the window (Esc first closes the player, a dialog, a menu and so on) | `src/renderer/settings/controller/core.ts`, `src/renderer/lib/shortcut-capture.ts` (`isCloseChord`) |
| Window | ⌘Z / Ctrl+Z | Undo Move to Trash | `core.ts` |
| Window | ⌘+, ⌘-, ⌘0 (Ctrl on Windows) | Zoom in, zoom out, actual size | `src/main/settings/settings-window.ts` (`zoomRequest`) |
| Recordings | Esc in the search box | Clear the search | `src/renderer/settings/tabs/library.tsx` |
| Player | Space / K, ← / →, ↑ / ↓, M, F; on the seek bar PageUp / PageDown, Home / End | Play/pause, seek ±5 s, volume ±5%, mute, full screen; seek ±10 s, jump to start/end | `src/renderer/player/player.tsx` |
| Full-screen window | Esc, ⌘W / Ctrl+W, F, double-click | Leave full screen | `src/renderer/video/video-app.tsx` |

Not listed: the platform's standard editing and menu keys (⌘C/⌘V, ⌘Q, ⌘H, ⌘M and so on), ordinary keyboard navigation in lists and dialogs (Tab, arrows, Enter to confirm, Esc to cancel) and keys pressed while the shortcut editor records. They are platform conventions, not RecordStuff features; step 1's decision point may change this scope.

## Steps

### 1. Decide placement and scope (decision point)

- [ ] Ask the maintainer where the list lives. Recommended: a read-only "Keyboard shortcuts" group in the General tab's "Controls and notifications" section, below the Shortcut card, grouped by the categories above. Alternatives: (b) a dialog opened from the Shortcut card or the sidebar, plus ⌘/; (c) a separate tab. (b)'s ⌘/ is a new window shortcut: it must pass `validateAccelerator`'s reserved rules and must not collide with the shortcut editor while it records.
- [ ] Ask whether a "Keyboard Shortcuts" item belongs in the macOS menu. Recommended: no; there is no Help menu today, and adding one needs a native acceptance round.
- [ ] Confirm the "Not listed" scope above.

This plan pauses at this step until the maintainer answers.

### 2. One catalog as the source

- [ ] Add `src/shared/shortcut-catalog.ts` (proposed, does not exist yet): each row has an id, a category, an English label (the i18n key) and an accelerator or key list. Display uses the existing `acceleratorKeys`/`describeAccelerator`; no second platform formatter.
- [ ] Make the handlers read the same catalog so the two cannot drift: the player's key map, zoom's `zoomRequest`, `isCloseChord` and undo read catalog constants, or at least the catalog exports the keys they compare. Behavior must not change; the existing player, shortcut and layout unit tests keep passing.
- [ ] Unit tests: every player and window key in the catalog triggers its handler (checked through the existing handler functions, not the UI), and the macOS and Windows display text is right.

### 3. Build the list in main

- [ ] Build the list group in `src/main/settings/settings-model.ts`, because only main knows the global shortcuts' status: the recording row shows the current accelerator, "Off" when disabled and "Unavailable" when registration failed; the Open RecordStuff row shows "Unavailable" when `failed` or `conflict`. Reasons reuse the Shortcut card's existing diagnostics instead of repeating them.
- [ ] Add the fields a read-only list needs to the group type in `src/shared/settings-panel.ts` (for example a new `kind`), leaving existing groups unchanged.
- [ ] The recording row offers "Change", which moves focus to the Shortcut card; the list itself does not edit.
- [ ] Add the new strings to `ZH_TW` in `src/shared/i18n.ts`.
- [ ] `settings-model.test.ts`: darwin and win32; default, custom, Off and failed registration; Open shortcut failed and conflict.

### 4. Renderer

- [ ] Render the list in `src/renderer/settings/tabs/preferences.tsx` with the existing `Kbd`, group and section components and design tokens; no separate styling. Keys must be readable by a screen reader (for example an `aria-label` with `describeAccelerator`'s text rather than symbols alone).
- [ ] Page tests (`src/renderer/settings/page-tests/`): the list renders, status text, "Change" moves focus to the Shortcut card, zh-TW text. Behavior and accessibility only, no design values.
- [ ] If step 1 chose a dialog or a new tab, adjust settings-app and the Esc order accordingly and add page tests.

### 5. Documentation

- [ ] Add a section to `docs/system-design/desktop.md` describing the list, the catalog as the single source and the not-listed scope, and mirror it in `docs/zh-TW/`.
- [ ] Add a sentence pointing to the list where README and README.zh-TW mention shortcuts.

## Completion and verification boundaries

Complete when step 1's decision is recorded; the list in the General tab (or the place the maintainer chose) shows every catalog row with the right platform keys and status; the handlers share their definitions with the catalog; tests and documentation are updated.

Checks follow [the testing policy](../docs/testing.md#select-tests-from-behavior): this is a Settings UI and shared-constant change, not a recording or native UI change. Run `pnpm test:scope -- general shortcut player`, which covers the General tab's, the shortcut's and the player's unit and background UI tests (including `settings-layout.spec.ts` and `settings-matrix.spec.ts` at `@general`), plus `src/shared/i18n.test.ts`; step 2 touches zoom in `settings-window.ts`, so add the `layout` scope. No recording round or native acceptance is needed unless step 1 adds a macOS menu item or a new window shortcut; then add the relevant part of `pnpm acceptance:recipe -- native-ui` after the [desktop handoff](../docs/testing.md#confirm-desktop-handoff-before-testing). Windows is checked by CI only.

Writing this plan needs only: links and anchors, existing and proposed commands, English/Chinese parity and `git diff --check`; no tests, build or app launch.

At closure, record the list's design in the desktop documentation and the results with their translation in the verification record, update both indexes and remove the plan files under the project's completion rules. Do not commit, push or publish unless the user asks.
