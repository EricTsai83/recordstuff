# 065 — Let the shortcut and a click cancel a long start

[English](065-cancel-long-start.md) | [繁體中文](065-cancel-long-start.zh-TW.md)

Status: proposed; first in the queue, before 064, because 064 ends in a tagged release and this changes recorder behavior that would ship in it. Dependencies: steps 2–5 require the maintainer decision in step 1. Independent of the deferred 058–060 Playwright chain. Found by [plan 063](../docs/verification/history-2026-10.md#plan-063-closure--2026-10-02)'s stale-start case and raised by the maintainer on 2026-10-02.

## Problem and evidence

`Recorder.toggle()` ([recorder.ts](../src/main/recorder.ts)), which both the global shortcut and a left click on the status item call, starts when idle, stops when recording, cancels a countdown and returns without doing anything while the state is `starting` or `stopping`. The unit test `ignores clicks while starting and stopping` fixes this, and [recording design](../docs/system-design/recording.md#countdown) says "Clicks during starting and stopping stay ignored" and "repeated start toggles remain ignored until the countdown". The purpose is double-press protection: a second press of the start shortcut, or a double click, must not cancel the attempt it just began.

The tray menu's Cancel recording already works while starting: `cancelCountdown` accepts `starting`, cancels an attempt still opening the folder or preparing capture at once (no file, failure entry or notification), and turns one whose `record` was already sent (countdown Off) into the stop-on-start request. So during a start only the menu can cancel, and the shortcut and click cannot.

How long `starting` lasts, from the maintainer's retained log (2026-09-13 to 2026-10-02, 740 starts): median 291 ms, 95th percentile 399 ms. The longer ones:

- 1.1–9.4 s: a folder opening that hit the 8 s `DEFAULT_START_TIMEOUT_MS`, and a permission denial reported after display-source retries.
- About 120 s, twice on 2026-09-29: the screen-and-audio capture request stayed pending until `DEFAULT_CAPTURE_REQUEST_TIMEOUT_MS` (120 s) ended it with `capture_start_failed`. For those two minutes the tray said "Starting… Check for system permission prompts", and pressing the shortcut or clicking the status item did nothing. A quit during one such start waited the full 120 s (`capture request timed out after cancel (quit) was requested`).

Plan 063's stale-start case sent the shortcut 8 ms after the menu's Start; it landed in `starting` and was ignored. The log showed only `hotkey: CommandOrControl+Shift+1 pressed` and no line saying the press was ignored, so a user report of "the shortcut did nothing" cannot be told from a lost key in the log.

## Target

After a grace period from entering `starting`, a toggle (the shortcut or a left click) cancels the attempt exactly as the menu's Cancel recording does: before `record`, the attempt is cancelled with no file, failure entry or notification; after `record` (countdown Off), it becomes the stop-on-start request. Within the grace a press stays ignored, as today, and the log says so. `stopping` is unchanged. The recommended grace is 1 s: well above the 399 ms 95th percentile, so a normal start is never cancelled by a second press, and well below the long waits a person would try to escape.

## Steps

Each step is independently completable and leaves the documents consistent.

### 1. Measure, then the maintainer decision gate

- From the retained logs and one controlled reproduction, attribute each start over 1 s to its phase (opening the folder, preparing capture, or waiting for `started` after `record`), and measure how far apart two presses of the shortcut that the log shows as a double press actually were, so the grace rests on evidence.
- Ask the maintainer: (a) the grace (recommended 1 s; alternatives: cancel at any time while starting, or only while preparing capture); (b) whether the starting menu's Cancel recording and the tooltip then name the shortcut, as the countdown's do; (c) whether a quit while preparing should cancel at once instead of waiting for the capture request (recommended: record it as a separate follow-up, outside this plan). Record the decisions and the date in [recording design](../docs/system-design/recording.md#countdown).
- Rejected: record the decision, add only the log line for an ignored press (step 2's last bullet), and close this plan.

### 2. Recorder change

- In `toggle()`, while `starting`: if at least the grace has passed since the state became `starting` (measured on the Recorder's monotonic clock), call `cancelCountdown("toggle")`; otherwise log `recorder: session <id> toggle ignored while starting (<n> ms after the start)`. Keep `stopping` ignored, with the same kind of log line.
- Unit tests with a controlled clock: a press within the grace is ignored and logged; after the grace, a press while opening the folder or preparing capture cancels with no file, failure entry or notification and returns to idle with Show last recording kept; with the countdown Off, a press after `record` becomes stop-on-start and the recording is saved; a press 8 ms after the start (the 063 case) is still ignored; the shortcut and a left click take the same path.

### 3. Presentation (only as decided in step 1)

- If (b) was approved: the starting state's Cancel recording in `tray-model.ts` shows the registered recording shortcut as its right-aligned accelerator and the tooltip names it, in both languages, with the menu-model tests and plan 048's group rules unchanged.

### 4. A long start on demand for native checks

- A long start cannot be produced reliably on a normal bundle. Proposed: a `prepare=hold` fault in the [controlled acceptance build](../docs/system-design/tooling.md#controlled-acceptance-build) that holds the capture host's `prepared` reply until `release prepare`, so a start stays in `starting` for as long as needed.
- Proposed native case: against that build, press the real shortcut through System Events within the grace (ignored, logged) and after it (cancelled), and left-click the status item after the grace with the [tray driver](../docs/system-design/tooling.md#scripted-native-acceptance) (cancelled). Either a mode of `pnpm acceptance:tray` that runs with `--bundle`, `--log` and `--settings` pointing into the controlled run, or a small dedicated runner; the implementer chooses and records why.

### 5. Documentation

- Update the countdown rules in [recording design](../docs/system-design/recording.md#countdown) and its audit-hardening sentence, the shortcut paragraph in [desktop design](../docs/system-design/desktop.md#recording-shortcut), the countdown-and-tray case in [acceptance](../docs/acceptance.md#additional-cases-by-impact) and, if step 4 adds a fault or runner, the [tooling guide](../docs/system-design/tooling.md), all in both languages.

## Out of scope

`stopping` behavior; the 120 s capture-request timeout itself; a quit that waits while capture is being prepared, unless step 1 brings it in; permission prompts, System Settings and TCC; Windows.

## Verification and completion

Apply the [testing policy](../docs/testing.md) to each step's diff. Step 2 falls under the recording start/stop and global shortcut rows: `pnpm check` and one recording smoke on a fresh `pnpm start:app` bundle (`pnpm acceptance`, whose start and stop must be unaffected), plus `pnpm acceptance:tray` for the tray's cancel paths. Steps 3 and 4 add the menu checks and the controlled-build native case, including its failure and cleanup paths, under the desktop handoff. Registration is unchanged, so `pnpm acceptance:shortcut-layout` is not needed unless the diff touches it.

Completion requires: the decision recorded with its date; the shortcut and a click after the grace each shown to cancel a long start natively, with no file, failure entry or notification, and a press within the grace shown to be ignored and logged; the design documents and acceptance case updated in both languages. Record the outcome in the verification history, then follow [plan completion](README.md#completing-a-plan).
