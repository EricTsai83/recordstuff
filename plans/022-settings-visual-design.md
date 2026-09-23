# 022 — Settings panel visual design

[English](022-settings-visual-design.md) | [繁體中文](022-settings-visual-design.zh-TW.md)

Status: not started; design proposed, nothing implemented. Priority: next; 021 is complete. Created: 2026-09-21. Updated: 2026-09-23 to incorporate focus/custom shortcut polish, 021 error visibility, independent visual identity, official links and restrained recovery actions.

## Problem and outcome

The settings panel is the only window RecordStuff has. Everything else the user sees is a tray icon, a notification and a file, so this one window carries the whole visual impression of the app — and it currently looks like an unstyled form. Every preference, including the two that are simply on or off, renders as the same full-width `<select>` inside the same bordered card ([renderer/settings.ts](../src/renderer/settings.ts), [settings.css](../src/renderer/settings.css)). General stacks six identical cards with no grouping, so the shortcut, the two update controls, notifications and language all read as equally weighted strangers. Three cards carry a permanently visible paragraph of explanation. A failed save reports itself in a red line at the bottom of the window, away from the control that failed. The focus blue is repeated across rules instead of shared app tokens; a fixed brand color is not itself a problem, and the content column is capped at 560px inside a 460px window, so that cap has never once applied.

Give the panel the shape a macOS user already knows: grouped inset lists, a switch for a switchable thing, a popup menu where a list is genuinely a list, consistent app colours, and a failure that appears where it happened. The panel must stay exactly as truthful as it is now — same preferences, same ids, same lock rule, same save path — and must not become slower to read in Traditional Chinese than in English. Scope is the settings window; the tray, the notifications and the first-run hint are not part of this plan.

## Design decisions

### Visual direction: independent app identity with macOS character

The user's 2026-09-23 preference establishes an independent, refined app identity with macOS character. Allow future Windows adaptation without adding platform support or acceptance to this plan. Use system typography, the native window frame, familiar control proportions, neutral surfaces, fine separators, restrained corner radii and an app-owned accent. Create character through spacing, alignment, typographic hierarchy and consistent interaction details. Keep native popup and keyboard conventions, with lightweight shortcut symbols and keycaps.

Avoid oversized branding, decorative gradients, heavy shadows, oversized pill buttons, broad accent fills and nested cards. Do not introduce glass/transparency effects or custom window chrome just to imitate the system. Keep branding limited to small identification elements and preserve recording red's state meaning. This direction guides settings and future UI without expanding this plan into tray or notification redesign.

For visual acceptance, compare the real app alongside System Settings on the same Mac: control density, type scale, colors and focus should feel compatible, while grouping and hierarchy should improve on the current panel. Preserve comparison screenshots and observations; pixel-for-pixel imitation is not required. Apply this check in both languages and color schemes. Focus and shortcut polish in this plan follow the same direction; the expanded capture area should belong to the same family of settings controls.

### Official website and source links

Keep a recognizable, quiet About RecordStuff area at the bottom of General, with the app name and Official website / GitHub source text links targeting the project's https://record.ericts.com and https://github.com/EricTsai83/recordstuff. Place it at the end of the scrollable content, separated by spacing or a fine rule; no new tab, large branding card or fixed footer. Allow wrapping at narrow sizes, provide visible keyboard focus and accessible names, and keep links available during recording.

Open main-authorized fixed destinations in the default browser; never navigate the settings window or accept arbitrary renderer URLs. Necessary link action ids may be added, while existing preference/choice ids and the save contract remain unchanged: these are navigation actions, not new preferences. Include bilingual labels, opening failures and the authorization boundary in fixture/native acceptance.

### Refine presentation and editing interactions; preserve preference contracts

No preference is added, removed, renamed or re-defaulted; no group or choice id changes; `preferencesUnlocked` and the save path in [settings-window.ts](../src/main/settings-window.ts) are untouched. This plan includes entry-point consolidation, inline capture and focus-flow changes. Shortcut defaults, allowed combinations, preference storage and main’s validation/registration responsibilities remain unchanged.

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

