# Shared acceptance cases

[English](acceptance.md) | [繁體中文](zh-TW/acceptance.md)

Humans and AI use the same cases and evidence rules. Select the necessary cases using the [testing guide](testing.md); a UI-only change does not automatically require recording. Operate each native case with a project runner or Computer Use as [listed below](#scripted-runner-or-computer-use); for agent-run rounds use the [native acceptance skill](../.agents/skills/native-acceptance/SKILL.md). Scripted, manual and computer-use observations must be labeled separately.

## Prepare a round

Before any desktop takeover, follow the [readiness handoff](testing.md#confirm-desktop-handoff-before-testing): explain the round, request a reply such as “好了”, stop output and wait for that reply before beginning. Include the reply and scope in the report; a timed pause does not satisfy this step.

Record time, OS/architecture, source SHA and working-tree changes, artifact path, settings and existing app/recording state. During development, you may stop recordings and quit/restart/rebuild RecordStuff as needed without additional confirmation. For normal-bundle acceptance, build and launch with `pnpm start:app`, then verify the running process path. `pnpm open:app` is only for restarting the same artifact within the round. Signing prerequisites and specialized runners are in [tooling](system-design/tooling.md).

Development branches and uncommitted fixes may be tested with the matching revision's `pnpm start:app` artifact; record the commit, dirty state and content identity, dependencies, artifact path and bundle identifier, and the signing certificate's fingerprint. Post-merge and release acceptance uses the designated main commit or release candidate under the [release policy](system-design/releases.md). A branch name alone establishes neither artifact freshness nor signature validity.

For recording smoke, keep the display/audio environment stable and use [test-material.html](../scripts/test-material.html). Record source dimensions, quality/fps, browser, audio output/volume and material version. With manual/native operation, click the page's audio/fullscreen start control; the `pnpm acceptance` runner provides its own autoplay setup. A source-selection test must put the material on the selected source. The shortcut runner's primary-display setup may not cover a different selected source.

## Recording smoke and native cases

One short recording can supply several cases. Required recording smoke covers start/stop/save, media verification and playback. Tray state and Finder actions are additional native cases when affected, or part of an explicitly requested full basic native round. Running a shortcut script does not pass a tray-click case.

| Case | Action and expected observation |
| --- | --- |
| Launch / tray (native; `pnpm acceptance:tray`) | Open the menu; confirm idle/permission status and relevant actions. Check the intended app, not a duplicate or stale installed copy. Each state's menu follows one group order: state and its primary action (Start recording, Stop, Cancel recording; Change output folder… only while the folder is unavailable), unread failures, Open RecordStuff, then Quit RecordStuff, with no stray separators; registered shortcuts appear right-aligned; the output folder, Show last recording, reviewed failures and Show log are in RecordStuff, not the menu (2026-10-04). The runner compares each menu with the production model and these rules; light and dark menu bars, alignment and legibility are observed on its screenshots. The needsPermission menu stays with the maintainer, since reaching it means revoking permission |
| Start | Start through the selected real user path; confirm recording. Keep the moving material and alternating beeps playing for about 10–15 seconds |
| Recording UI (native; `pnpm acceptance:tray` for the recording menu) | Check affected recording state, available stop action and locked settings against current requirements |
| Stop / save | Stop once and wait for saved/idle; record the new MP4 path. Preserve Saving if observed; missing the brief transition alone is not failure |
| Saved recording entry (native; `pnpm acceptance:notification`) | Click the saved banner. Judge RecordStuff in front with its window focused and the recording's card focused in Recordings separately; retain a failure before trying an alternate route |
| Playback | Open that saved file; play and seek, observe content and advancing progress. Record whether subjective audio listening was actually possible. `pnpm acceptance:playback -- <file>` covers this in QuickTime Player except clicking its controls and listening ([playback check](system-design/tooling.md#playback-check)) |
| Media verification | Reuse the runner's report for the same file/scope, or run `pnpm verify` as below. Check every judged failure; an audio track alone is not proof of non-silent capture |

Unattended start/stop/save and integrity checks:

```bash
pnpm start:app
pnpm acceptance
```

The second command needs an idle app and normally quits it after saving and verification. Continue playback on the saved file without reopening RecordStuff. For manually recorded fixed material, create a new report directory and use:

```bash
pnpm verify -- /absolute/path/recording.mp4 --test-material --json /absolute/path/report-dir/verify.json
```

Keep output and exit code (1 for fail or incomplete, 2 for blocked). For the current audio contract, the Sample rate/channels check requires 48 kHz / two channels and the separate Channel energy (RMS) check requires RMS above −60 dBFS in both channels. This supports non-silence, not fidelity, channel separation, subjective listening or sync. Missing/n/a evidence is not passing evidence, and neither is a required check that is blocked (a missing tool) or incomplete (too few markers). `--test-material` reports sparse-beep bitrate without judging it; add `--screen` with actual source dimensions, or `--sync` only when that analysis is required and the material supports it. Detailed gates are in [tooling](system-design/tooling.md#measurement-pipeline-and-thresholds).

### Scripted runner or Computer Use

Operate each case by the [selection rule](testing.md#scripted-runner-or-computer-use) and label its evidence as scripted input, Computer Use observation or manual. Current coverage:

| Operation | Scripted runner | Left to Computer Use or the maintainer |
| --- | --- | --- |
| Start, stop and save by the global shortcut, with integrity checks | `pnpm acceptance` sends the registered key through System Events | The countdown and REC as they appear in the menu bar |
| Saved notification click → Recordings | `pnpm acceptance:notification` presses the banner through Accessibility and judges RecordStuff in front, its window focused and the recording's card focused ([notification acceptance](system-design/tooling.md#notification-acceptance)) | Banner readability; the card's outline |
| Settings entry by shortcut | `pnpm acceptance:settings-shortcut` sends ⌥⌘, through System Events and checks the callback; with `-- --observe` it also asserts through Accessibility the window in front with focus, Tab, an application menu without Reload or Developer Tools whose ⌘R and ⌥⌘I keep the focus, with ⌘C, ⌘A, ⌘M and ⌘Q bound, ⌘A then ⌘C copying the panel's text with the pasteboard restored, minimize and restore, close and reopen, and that the page fills the window with nothing clickable under the window controls, saving `settings-window.png`; `--quit` adds ⌘Q and the exit of every process | Appearance and legibility, judged from `settings-window.png` (this window, with its controls) and the background suite's pictures and baselines (`pnpm test:ui`: every language, appearance and size) |
| Settings window frame, a window another one deactivated, real shortcut registration refusal and window state, the recordings player's full screen on the display | `pnpm acceptance:recipe -- native-ui` (plan 066): `acceptance:settings-native` judges the frame and the focus border and a day rollover with another window in front; `acceptance:shortcut-native` Electron's real registration refusal, a real minimized window restored and focused by its callback, the close key and reopening; `acceptance:player` full screen covering the display and focus returning to Settings. The background suite covers everything else these screens do, without the desktop | Appearance of their screenshots; the maintainer's own judgment of full-screen playback |
| Playback | `pnpm acceptance:playback -- <file>` drives QuickTime Player ([playback check](system-design/tooling.md#playback-check)) | Clicking the player's own controls when a case requires it; listening |
| Deferred-quit notification | `pnpm acceptance:quit-dialog -- --language <en or zh-TW>` checks the signed fixture's lifecycle, delivery event and, through Accessibility, one banner from the round with the round's language text ([guided notice](system-design/tooling.md#guided-deferred-quit-notice)) | Whether the banner was visible, readable and untruncated |
| Tray menu: idle, countdown and recording in both languages, Start, Stop, Cancel recording, a second click, a left click that opens the menu, Open RecordStuff by keyboard and Quit RecordStuff | `pnpm acceptance:tray` right-clicks the real status item, compares each menu with the production model and judges the log and folder ([tray acceptance](system-design/tooling.md#tray-acceptance)) | Appearance, alignment and legibility on its screenshots; the needsPermission menu (revoked permission); a Start chosen after the state moved on, which macOS would not order through scripted input. Computer Use cannot reach the tray-only process (`-10005 timeoutReached`, as in the [033 round](verification/history-2026-09.md#plan-033-closure--2026-09-26)) |
| A long start (plan 065): the shortcut within the one-second grace and after it, a left click after it, the starting menu and Quit while starting | `pnpm acceptance:tray -- --long-start <run>` against a [controlled build](system-design/tooling.md#controlled-acceptance-build) whose `prepare=hold` keeps the start in starting, judged from the log, folder, failure history and starting menu | Appearance of the starting menu on its screenshot; a long start caused by a real capture request, which no build produces on demand |
| The prompt to bypass the private window picker | None, by design | Computer Use only, under the exception [below](#additional-cases-by-impact) |
| VoiceOver, appearance and legibility, subjective listening, sleep and wake | None | Computer Use observation or the maintainer as each case states |

On 2026-10-02 the maintainer allowed committed runners to operate RecordStuff's own tray menu, Settings window and menu items, under the limits [below](#additional-cases-by-impact). An operation no runner covers stays in the last column. Ad hoc automation that a maintainer authorizes for one round, as in the [035 repeat round](verification/history-2026-09.md#plan-035-repeat-round-after-045049--2026-09-28), does not extend to later rounds. A tray runner's click moves the real pointer, so its round still needs the desktop handoff.

## Additional cases by impact

| Impact | Observe |
| --- | --- |
| Layout / translations / appearance | Relevant languages, themes, minimum size, clipping and focus state; fixture screenshots suffice for layout within the represented environment, which shares the app's window frame and sizes; the window controls macOS draws over the page's corner appear only in the `settings-shortcut -- --observe` screenshot |
| Controls / settings persistence | Mouse and keyboard operation of changed controls; close/reopen and restart persistence; restore original preferences |
| Native settings entry | Another app frontmost, open Settings through the affected entry, inspect visibility/focus, close and reopen; script callback alone is insufficient. `pnpm acceptance:settings-shortcut -- --observe` covers the shortcut entry through Accessibility, and `pnpm acceptance:tray` Open RecordStuff from the menu by keyboard |
| Quality / source / output folder | Choose the affected option through UI, record, and compare actual dimensions/fps/source/destination with the selection |
| Recording locks / allowed changes | While recording, exercise the affected control and verify locking or continued capture as required; stop, save and play |
| Permissions / device recovery / shutdown | Exercise only affected/requested transitions; record refusal, recovery and saved output as applicable. Permission revocation and destructive fault setup need authorization for that specific action |
| Accessibility / OS presentation | Observe affected keyboard/focus behavior; use actual VoiceOver or OS contrast settings when those behaviors are required. DOM assertions cannot establish these outcomes |
| Countdown and tray states | With the default 3 s: hourglass, then the stopwatch without a title and the digit at the top-right of the recorded display, then the filled dot with REC; the item width changes only for REC. Cancel by a second click, the shortcut, Cancel recording and Quit: each returns to idle and leaves no file, failure entry or notification (`pnpm acceptance:tray` runs the second click, Cancel recording and Quit; `pnpm acceptance` the shortcut). A start that lasts beyond a second (plan 065) is cancelled the same way by the shortcut, a left click, Cancel recording, whose shortcut the starting menu names, or Quit, which exits at once; a second press within that second is ignored and logged (`pnpm acceptance:tray -- --long-start`). A text editor keeps keyboard focus while the digits run, and clicks pass through the digit. Off records without a digit; 10 s fits two digits. The digit's size suits each display: 14% of its shorter side, the same on a portrait display as on the same panel in landscape. With the countdown sound on (the default), one soft tick plays with each digit, the last a fifth higher, and none at zero or on cancel; the switch is disabled while the countdown is Off and locked during the countdown and the recording, and playback plus `pnpm acceptance` find no tick in the file. Whether it is audible and pleasant is judged by ear. Play each file and check the digit-region crops from `pnpm acceptance`: the digit never appears in the recording. Legibility over light, dark and photo content and the reduced-motion/transparency variants are judged by eye |
| Recording failure history (plan 047) | A normal Settings open shows no history in Recording or General. The Troubleshooting tab has two content tabs: Failure history (default) and Diagnostics and cleanup, which contains Diagnostic tools and a separately collapsed Reset and cleanup section. Mouse and arrow keys switch the content tabs without changing the sidebar selection; ordinary model updates and sub-tab switches preserve the cleanup disclosure state; it counts unread rows and clears the count as they are acknowledged; its rows are grouped by day, all initially collapsed, opening independently. View recording failures and an error notification select Troubleshooting and its Failure history content tab, then open only the newest unread row, focused and in view, without acknowledging it. Keyboard focus on a row draws a thin accent border around the record (1 px at 1×, 1.5 px on Retina), none after a click or while the window is inactive; each tab keeps its scroll position. The window title reads “RecordStuff” in both languages. Got it, removal and retry each log one line with the record ID and outcome |
| Sleep and keeping awake (plan 050) | During a countdown and a recording, `pmset -g assertions` lists a `PreventUserIdleDisplaySleep` assertion from RecordStuff, and it is gone after a save, a cancel, a failure and quit. Apple menu → Sleep during a recording, then wake: a normal `.mp4` is saved and plays, no failure row appears, and the saved notification with the sleep note shows after waking; a sleep during a countdown saves and shows nothing. Waking needs the maintainer's password or Touch ID, so the maintainer performs it |

Do not routinely reset TCC or claim first-time permissions, hardware removal, long-run stability, install/upgrade or subjective listening from other cases. One narrow exception, authorized by the maintainer on 2026-09-26: when a RecordStuff build under test starts capture, macOS may ask whether RecordStuff may bypass the private window picker and access the screen and audio directly. The round's executor may press Allow on that prompt through native computer use and record whether macOS accepted the input. If macOS ignores synthetic input, leave the prompt open and report it; do not work around it. The exception covers only that prompt for RecordStuff: never answer other permission prompts, change privacy lists in System Settings or edit TCC. A second decision, by the maintainer on 2026-10-02: committed project runners may operate RecordStuff's own tray menu, Settings window and menu items with CoreGraphics mouse and keyboard events and accessibility actions. They act only on the tested RecordStuff bundle, matched by its executable path and pid, on Finder and QuickTime windows the runner opens and on the test material; they open the status item's menu with a right-click, never with `AXPress`, which is a left click and starts a recording. They never answer permission prompts, open privacy lists in System Settings or edit TCC, and global kills, closing all windows and IPC or test hooks that bypass the native UI stay forbidden. The desktop handoff, lock, display-assertion, single-executor and cleanup rules apply to every such runner, and an executor never improvises this input outside a committed runner. Preserve reproduction steps when a case fails. After an authorized fix, rebuild and repeat affected cases, retaining the earlier result.

## Cleanup and evidence

Every complete app round, including failure/cancellation, saves recordings it started, stops material playback, restores preferences, closes owned test UI, normally quits the tested app and confirms process/helper exit. Keep the app closed for the next run. Never use global kill/close-all operations or delete existing user data. Isolated runners clean only their owned processes; the settings-shortcut command is an intermediate entry step, not a full round.

Record pre-existing player windows. Close only the test movie and any Open dialog created by closing it. Quit a player started for the test only if no user documents remain. No app window is not proof of process exit. If save completion or cleanup cannot be confirmed, record cleanup fail/blocked and remaining state; do not rebuild over that process or report full acceptance passed.

Agent-run rounds also release their owned Computer Use sessions, test tabs and REPL workers before handing back the desktop; follow the [tool cleanup workflow](../.agents/skills/native-acceptance/SKILL.md#computer-use-工具收尾). On macOS, `pnpm acceptance:cleanup-audit -- --owned-pid <PID> --output <run-dir>/tool-cleanup.json` performs a read-only final check of visible `Software Cursor` windows and explicitly supplied owned PIDs (repeat the flag for each worker). Exit 0 means that scope is clear, 1 means remnants including zombies, and 2 means inspection is blocked. Without PIDs it checks only known cursor windows. It does not close sessions or terminate apps. Preserve shared services and other sessions; report unresolved tool cleanup separately, including ownership-based exclusions. A REPL reset alone does not prove the cursor disappeared.

Use a unique directory under `docs/verification/measurements/`; do not overwrite prior runs. Save actual screenshots, scoped logs, media paths and runner reports. If tools cannot save a screenshot or hear audio, say so. These raw files are gitignored and unavailable in a fresh clone. Keep a durable conclusion in the [verification index](verification/README.md) and its linked history/release record when worth preserving. For team review, provide sanitized evidence through an agreed accessible attachment/artifact location; do not imply a local link is shared or automatically upload private recordings.

## Report template

Use pass / fail / blocked / not run for selected cases. Keep out-of-scope cases under exclusions as not applicable, with a reason. A waived required case remains not run. Report counts without combining exclusions with passes.

```markdown
# Acceptance — <date / scope>

- Environment: OS/architecture, display, audio output, browser/material version
- Source/artifact: SHA, working-tree changes, build command, bundle/process path
- Execution: manual / computer use / scripted; executor and selected cases
- Original settings and test files:

| Case | Action | Expected | Actual | Status | Evidence |
| --- | --- | --- | --- | --- | --- |

Checks: commands, exit codes, runner report locations; relevant skips
Exclusions: case → not applicable and impact-based reason
Required gaps: not run/blocked case → reason or explicit waiver
Cleanup: saved files, restored preferences, closed UI, final process state; owned Computer Use sessions/workers and cursor audit, unresolved remnants or exclusions
Conclusion: pass/fail/blocked/not-run counts, limited to the observed scope
Evidence availability: local only / accessible artifact location
```

Release acceptance additionally follows the [release guide](system-design/releases.md): record the clean candidate SHA, bind the intended tag to that SHA and write the versioned evidence summary. A later documentation commit is not automatically the tested app source. This guide does not authorize publication.
