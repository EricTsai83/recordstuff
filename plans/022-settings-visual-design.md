# 022 — Settings panel visual design

[English](022-settings-visual-design.md) | [繁體中文](022-settings-visual-design.zh-TW.md)

Status: not started; design proposed, nothing implemented. Priority: after 021. Created: 2026-09-21.

## Problem and outcome

The settings panel is the only window RecordStuff has. Everything else the user sees is a tray icon, a notification and a file, so this one window carries the whole visual impression of the app — and it currently looks like an unstyled form. Every preference, including the two that are simply on or off, renders as the same full-width `<select>` inside the same bordered card ([renderer/settings.ts](../src/renderer/settings.ts), [settings.css](../src/renderer/settings.css)). General stacks six identical cards with no grouping, so the shortcut, the two update controls, notifications and language all read as equally weighted strangers. Three cards carry a permanently visible paragraph of explanation. A failed save reports itself in a red line at the bottom of the window, away from the control that failed. The focus ring is one hard-coded blue that ignores the user's macOS accent colour, and the content column is capped at 560px inside a 460px window, so that cap has never once applied.

Give the panel the shape a macOS user already knows: grouped inset lists, a switch for a switchable thing, a popup menu where a list is genuinely a list, system colours, and a failure that appears where it happened. The panel must stay exactly as truthful as it is now — same preferences, same ids, same lock rule, same save path — and must not become slower to read in Traditional Chinese than in English. Scope is the settings window; the tray, the notifications and the first-run hint are not part of this plan.

## Design decisions

### Presentation only, and the contract stays an id echo

No preference is added, removed, renamed or re-defaulted; no group or choice id changes; `preferencesUnlocked` and the save path in [settings-window.ts](../src/main/settings-window.ts) are untouched. A plan that redraws the panel and also changes what a control does cannot be reviewed, because every visual difference becomes a candidate explanation for a behavioural one.

The panel therefore still receives a rendered view and still sends back a group id and a choice id. A switch echoes `on` or `off` exactly as today's two-option `<select>` does, and a segment echoes the same id its `<option>` did. Nothing in this plan gives the renderer a way to describe work main did not offer, which is the property [settings-panel.ts](../src/shared/settings-panel.ts) exists to protect.

### Main declares the control; the renderer does not guess

The renderer cannot tell a boolean from a two-item list: `notifications` is On/Off and `language` is English/繁體中文, both two choices, and only one of them is a switch. Counting choices in the renderer would encode that judgement in the wrong process and would silently change a control when a list grows or shrinks.

`SettingsGroup` gains `control?: "switch" | "segmented" | "menu"`, defaulting to `menu`, and [settings-model.ts](../src/main/settings-model.ts) states it once per group beside the choices it already declares. The rule the model follows is written down so a future group does not have to be argued from scratch:

- `switch` for a preference that is genuinely on or off — `notifications`, `updateChecks`.
- `segmented` for at most three mutually exclusive choices whose labels are short in both languages — `videoQuality` and `language`.
- `menu` for everything else. `resolutionCap` has four choices, `frameRate` carries the long "60 fps (unverified on this platform)" label that no segment can hold, and `hotkey` is a list that 020 makes longer still.

`kind` keeps its current meaning — what a group *is* (`"actions"` today, `"shortcut"` after 020) — and `control` says how a value-carrying group is drawn. A group with `kind: "actions"` has no value and ignores `control`.

### The native popup and the native checkbox stay native

The `<select>` is not replaced by a custom listbox. It is the one control in the panel that already has correct keyboard handling, correct VoiceOver output, correct behaviour under `forced-colors` and a native popup that macOS draws itself; a hand-built substitute would be a downgrade wearing a nicer coat. Only its chrome changes.

The same reasoning fixes the control types below it. A switch is `<input type="checkbox" role="switch">` and a segment is a real `<input type="radio">` inside a `radiogroup`, both with the visual layer applied over them rather than instead of them. Under `forced-colors: active` the custom layer is dropped and all three controls render as the platform draws them, which is what the stylesheet already does for the `<select>` arrow.

### The panel is a grouped list, not a stack of identical cards

Rows belong to sections. `SettingsGroup` gains `section?: string`; consecutive groups sharing a section id render as one inset list with hairline separators, and a section may carry an optional header and an optional footnote. Sections, not rows, own the spacing between them.