`#feedback` at the bottom of the window is the wrong place for "Could not apply this setting": on a window with six groups the message can be a screen away from the control the user just touched. The renderer already knows which group it was asking about — `saving.group` — and `SettingsChoiceResult.applied` already tells it the answer, so no contract change is needed. The failure renders in the failing group's row, and a visually hidden live region keeps the announcement for anyone not looking at the row. Failure text remains main-owned: prefer a specific save result and retain existing `view.failure` as the fallback when details are unavailable.

### Errors must be visible without reading ordinary help text

During 021 manual acceptance on 2026-09-23, the maintainer unplugged BenQ BL2480T: capture was correctly refused and Settings showed the unavailable reason, but it was concatenated with the ordinary whole-screen/system-audio explanation in the same secondary text. The row still looked healthy, making the error easy to miss. A hover tooltip may supplement feedback but must not be required to recognize failure. This is a 022 presentation improvement, preserving 021 source resolution and diagnostic lifetime; it does not establish that the remaining manual acceptance passed.

- Place a separate, persistently visible diagnostic area beside the affected control. Separate ordinary help from current errors using a warning icon, explicit heading, typographic hierarchy and restrained surface/border treatment. Color alone, hover and system notifications are insufficient.
- State the affected choice, current consequence and next step. For example: “Selected display is unavailable” and “Recording cannot start. Choose Primary display or another available screen.” A missing capture source must not be mislabeled as a disconnected display.
- Distinguish current unavailability from “Last recording failure”; historical feedback must not imply a recovered screen is still unavailable. Preserve main's retention/clearing rules, show feedback with notifications off, and never imply recovery after a failed save.
- Main supplies structured current/historical diagnostics, headings and reasons separately from static `note`, extending `SettingsGroup` with optional fields as needed. `noteKind` announcement semantics do not replace visual error semantics; the renderer must not parse translated prose to identify failures. Omitted fields remain compatible with existing fixtures.
- Share these presentation semantics across unavailable displays, shortcut conflicts and failed saves. Healthy rows have no permanent warning box. Associate diagnostics with controls and announce a change once; verify both languages, light/dark and forced colors, keeping warnings distinguishable from recording-state indicators.

### Recovery interaction: understand and resolve the problem in place

The maintainer additionally requests better UI and usage, beyond conspicuous warnings. Use the original control, adjacent diagnostics and a concrete recovery action together. Preserve the saved screen selection when unavailable; let the user understand and change it in the same place without dismissing a dialog, hovering or finding another settings page. Default to nonblocking inline feedback; do not add modals or repeated toasts for these recoverable settings problems.

```text
Screen                  [ BenQ BL2480T — Unavailable ▾ ]

⚠ The selected screen cannot currently be recorded
  BenQ BL2480T is unavailable, so recording cannot start.
  Use Primary display or choose another screen above.

  [ Use Primary display ]

Captures the whole screen. System audio is unaffected.
```

This illustrates hierarchy, not a requirement for nested cards. Use restrained warm warning treatment, a clear heading and spacing; ordinary help stays secondary. Add an Unavailable suffix to the disabled saved native option, while keeping the menu itself usable. Keep status suffixes separate from ids and persisted labels. Offer at most one small secondary recovery button; the existing menu already provides other screen choices, so do not add a duplicate Choose another button.

