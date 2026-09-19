# 017 Saved Notification After Screen Capture Stops

[English](017-saved-notification-timing.md) | [繁體中文](017-saved-notification-timing.zh-TW.md)

Status: Planned; diagnosis supported by system logs, fix not implemented. Updated: 2026-09-20.

## Problem and evidence

Some saved notifications are accepted by macOS but never appear as banners. On 2026-09-20, NotificationCenter logs for `com.ericts.record` reported `resolutionReason: display shared` and `muted by DND suppression: silence`. One correlated case at 03:29:24 was added to history with `canDisplayWhileCenterIsClosed: false`. The test therefore had no visible notification to click. Electron's `show` event alone does not prove banner visibility.

Local diagnostic artifacts are under `docs/verification/measurements/2026-09-20-notification-diagnostics/`; the captured system log is `/tmp/recordstuff-notification-system.log`. These are local evidence, not durable repository dependencies; preserve relevant, privacy-filtered excerpts and case correlations in the verification record during implementation. Do not attribute all missing notifications to this cause without matching evidence. User desktop interaction contaminated a separate Chrome-foreground result; this does not explain system suppression or resolve the older undelivered-click failure in [014](014-finder-notification-focus.md).

The current capture host already stops media tracks before sending `stopped`; the main recorder then finishes writes and emits `saved`. The remaining hypothesis is that macOS notification suppression updates asynchronously after capture release. A missing track-stop call has not been established.

## Outcome and scope

Under ordinary notification settings that permit banners, completing a recording should produce one clickable saved notification after capture ends, without activating Finder until the user clicks. Keep saving and return to idle independent of notification presentation. Respect intentional Focus and screen-sharing suppression; do not change system settings or bypass them.

This plan covers notification timing and the minimum diagnostics needed to verify it. Finder activation remains in 014. No notification service, persistent queue, private macOS API, extra product permissions, or implicit bilingual test matrix is included. Implementation does not authorize committing, publishing, or pushing tags.

## Work, in order

1. **Establish the timeline.** Correlate successful and missing-banner cases across track release, host `stopped`, file finalization, notification request, system display-sharing state, suppression decision, and Accessibility visibility. Add only missing timestamps needed for this investigation. Record macOS/Electron versions and relevant notification settings. Preserve unmatched cases as unresolved.
2. **Choose the smallest supported fix.** Check whether a supported lifecycle/API signal can establish readiness; do not assume a JS track-stop acknowledgment proves the OS is ready. Correct any demonstrated ordering defect. If no suitable signal exists, evaluate a single bounded, macOS-only delay for the saved notification, justified by measured timings and before/after runs. Record the selected bound and its limitations; do not claim a fixed delay guarantees delivery. Avoid retry loops, duplicate notifications, delaying file writes/idle, or extending banner polling to hide suppression. Define pending-notification behavior for a new recording and app shutdown, with bounded cleanup and no notification during a new capture caused by an old timer.
3. **Keep diagnostics small and meaningful.** Distinguish notification requested, Electron show callback, banner observed, click callback, and Finder result. Retain the existing bounded Accessibility snapshots; collect narrowly filtered OS evidence on failure where available, without making system-log access a product requirement. Unknown causes stay unknown. A missing banner must remain visible in acceptance results, even when the runner's coverage threshold returns success.
4. **Verify the chosen behavior.** Add focused tests for the actual scheduling/order change, exactly-once delivery, shutdown/new-recording behavior, and notification failure not affecting saved files. Run `pnpm check`. Build the signed app with `pnpm start:app`, following the native acceptance skill and checking for an existing user recording before quitting/rebuilding.
5. **Run native acceptance and document the result.** With desktop interaction paused, run `pnpm acceptance:notification -- --install --full` against the local signed build twice consecutively (15 English cases per run: closed, behind, minimized Finder). Keep settings consistent with the reproduced failure. Check recording stop/save/playback and record what screen/audio behavior was actually verified. Test cancellation once while a notification is pending and verify bounded exit, no abandoned recording, and restoration of test-owned windows/settings/app installation. Record timing, verdicts and cleanup evidence; do not automatically rerun failures until green. Test the new-recording overlap explicitly. Language coverage is separate and only needed if notification text/matching changes.

## Completion criteria

- The chosen implementation and its OS limitations are documented with correlated before/after evidence; `shown` alone is never treated as proof of display.
- Both full runs complete with all 15 banners observed and clicked, correct saved-file selection and Finder foreground, no duplicates, and no unexplained missing cases. An exit code of zero with skipped/not-run cases is insufficient. External interference is reported separately and requires a controlled rerun.
- Saving remains correct, background completion does not steal focus, overlap/shutdown behavior is verified, and cancellation/cleanup finishes within the existing documented bounds.
- If suppression persists, retain this plan with the evidence and unresolved outcome rather than declaring a fix. Intentional OS suppression is documented as a limitation, not overridden.
- Update desktop design, tooling if commands or diagnostics change, and verification records in both languages. Follow the [plan completion rules](README.md#completing-a-plan), then remove this plan and translation. Public release remains separate work in 014 and requires explicit user instruction.
