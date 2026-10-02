# 063 — Script native acceptance operations; keep Computer Use for observation

[English](063-scripted-native-acceptance.md) | [繁體中文](063-scripted-native-acceptance.zh-TW.md)

Status: proposed; second in the queue, started only after 062 has closed, and 064 starts only after this plan closes. Dependencies: step 1 has none; steps 3–6 require the maintainer decision in step 2; step 6 follows [062](062-signed-notification-acceptance.md), which owns the deferred-quit notification runner. Independent of the deferred 058–060 Playwright chain, which covers the Settings fixture rather than the native menu bar. [061's closure record](../docs/verification/history-2026-10.md#plan-061-closure--2026-10-02) left native entry unmeasured, so order steps 3–5 by the cases they unblock rather than by measured cost.

## Problem and evidence

The [native acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) requires Computer Use for every native operation: starting the test material, opening the tray, starting and stopping from it, Show last recording and Finder, Settings visibility and focus, playback and quitting. Lines 81 and 125 forbid AppleScript, System Events or other automation from pressing the tray or other UI; the global shortcut is the only exception. The [acceptance cases](../docs/acceptance.md) mark tray, recording UI and file-location cases as native.

That rule makes these cases depend on a tool that cannot reach the app. Computer Use returned `-10005 timeoutReached` for the tray-only Electron process (`2026-09-19T1753-computer-use-window-probe`), and `Target.pressKey()` did not reach global shortcuts. Under that rule tray cases are blocked or left to a maintainer: [048](../docs/verification/history-2026-09.md#plan-048-closure--2026-09-28) carried the needsPermission menu, idle with an unread failure, a stale Start, a light menu bar and menu keyboard navigation into 035's N33a. The 035 repeat round reached those states only because the maintainer authorized ad hoc automation for that round; no runner can repeat it.

The same operations already work through scripted native input in this repository:

- **Tray.** In the 048 round, CoreGraphics right-clicks opened the real menus in every state, both languages and both appearances. The status item exposes only `AXPress`, which is a left click and starts a recording, so a menu is opened with a right-click, never with `AXPress`. In the [035 repeat round](../docs/verification/history-2026-09.md#plan-035-repeat-round-after-045049--2026-09-28) on 2026-09-28, by the maintainer's decision, Claude operated 32 native cases with CoreGraphics mouse and keyboard events, AppleScript and the accessibility tree, then read its own screenshots against the app log.
- **Notifications and Finder.** `pnpm acceptance:notification` presses the saved banner with `AXPress` through System Events and judges whether Finder is frontmost and selects the file.
- **Settings entry.** `pnpm acceptance:settings-shortcut` sends ⌘⌥, through System Events after checking the bundle process and registration. Visibility and focus are still left to Computer Use.
- **Playback.** `pnpm acceptance:playback` (commit `2ea706d`) drives QuickTime Player through AppleScript and judges duration, size, real-time playback, seeking, the picture after a seek and playback to the end. Only clicking the player's own controls and listening remain manual. The skill still asks Computer Use to press play (line 124), so it is out of date with the committed tooling.
- **Helpers.** `scripts/lib/shortcut-layout.mts` already posts CGEvents through `osascript -l JavaScript` with the ObjC bridge. `scripts/lib/desktop-session.mts` provides lock detection and the user-activity and idle assertions.

No document states when Computer Use, rather than a script, should be selected. [testing.md](../docs/testing.md) never names Computer Use. AGENTS.md routes all "native UI acceptance" to the skill, and the skill then requires Computer Use for operations that scripts already cover.

## Target model

Separate operating the UI from judging what is seen. Record three kinds of native evidence in reports and keep them distinct:

| Evidence | Meaning | Proves | Does not prove |
| --- | --- | --- | --- |
| Scripted native input | A runner posts real OS events (CGEvent, System Events key/press) to the tested bundle and asserts accessibility state, logs and files | The OS delivered the input; the native menu/window/Finder reached the expected AX state and the app reacted | Pixels, legibility, alignment, appearance, sound |
| Computer Use observation | An agent inspects screenshots or the live desktop and judges them | What a person would see in the captured frames | Anything the frames do not show; input delivery when it did not send the input |
| Manual | The maintainer operates or judges | Subjective listening, readability, password/Touch ID steps | Cases the maintainer did not perform |

Computer Use keeps the operations a script cannot or must not do: the macOS prompt to bypass the private window picker that the maintainer authorized on 2026-09-26 (Computer Use only, unchanged), clicking QuickTime Player's own controls when a case requires it, VoiceOver, and visual judgments of screenshots that runners save.

Scripted input stays inside these limits: only the tested RecordStuff bundle (matched by process path and pid), Finder and QuickTime windows the runner opens, and the test material. It never answers permission prompts, opens System Settings privacy lists or edits TCC. Global `killall`, closing all windows and IPC or test hooks that bypass the native UI stay forbidden. Existing desktop handoff, lock, caffeinate, single-executor and cleanup rules apply to every new runner.

## Steps

Each step is independently completable and leaves the documents consistent.

### 1. State the selection rule and align the skill with existing scripts

No decision is needed; this only describes current behavior and committed tooling.

- Add a "Scripted runner or Computer Use" subsection to bilingual [testing.md](../docs/testing.md) and [acceptance.md](../docs/acceptance.md): use a project runner when one covers the operation; use Computer Use for observation and for operations without a runner; label each kind of evidence separately. Reference it from AGENTS.md's native acceptance line instead of duplicating it.
- Update the skill: playback uses `pnpm acceptance:playback -- <file>`, and Computer Use only clicks the player's controls when required. Limit "Player cleanup" to that manual path. Keep its description and trigger conditions consistent with the new subsection.

### 2. Maintainer decision gate: scripted input on RecordStuff's own UI

Ask the maintainer whether runners may operate RecordStuff's tray menu, Settings window and menu items with CGEvent and accessibility actions under the limits above. Record the decision and its date in [acceptance.md](../docs/acceptance.md) beside the 2026-09-26 exception.

- Approved: amend skill lines 81 and 125 to allow project runners to do this, keeping the ban on agents improvising AppleScript, IPC or test hooks outside a runner. Continue with steps 3–6.
- Rejected: record the decision, keep tray cases on Computer Use or the maintainer, complete step 7 for what step 1 changed, and close this plan.

### 3. Tray driver library

Proposed location: `scripts/lib/tray-driver.mts`, with a JXA helper following `shortcut-layout.mts`.

- Locate the status item of the tested process only: verify the bundle path and pid as `acceptance:settings-shortcut` does, then read the item's AX position and size.
- Open the menu with a CGEvent right-click at that frame; never `AXPress` the status item. Read every menu item: title, enabled state, separator, accelerator (`AXMenuItemCmdChar` and modifiers) and order. Select an item with `AXPress` on the menu item; close with Escape. Support arrow-key navigation for the keyboard case.
- Bound every wait (30 s per UI state, as the skill does), honor cancellation and confirm the menu closed before returning. While a menu is open, an AppleScript `click` on a menu-bar item may block until it closes; prefer CGEvent plus AX reads, and confirm the behavior during implementation.
- Unit-test parsing and judgment against recorded AX dumps, with no desktop. Exercise the driver on a fresh bundle before any runner depends on it.

### 4. Tray acceptance runner

Proposed command: `pnpm acceptance:tray`, against a fresh `pnpm start:app` bundle or that bundle reopened with `pnpm open:app` while its runtime inputs are unchanged. Like `pnpm acceptance` since 061, judge only the running pid's own log session (`sessionBelongsTo`), waiting a bounded time for it after launch.

- Menu structure in idle, countdown and recording, in both languages: the group order, separators, Start in idle only, failures beside Settings…, greyed folder items while recording and right-aligned registered accelerators from [acceptance.md](../docs/acceptance.md). Compare the native menu with the production `tray-model` output for the same state, so the check covers the Electron-to-NSMenu boundary rather than restating the model.
- Start recording from the tray (log `state → recording`), Stop and wait for `saved`, Show last recording with the Finder foreground and selection checks reused from `notification-acceptance`, and Quit RecordStuff followed by a process-exit check.
- Countdown cancellation via a second click, Cancel recording and Quit: idle state, Show last recording kept, no file, failure or notification.
- The N33a states that 048 could not reach and the 035 repeat round reached only by ad hoc automation: the needsPermission menu and idle with an unread failure through [controlled builds](../docs/system-design/tooling.md#controlled-acceptance-build), a Start chosen after the state moved on, and menu keyboard navigation.
- Save a screenshot of each opened menu. Light and dark appearance, alignment and legibility stay a Computer Use or manual observation of those screenshots.
- Let one take serve several cases: when the round also needs a recording smoke, the tray Start/Stop take supplies `pnpm verify` and `pnpm acceptance:playback`, under the [testing policy](../docs/testing.md#keep-recording-rounds-short).

### 5. Settings native observation

After the existing callback check in `acceptance:settings-shortcut` (or a mode of it), assert through AX: the Settings window exists, is main and focused, and RecordStuff is frontmost. Then cover Tab moving the focused element, minimize (`AXMinimized`) and restore, close with the platform chord and reopen with a second send. Keep the callback-only result as its own evidence. Layout and visual review stay with the `acceptance:settings` fixture screenshots and optional Computer Use.

### 6. Notification banner text (after 062)

In the runner that 062 repairs, read the banner through NotificationCenter's AX tree: its language matches the round, and exactly one banner from this round appears. Truncation and readability remain a visual judgment. 062 owns that runner's signing and verdict layers; this step adds only the AX text evidence.

### 7. Restructure the skill around observation

Rewrite the skill so that the agent selects and runs the project runners, then reviews the saved screenshots and runner reports. Remove operations that are now scripted from the Computer Use section. Keep the permission-prompt exception, visual judgments (countdown, appearance, banner readability), player controls, VoiceOver and anything without a runner. Update the testing.md row for tray actions and native entry, the tooling guide and the acceptance case labels in both languages.

## Out of scope

Permission prompts other than the existing Computer Use exception, System Settings and TCC; sleep and wake, which need the maintainer's password or Touch ID; subjective listening and visual quality; the Windows tray exception (035 N17); the Settings fixture driver (058–060); and CI execution of desktop runners.

## Verification and completion

Apply the [testing policy](../docs/testing.md) to each step's diff. Steps 1, 2 and 7 are documentation and skill changes: check links, anchors, command names and translations, plus `git diff --check`. Steps 3–6 fall under the developer-script row: focused tests and `pnpm typecheck`, then exercise each changed runner on a fresh signed bundle, including failure, timeout, interruption and cleanup paths, under the desktop handoff.

On a runner's first real round, compare it once with an independent Computer Use or manual observation of the same states. A scripted pass that disagrees with what is visible is a driver failure, not a product pass. A missing Accessibility or Automation permission for the terminal is blocked, not bypassed.

Completion requires all of the following:

- Each tray, Settings-entry and Finder case in [acceptance.md](../docs/acceptance.md) names its runner or states why it stays with Computer Use or the maintainer.
- Reports label scripted input, Computer Use observation and manual evidence separately.
- No scripted pass is presented as visual or subjective evidence.
- The N33a states from step 4 are covered by the runner, or recorded with the reason they stay outside it.

Record the outcomes in the verification history and the durable rules in tooling and testing, then follow [plan completion](README.md#completing-a-plan).