| Situation | Presentation | Next action |
| --- | --- | --- |
| Specific target currently missing or ambiguous | Explicitly say recording cannot currently start and name the target; say disconnected only when established | Use Primary display saves the existing primary choice directly; the native menu offers alternatives. Neither starts recording automatically. |
| Display present but previous source enumeration failed or topology changed | Say the last start failed and give the accurate reason; historical failure does not prove a current blocker | Explain retry through the existing recording shortcut/tray entry or change the original selection. Do not label a UI refresh Retry. Opening Settings still never enumerates capture sources. |
| Previous recording interrupted by display removal | Use a Last recording interrupted heading; if the current target is also unavailable, combine in one diagnostic area with current impact first and history secondary | Offer the same recovery where an alternative is available. Do not promise partial-file playback or show an Open file action without a known file path. |
| Saved shortcut registration conflict | Say the shortcut is unavailable and that recording remains accessible through the tray | Reuse the shortcut menu or Custom/Change entry, without duplicate edit controls. |
| Current preference save failed | Retain the committed value and explicitly say the change was not saved, separately from source availability; show concurrent issues as two clear messages within one area | Offer Retry save only while the failed candidate remains valid and unlocked. If it disappeared or another edit superseded it, request reselection instead of overwriting newer choices. |
| Alternative saved successfully | Update the committed control before briefly confirming Switched to Primary display; clear diagnostics only under existing rules | Do not start recording or require an extra confirmation. A successful save does not prove capture availability. |
| Target becomes available on reconnect | Remove current-unavailable treatment; downgrade any retained failure to clearly labeled history | Do not clear history or start automatically; successful capture or a different saved choice clears it under 021 rules. |

During recovery saves, prevent duplicate submission, retain the committed value and show Applying…. If capture starts concurrently, preserve main's locking and session-snapshot rules. Main reauthorizes currently offered actions; renderer echoes existing group/choice ids, without arbitrary payloads or a new capture entry point. If a successful action removes the focused button, return focus to the screen menu only when focus was still on that button. Do not steal focus after Tab/window blur, or move focus/scroll on hotplug pushes. Current blockers have no dismiss button that hides the problem; historical messages do not repeatedly pop up.

Structured diagnostics distinguish current state, historical cause and the current save result; recovery references existing authorized choices or editing entry points. Acceptance measures successful understanding and recovery: without hover, logs or relaunch, the user can identify the affected choice, whether capture is currently blocked, the next step and whether the save succeeded. More red borders are not a completion criterion.

Quick fixes are not required on every diagnostic. Prefer the adjacent existing control; show Use Primary display only when recording is currently blocked, main offers a valid alternative and the next step is concrete. It is optional convenience, not a claim that Primary is the user's intended content. Use the same small, neutral secondary-button style as other actions, beneath and aligned with the reason; avoid broad accent fills, separate cards or empty space in normal states. History alone does not trigger this button; shortcut conflicts use the existing menu/edit entry. Save retries still follow the validity rules above. Compare normal/error density at minimum size; if the shortcut action is redundant or crowded, prioritize the existing control and clear guidance, record the tradeoff, and do not judge completion by button count.

### Tabs are a segmented control, and stop assuming there are exactly two

The tab strip becomes one macOS-style segmented control sitting under the header rather than two full-width buttons tinted with a hard-coded blue.

The keyboard handler is rewritten at the same time, because it is currently written against the literal ids `"recording"` and `"general"`: Home selects `"recording"`, End selects `"general"`, and either arrow key swaps between them. Arrow keys, Home and End become index arithmetic over `view.tabs`, so the day a third tab is added — 021 already adds a group to Recording — the keyboard does not quietly stop working. The [ARIA tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) stays as implemented: roving `tabIndex`, `aria-selected`, `aria-controls`.

### App-owned colours and shared tokens

Keep `color-scheme: light dark` and `light-dark()` so the scheme follows the system. Ordinary focus, selection and switches use an app-owned accent, without requiring the user's macOS accent or adding a theme preference. Start from the existing blue and centralize semantic tokens; confirm final values in real bilingual light/dark views. Platform-drawn popups retain platform behavior. Centralize text, border and surface colors, keep text pairs at least 4.5:1, and let accessibility system colors take precedence in forced colors. Future ports can retain semantic tokens while adapting native controls and interaction conventions.