Two groupings pay for themselves immediately. In Recording, video quality, resolution cap and frame rate become one list instead of three boxes. In General, "Check for updates on launch" and the Updates action group become one section under a single header, because today they are two separate cards about the same subject sitting next to each other for no reason a user can see. Headers stay rare: a section whose rows already name their subject does not get one.

### A row is label-left, control-right, with its note underneath

Each row puts its label on the leading edge and its control on the trailing edge of the same line, the arrangement macOS System Settings uses, so a column of controls lines up and the panel stops spending a full line on every label. A note keeps its own line under the row it belongs to, in secondary type, spanning the row's width; long Chinese and English labels wrap there rather than being truncated. Below a narrow threshold the row stacks label over control, so a user who has dragged the window small still sees a whole label instead of an ellipsis.

The blunt `overflow-wrap: anywhere` currently on every label goes away with it: it breaks English words mid-word to solve a problem that the two-column layout and normal wrapping solve properly.

### A note that reports state is announced; a note that explains is not

The panel has two kinds of note and currently treats them alike. "Higher quality preserves more detail…" is a static explanation that is true before the user arrives; "Unavailable: another app is using this shortcut." and "Up to date (checked …)" appear and change in response to what just happened. The second kind is exactly what a live region is for, and today only the actions-group note gets `role="status"` while the shortcut refusal — the most important message the panel can show — gets none.

`note` therefore gains a companion `noteKind?: "explanation" | "status"`, default `"explanation"`: an explanation stays wired to its control through `aria-describedby`, and a status note is additionally announced when it changes. This is a one-field addition that main already has the knowledge to fill in.

### A failure is reported at the control that failed

`#feedback` at the bottom of the window is the wrong place for "Could not apply this setting": on a window with six groups the message can be a screen away from the control the user just touched. The renderer already knows which group it was asking about — `saving.group` — and `SettingsChoiceResult.applied` already tells it the answer, so no contract change is needed. The failure renders in the failing group's row, and a visually hidden live region keeps the announcement for anyone not looking at the row. The failure text still comes from main's `view.failure`, unchanged.

### Tabs are a segmented control, and stop assuming there are exactly two

The tab strip becomes one macOS-style segmented control sitting under the header rather than two full-width buttons tinted with a hard-coded blue.

The keyboard handler is rewritten at the same time, because it is currently written against the literal ids `"recording"` and `"general"`: Home selects `"recording"`, End selects `"general"`, and either arrow key swaps between them. Arrow keys, Home and End become index arithmetic over `view.tabs`, so the day a third tab is added — 021 already adds a group to Recording — the keyboard does not quietly stop working. The [ARIA tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) stays as implemented: roving `tabIndex`, `aria-selected`, `aria-controls`.

### System colours, not one hard-coded blue

`color-scheme: light dark` and `light-dark()` stay; they are already right. What changes is that the accent stops being `#2476db`. Focus rings and selected states use the platform accent — `AccentColor`/`AccentColorText` and `accent-color` on the native controls, with the current blue kept as the fallback for engines that do not resolve the system keyword — so a user who has set a different macOS accent sees their accent. Text, border and surface values are restated as a small set of custom properties in one block instead of being repeated inline at every rule, and each pair keeps a contrast ratio of at least 4.5:1 in both schemes.