The recording red from the [website's theme](../website/src/themes/ember.css) is deliberately not imported. Red means "recording" in this app, and the settings window is the one surface where nothing is ever recording; a red accent here would be the first time the app used its state colour decoratively.

### Shared focus treatment

- Use shared color, width, offset and radius tokens for popups, buttons, tabs and the switches/segments introduced by this plan.
- Start with a 2px solid outline and 1px offset following the control radius, without extra glows or duplicate rings. Tune using real Electron light/dark screenshots; keep at least 3:1 contrast against adjacent backgrounds rather than reducing opacity until focus is indistinct.
- Use `:focus-visible` for ordinary controls and respect browser modality decisions. Do not globally remove outlines or blur controls to hide focus. Tab, Shift+Tab and restored keyboard focus must remain visible.
- Provide readable light/dark app-accent pairs. In forced colors, use system colors and a solid outline rather than relying on box-shadow. Avoid clipping and layout shifts; distinguish selection, hover, focus and disabled states.
- Express shortcut listening with a field surface, border and text, without another competing focus outline or pulsing animation.

### Shortcut row and one custom entry point

Use a leading label with the committed-value native `<select>` and a trailing Custom… button on the same row. Keep existing presets, Off and the saved custom value in the popup; remove its duplicate Custom… action. Label the button Change… when a custom value exists. Stack at minimum width without truncating either language.

```text
Shortcut     [ ⌘⇧1  ▾ ]  [ Custom… ]

Shortcut     [ ⌘⇧1  ▾ ]  [ Change… ]
             [ Press a combination / ⌘ ⇧ K ] [ Cancel ]
             Applies automatically; Esc cancels
```

Expand an inline capture area only while editing; no modal. Keep the committed value in the popup. Render candidate keys as compact, consistently spaced keycaps in the capture field, with readable accessible names and no extra tab stops for decoration. Do not insert custom keycaps into native options.

### States and exits

| State | Presentation and behavior |
| --- | --- |
| Idle | Committed value and Custom/Change action; no permanent capture field or excess instructions. |
| Arming | Wait for main to acknowledge capture before displaying listening and focusing the field; report failure locally. |
| Listening | Prompt, candidate keys and Cancel; retain suspension of global shortcuts that could intercept input. |
| Applying | Brief status and duplicate-submit protection without flashing or shifting the row. Keep automatic application of a complete valid combination; no new confirmation step. |
| Success | Update only after main confirms success, collapse editing, return focus to Change and announce success once. |
| Invalid/conflict/save failure | Show the specific reason and retry action beneath the field. Follow main's returned state: distinguish uncommitted invalid input from a saved shortcut that the OS cannot register; never imply the previous shortcut still works without evidence. |
| Cancel/blur/timeout | Preserve the existing 15-second timeout and cleanup. Esc cancels editing first without closing Settings. Tab leaves normally and cancels. Explicit cancellation returns focus to the entry action; Tab and window blur must not steal focus back. |
| Recording lock | Honor existing enabled rules, prevent capture and explain the lock. |

Cancel must work reliably despite capture-field blur. Tab changes, window close, renderer failure and save exceptions must restore shortcut registrations. Preserve ⌘W closing and the existing Escape-to-close behavior outside capture. Associate local feedback through `aria-describedby`; use one status live region without repeatedly announcing every modifier update.

### The header stays put; the list scrolls

Today `body` scrolls, so the title, the hint and the tab strip leave the window as soon as the content is taller than it. The header and tabs become fixed and the section list gets its own scroll region, which is how a macOS settings window behaves and which keeps the "Recording in progress. Recording settings are locked." hint visible at the moment it matters most.

The window itself is resized to fit the grouped list without scrolling in the ordinary case, keeps `resizable` and its minimum size, and the content column gets a real maximum width so that a user who widens the window gets a centred column rather than rows stretched to the full frame. The current `max-width: 560px` inside a 460px window is removed as the dead rule it is.

### The lock says why, once per section

A disabled control at 50% opacity does not explain itself. While a capture is running, the Recording section's footnote states that recording settings are locked until the recording stops — the same sentence main already sends as `view.hint`, placed where the dimmed controls are rather than only at the top of a window that may be scrolled. Language stays enabled and needs no explanation; it is the one preference that never touches a capture.

Keep current in-place value/text updates and focus/scroll preservation. Rebuild only for structural changes and restore focus by element id with `preventScroll`. Apply the state rules above when collapsing capture; do not revert to rebuilding on every update.

### The renderer's test is the acceptance fixture, not a new DOM runtime

Use the existing [renderer tests](../src/renderer/settings.test.ts) for interaction logic and real Electron/native acceptance for visual results. Do not add tests that mirror CSS constants or another DOM runtime.

The panel's real test already exists: [`pnpm acceptance:settings`](../scripts/acceptance-settings.mts) drives the shipped page and preload in a real Electron window through [scripts/fixtures/settings-panel.ts](../scripts/fixtures/settings-panel.ts), and writes `panel.png`. That fixture asserts against today's DOM — `.row`, `select`, `#feedback` — so this plan must move each assertion to the new structure while keeping every behaviour it checks, and add cases for the switch, the segments and the inline failure. Its screenshot is the before/after evidence. Pure model additions (`control`, `section`, `noteKind`) are unit-tested in [settings-model.test.ts](../src/main/settings-model.test.ts) as ordinary data.

### Relationship to existing plans

020 has completed custom shortcut support. Completed [023](../docs/system-design/desktop.md#settings-shortcut) owns the global Settings shortcut and capture suspension; completed [021 screen selection](../docs/system-design/desktop.md#screen-preference-and-diagnostics) supplies the screen choice. 021 is closed; 022 is next. This plan delivers layout, focus and shortcut editing together, avoiding two rounds of styling. Preserve the existing shortcut cleanup and registration lifecycle.

## Expected experience

- Settings opens on a window whose header and tab strip stay put while the preferences below them scroll, with the tabs drawn as one segmented control.
- Recording shows a single grouped list: video quality and resolution cap as segmented and popup controls with their explanations beneath them, frame rate as a popup that still lists the unverified frame rate and still refuses to select it.
- General shows shortcut, notifications, updates and language as distinct sections; Notifications is a switch with Open notification settings… in the same section, and "Check for updates on launch" sits with Check for updates… under one Updates header.
- A change that does not take effect says so in the row that failed, in the panel's language, while the committed value stays displayed; screen-reader users hear it once.
- A shortcut the OS refused keeps its selection and its note, and the note is now announced when it appears.
- During a recording, recording preferences are dimmed and the section states why; Language stays usable; nothing about the panel can block starting, stopping or saving.
- Light and dark both follow the system, the focus ring uses the consistent app accent, keyboard-only operation reaches every control in visible order, and ⌘W still closes the window; Escape cancels capture first and otherwise retains its close behavior.
- Traditional Chinese and English both fit without truncation or a horizontal scrollbar, at the default window size and at the minimum size.

## Implementation order

First capture the pre-redesign baseline in both languages and schemes, including idle, focus, listening, error and locked states.

### 1. Contract and model

- [ ] Add `control`, `section` and `noteKind` to [settings-panel.ts](../src/shared/settings-panel.ts) as optional fields with documented defaults, so an older fixture view still renders.
- [ ] Declare them per group in [settings-model.ts](../src/main/settings-model.ts): switches for `notifications` and `updateChecks`, segments for `videoQuality` and `language`, menus elsewhere; one Recording section, and General sections for shortcut, notifications, updates and language.
- [ ] Mark the shortcut-refused, updates-result and notifications-off notes as `status`, and the quality explanations as `explanation`.
- [ ] Tests in [settings-model.test.ts](../src/main/settings-model.test.ts): each group's declared control and section, the note kinds, and that no group id, choice id, default or lock behaviour changed.

- [ ] Add structured current/historical diagnostics and model tests, keeping ordinary help separate; cover missing displays, missing sources, historical failures and recovery without changing diagnostic lifetime.

### 2. Stylesheet

- [ ] Rewrite [settings.css](../src/renderer/settings.css) around one token block: surfaces, borders, two text levels, radii, the app accent with light/dark pairs, and the macOS type scale.
- [ ] Build the section list, the row (label leading, control trailing, note beneath, stacked below the narrow threshold), the switch, the segmented control and the restyled popup.
- [ ] Keep the `forced-colors: active` escape hatch for all three control types, honour `prefers-reduced-motion` for any transition, and keep focus rings visible in both schemes.
- [ ] Implement shared refined focus tokens and shortcut keycap/capture-area styles following the macOS direction above.

### 3. Renderer

- [ ] Render sections and the three control types in [renderer/settings.ts](../src/renderer/settings.ts), each echoing the same group and choice ids it does today.
- [ ] Move the failure into the failing group's row and keep a visually hidden live region; wire `noteKind` to `aria-describedby` or a live note.
- [ ] Replace the two-tab keyboard arithmetic with index math over `view.tabs`.
- [ ] Preserve in-place updates and focus/scroll position; rebuild only for structural changes and restore focus by id.
- [ ] Update [settings.ts](../src/renderer/settings.ts), [settings.css](../src/renderer/settings.css) and, if needed, the presentation interface of [shortcut-capture.ts](../src/renderer/shortcut-capture.ts). Keep validation and registration in existing main/shared logic. Update both languages in [i18n.ts](../src/shared/i18n.ts).
- [ ] Implement one custom entry point, inline capture, cancellation, editing states and local feedback; manage focus and exit cleanup using the state table.

- [ ] Render distinct diagnostic icon/heading/reason/recovery guidance, separating current errors, history and ordinary help without depending on hover, color or notifications; preserve focus and accessible announcements.

### 4. Window

- [ ] Resize the window in [settings-window.ts](../src/main/settings-window.ts) to fit the grouped list, keeping `resizable` and a minimum size, and give the content a real maximum width.

### 5. Messages

- [ ] Add any new string — section headers, the locked-section footnote — to [i18n.ts](../src/shared/i18n.ts) in English and Traditional Chinese, with consistent placeholders. Reuse existing strings wherever the sentence already exists.

### 6. Acceptance fixture

- [ ] Update [scripts/fixtures/settings-panel.ts](../scripts/fixtures/settings-panel.ts) to the new structure, preserving every behaviour it already asserts: CSP and console cleanliness, the preload surface, the sandbox, first-render language, committed values, a disabled platform option, the refused-shortcut note, id-only IPC, pending-save ordering with an interleaved push, and the notifications card with its pane button.
- [ ] Add cases for the switch, a segmented choice, the inline failure and the tab segmented control.
- [ ] Keep `panel.png` and capture it in both languages and both colour schemes as before/after evidence.
- [ ] Update [renderer tests](../src/renderer/settings.test.ts) and the [settings fixture](../scripts/fixtures/settings-panel.ts) for one entry point, armed acknowledgment, candidate preview, Cancel/Esc/Tab, success focus restoration, error retry, focus-preserving pushes and locks. Retain failure/registration-recovery coverage; do not add unit tests that merely mirror CSS constants.

- [ ] Implement the General footer links, main-authorized fixed destinations and bilingual labels; verify keyboard access, external browser opening, opening failures, availability during recording and narrow layouts.
- [ ] Verify quick recovery appears only under the specified conditions and remains secondary; history and ordinary states do not gain redundant buttons.

### 7. Documentation

- [ ] Update the Settings window section of [desktop design](../docs/system-design/desktop.md#settings-window) and its [translation](../docs/zh-TW/system-design/desktop.md) for the control vocabulary, sections and inline failure.
- [ ] Run `pnpm check` and `git diff --check`.

### 8. Verify behavior

- [ ] Run `pnpm check`, `pnpm acceptance:settings`, `pnpm acceptance:shortcut`, `pnpm acceptance` and `git diff --check`. Fixture results do not substitute for native acceptance.
- [ ] Follow the [native computer-use acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) on the real app launched with `pnpm start:app`. Check for a user's active recording before rebuilding or quitting. Exercise keyboard-only input, pointer input, VoiceOver, consistent app colors with a non-default system accent, Increase contrast and forced colors where testable; list omissions.
- [ ] Open the real Settings panel through 023’s global shortcut, also verify tray access, and inspect both tabs.
- [ ] Check both languages and schemes at default and minimum window sizes in focus, listening, error and locked states. No clipping, overlap, horizontal scrolling or duplicate rings. Preserve before/after screenshots.
- [ ] Start a recording, open the panel, confirm recording preferences are dimmed with the stated reason and Language still works, then stop and save normally.
- [ ] Exercise custom/preset/Off and shortcut recovery after each exit path. With a test-owned recording, verify start → stop → save → playback and recording locks. Retain an explicit limitation if actual OS conflicts were not tested. Restore preferences and stop/save test-owned recordings.
- [ ] Record what was actually tested and what was not in the [verification record](../docs/verification/README.md), with the before and after screenshots.

- [ ] Reproduce 021 unplugged-selection feedback with notifications on/off: without hovering, identify the error, blocked recording and recovery path; reopening Settings preserves feedback and successfully choosing an available display clears it. Also cover source missing, historical failure, shortcut conflict and save failure; capture both languages/schemes at minimum size to verify help and diagnostics are visually distinct.

- [ ] Verify the complete recovery flow: Use Primary saves without capturing; success/failure, duplicate clicks, disappeared/superseded candidates, recording during save, focus after button removal, and current status versus retained history on reconnect. Concurrent source and save errors stay accurate; unresolved failures never show false success.
- [ ] In manual acceptance, have the operator identify the affected setting, current recording availability, next step and action outcome without hover or logs, then recover using the existing control or adjacent action. Record confusion and unnecessary steps as usability findings.

## Completion and boundaries

Completion requires a coherent macOS grouped layout, refined visible focus, one custom shortcut entry point, understandable editing states and predictable focus destinations, without shortcut or recording regressions. No new shortcut-management page is included. This consolidation updates the plan only; UI implementation and native acceptance remain pending.

No commit, push, tag or publication is authorized by this plan. Out of scope: any change to which preferences exist, their defaults, their ids or the lock rule; the tray menu, notifications and the first-run hint; a sidebar or a third tab; window vibrancy, a custom title bar or traffic-light positioning; an app-wide theme or a theme preference; animations beyond state transitions on the controls themselves; importing the website's palette; a DOM test runtime; and any claim of Windows or Linux acceptance. Do not change a user's stored preferences to produce a screenshot.

On completion, move the durable conclusions into [desktop design](../docs/system-design/desktop.md#settings-window) and the [verification record](../docs/verification/README.md), then follow [plan completion](README.md#completing-a-plan).

## Technical references

- [Apple: Settings](https://developer.apple.com/design/human-interface-guidelines/settings): grouping, section footnotes and what a settings window is expected to look like on macOS.
- [Apple: Toggles](https://developer.apple.com/design/human-interface-guidelines/toggles): when a preference is a switch rather than a list.
- [Apple: Segmented controls](https://developer.apple.com/design/human-interface-guidelines/segmented-controls): the count and label limits behind the at-most-three rule.
- [Apple: Typography](https://developer.apple.com/design/human-interface-guidelines/typography): the macOS text styles the type scale follows.
- [MDN: light-dark()](https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/light-dark): the scheme-aware colour function already in use.
- [MDN: accent-color](https://developer.mozilla.org/en-US/docs/Web/CSS/accent-color): tinting native checkboxes and radios with the app accent.
- [MDN: forced-colors](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/forced-colors): the escape hatch each custom control needs.
- [ARIA APG: Switch](https://www.w3.org/WAI/ARIA/apg/patterns/switch/) and [Tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/): the roles, states and keyboard behaviour the panel must keep.