The recording red from the [website's theme](../website/src/themes/ember.css) is deliberately not imported. Red means "recording" in this app, and the settings window is the one surface where nothing is ever recording; a red accent here would be the first time the app used its state colour decoratively.

### The header stays put; the list scrolls

Today `body` scrolls, so the title, the hint and the tab strip leave the window as soon as the content is taller than it. The header and tabs become fixed and the section list gets its own scroll region, which is how a macOS settings window behaves and which keeps the "Recording in progress. Recording settings are locked." hint visible at the moment it matters most.

The window itself is resized to fit the grouped list without scrolling in the ordinary case, keeps `resizable` and its minimum size, and the content column gets a real maximum width so that a user who widens the window gets a centred column rather than rows stretched to the full frame. The current `max-width: 560px` inside a 460px window is removed as the dead rule it is.

### The lock says why, once per section

A disabled control at 50% opacity does not explain itself. While a capture is running, the Recording section's footnote states that recording settings are locked until the recording stops — the same sentence main already sends as `view.hint`, placed where the dimmed controls are rather than only at the top of a window that may be scrolled. Language stays enabled and needs no explanation; it is the one preference that never touches a capture.

The rebuild-on-every-change model is kept as is. It is what makes the panel a projection rather than a second source of truth, and the existing focus restoration by element id — including `preventScroll` — already covers the cost.

### The renderer's test is the acceptance fixture, not a new DOM runtime

Vitest runs in the `node` environment and the repository has no jsdom or happy-dom dependency; `capture-host.test.ts` is written specifically to need no DOM. Adding a DOM runtime to unit-test a stylesheet would buy a fake browser's opinion of a layout.

The panel's real test already exists: [`pnpm acceptance:settings`](../scripts/acceptance-settings.mts) drives the shipped page and preload in a real Electron window through [scripts/fixtures/settings-panel.mjs](../scripts/fixtures/settings-panel.mjs), and writes `panel.png`. That fixture asserts against today's DOM — `.row`, `select`, `#feedback` — so this plan must move each assertion to the new structure while keeping every behaviour it checks, and add cases for the switch, the segments and the inline failure. Its screenshot is the before/after evidence. Pure model additions (`control`, `section`, `noteKind`) are unit-tested in [settings-model.test.ts](../src/main/settings-model.test.ts) as ordinary data.

### Where this sits relative to 020 and 021

020 adds a shortcut capture control and 021 adds a Screen group; both land in the same three files this plan rewrites. Running this last means each new control is authored once, against the finished vocabulary, instead of being styled and then restyled — which is why the priority is after 021.

If the maintainer wants the visual work sooner, the cost is stated rather than hidden: 020 and 021 then declare `section` and `control` for the groups they add, which is one field each, and 020's capture field arrives as a fourth `control` value. Nothing in this plan blocks either of them; it only decides which one pays for the rework.

## Expected experience

- Settings opens on a window whose header and tab strip stay put while the preferences below them scroll, with the tabs drawn as one segmented control.
- Recording shows a single grouped list: video quality and resolution cap as segmented and popup controls with their explanations beneath them, frame rate as a popup that still lists the unverified frame rate and still refuses to select it.
- General shows shortcut, notifications, updates and language as distinct sections; Notifications is a switch with Open notification settings… in the same section, and "Check for updates on launch" sits with Check for updates… under one Updates header.
- A change that does not take effect says so in the row that failed, in the panel's language, while the committed value stays displayed; screen-reader users hear it once.
- A shortcut the OS refused keeps its selection and its note, and the note is now announced when it appears.
- During a recording, recording preferences are dimmed and the section states why; Language stays usable; nothing about the panel can block starting, stopping or saving.
- Light and dark both follow the system, the focus ring is the user's macOS accent colour, keyboard-only operation reaches every control in visible order, and Escape and ⌘W still close the window.
- Traditional Chinese and English both fit without truncation or a horizontal scrollbar, at the default window size and at the minimum size.

## Implementation order

### 1. Contract and model

- [ ] Add `control`, `section` and `noteKind` to [settings-panel.ts](../src/shared/settings-panel.ts) as optional fields with documented defaults, so an older fixture view still renders.
- [ ] Declare them per group in [settings-model.ts](../src/main/settings-model.ts): switches for `notifications` and `updateChecks`, segments for `videoQuality` and `language`, menus elsewhere; one Recording section, and General sections for shortcut, notifications, updates and language.
- [ ] Mark the shortcut-refused, updates-result and notifications-off notes as `status`, and the quality explanations as `explanation`.
- [ ] Tests in [settings-model.test.ts](../src/main/settings-model.test.ts): each group's declared control and section, the note kinds, and that no group id, choice id, default or lock behaviour changed.

### 2. Stylesheet

- [ ] Rewrite [settings.css](../src/renderer/settings.css) around one token block: surfaces, borders, two text levels, radii, the platform accent with a fallback, and the macOS type scale.
- [ ] Build the section list, the row (label leading, control trailing, note beneath, stacked below the narrow threshold), the switch, the segmented control and the restyled popup.
- [ ] Keep the `forced-colors: active` escape hatch for all three control types, honour `prefers-reduced-motion` for any transition, and keep focus rings visible in both schemes.

### 3. Renderer

- [ ] Render sections and the three control types in [renderer/settings.ts](../src/renderer/settings.ts), each echoing the same group and choice ids it does today.
- [ ] Move the failure into the failing group's row and keep a visually hidden live region; wire `noteKind` to `aria-describedby` or a live note.
- [ ] Replace the two-tab keyboard arithmetic with index math over `view.tabs`.
- [ ] Keep the full rebuild and the id-based focus restore.

### 4. Window

- [ ] Resize the window in [settings-window.ts](../src/main/settings-window.ts) to fit the grouped list, keeping `resizable` and a minimum size, and give the content a real maximum width.

### 5. Messages

- [ ] Add any new string — section headers, the locked-section footnote — to [i18n.ts](../src/shared/i18n.ts) in English and Traditional Chinese, with consistent placeholders. Reuse existing strings wherever the sentence already exists.

### 6. Acceptance fixture

- [ ] Update [scripts/fixtures/settings-panel.mjs](../scripts/fixtures/settings-panel.mjs) to the new structure, preserving every behaviour it already asserts: CSP and console cleanliness, the preload surface, the sandbox, first-render language, committed values, a disabled platform option, the refused-shortcut note, id-only IPC, pending-save ordering with an interleaved push, and the notifications card with its pane button.
- [ ] Add cases for the switch, a segmented choice, the inline failure and the tab segmented control.
- [ ] Keep `panel.png` and capture it in both languages and both colour schemes as before/after evidence.

### 7. Documentation

- [ ] Update the Settings window section of [desktop design](../docs/system-design/desktop.md#settings-window) and its [translation](../docs/zh-TW/system-design/desktop.md) for the control vocabulary, sections and inline failure.
- [ ] Run `pnpm check` and `git diff --check`.

### 8. Verify behavior

- [ ] Open the panel from the tray in a built app and check both tabs in English and Traditional Chinese, in light and dark, at the default and minimum window sizes. Use the [native computer-use acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) with `pnpm start:app`; check for a user recording in progress before rebuilding or quitting.
- [ ] Operate every control by keyboard only, then with VoiceOver: labels, switch states, segment selection, announced status notes and the inline failure.
- [ ] Start a recording, open the panel, confirm recording preferences are dimmed with the stated reason and Language still works, then stop and save normally.
- [ ] Run `pnpm acceptance:settings` and `pnpm acceptance`, and confirm start → stop → save → playback is unaffected.
- [ ] Check a non-default macOS accent colour and Increase contrast; record anything not checked.
- [ ] Record what was actually tested and what was not in the [verification record](../docs/verification/README.md), with the before and after screenshots.

## Completion and boundaries

No commit, push, tag or publication is authorized by this plan. Out of scope: any change to which preferences exist, their defaults, their ids or the lock rule; the tray menu, notifications and the first-run hint; a sidebar or a third tab; window vibrancy, a custom title bar or traffic-light positioning; an app-wide theme or a theme preference; animations beyond state transitions on the controls themselves; importing the website's palette; a DOM test runtime; and any claim of Windows or Linux acceptance. Do not change a user's stored preferences to produce a screenshot.

On completion, move the durable conclusions into [desktop design](../docs/system-design/desktop.md#settings-window) and the [verification record](../docs/verification/README.md), then follow [plan completion](README.md#completing-a-plan).

## Technical references

- [Apple: Settings](https://developer.apple.com/design/human-interface-guidelines/settings): grouping, section footnotes and what a settings window is expected to look like on macOS.
- [Apple: Toggles](https://developer.apple.com/design/human-interface-guidelines/toggles): when a preference is a switch rather than a list.
- [Apple: Segmented controls](https://developer.apple.com/design/human-interface-guidelines/segmented-controls): the count and label limits behind the at-most-three rule.
- [Apple: Typography](https://developer.apple.com/design/human-interface-guidelines/typography): the macOS text styles the type scale follows.
- [MDN: light-dark()](https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/light-dark): the scheme-aware colour function already in use.
- [MDN: accent-color](https://developer.mozilla.org/en-US/docs/Web/CSS/accent-color): tinting native checkboxes and radios with the platform accent.
- [MDN: forced-colors](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/forced-colors): the escape hatch each custom control needs.
- [ARIA APG: Switch](https://www.w3.org/WAI/ARIA/apg/patterns/switch/) and [Tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/): the roles, states and keyboard behaviour the panel must keep.
