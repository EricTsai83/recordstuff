# 035 — Final round: maintainer-guided native acceptance

[English](035-guided-native-acceptance.md) | [繁體中文](035-guided-native-acceptance.zh-TW.md)

Status: planned, not executed. Created: 2026-09-25. This plan is permanently the **last queue item**, currently after 026–034, 037 and 038; see [order](README.md#order-and-status). Any later implementation/fix plans go before it, regardless of numbering. It is the last step before clearing the queue, not a request to begin testing now.

## Purpose and ownership

Cover every native operation left untested by the recording-failure UX change, then incorporate required native gaps remaining from preceding plans. Codex prepares the build, reversible environment and instructions; **the maintainer personally performs each native case at least once**. Codex records observations, correlates logs/artifacts and tracks failures. Unit tests, fixtures, scripted shortcuts or agent clicks do not replace the user's operations in this round.

Follow the artifact, evidence and cleanup rules in the [testing policy](../docs/testing.md), [acceptance guide](../docs/acceptance.md) and [native acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md). The maintainer operates the desktop in this plan. Lack of a computer-use desktop/tray target does not prevent manual acceptance; when Codex cannot observe the screen, label the user's report as manual observation, not tool observation.

Baseline: [failure UX verification](../docs/verification/history-2026-09.md#recording-failure-results--2026-09-25). The 589 unit tests and 86 Settings fixture cases do not prove native tray badges, native failure-result interactions or error-notification clicks. Those three previously blocked groups are decomposed below.

## Preparation

- [ ] Finish all other implementation/fix plans first. Reconcile final source, verification history and preceding plans' blocked/not-run lists into a final inventory with source, platform, trigger, expected outcome and evidence. Include every new required native gap; do not silently turn old waivers into passes or expand to every historical untested case.
- [ ] Reconcile the retained-result implementation with this matrix: individual failures and acknowledgements survive restart; pending becomes unknown and files are rechecked without promising playability. No scan of unrelated orphan files.
- [ ] Codex completes applicable automated checks and records revision/dirty diff, version, bundle path/hash, OS, display/audio and original preferences. Build a fresh signed macOS bundle with `pnpm start:app`; use the Windows launch procedure established by 034 rather than macOS runners.
- [ ] Prepare a dedicated temporary output folder and a bounded-capacity test disk image. Bound capacity/duration; never fill the system disk, change the user's original output-folder permissions or disconnect a device containing user data. Explain each fault, its isolated resource and restoration before triggering it.
- [ ] Codex prepares a reproducible recipe for each fault and names the production error path. If pending/unknown/overlapping failures cannot be produced reliably, prepare a clearly identified development test bundle using production result handling/UI, never direct DOM mutation. Controlled states prove native presentation, not real disk/capture faults. Any required test-support code becomes work before this final plan and receives review/checks before the maintainer operates it.
- [ ] Assign one desktop operator. Ask whether the maintainer is ready when this round actually starts; do not begin recording unannounced. No such confirmation is needed merely to create this plan.

## Guided procedure

Give one short step at a time using visible labels: **action now → expected observation → ask what appeared**. Wait for the user's response or observation before proceeding. Do not hand over a long checklist for unattended self-testing. A shared action may cover several cases, but record each separately. Request screenshots through normal conversation when useful; logs cannot prove badge appearance, focus, Finder foregrounding or banner delivery.

Allow at most 30 seconds for each UI state. Record failures/blockers with steps, observation and time instead of retrying indefinitely. Identify a bug before fixing it, rebuild after changes and repeat affected cases. Fix work stays ahead of this plan; do not remove the final acceptance plan while leaving follow-up fixes behind.

## Required cases: recording failure UX

The maintainer performs every applicable row. Record pass/fail/blocked/not run individually; none is pre-approved.

| ID | Native action and setup | Expected observation |
| --- | --- | --- |
| N01 | Start normally, then trigger a start failure using an isolated unwritable destination | One tray item with a distinguishable integrated warning; no second tray item; reason matches the fault |
| N02 | Right-click View recording failures with Settings closed, open on the other tab, and minimized | The same window opens/restores/foregrounds; newest unread result expands and receives appropriate focus; no notification inbox or duplicate window |
| N03 | Allow App/OS notifications, trigger a new failure, click its banner with another app foregrounded; also click a retained notification in Notification Center if available | Same result section opens, with no direct Finder action, relaunch or acknowledgement; record delivery/focus |
| N04 | Disable App notifications and trigger another error; separately leave App notifications enabled but deny them in the OS | Tray and result remain available without a banner; restore notification settings |
| N05 | Without Got it, open/close menus and Settings, inspect the result, dismiss the banner and wait | None of these acknowledges the failure |
| N06 | Keep an unread failure, restore the test environment and left-click to start/stop another recording | Left click still toggles; REC/recording icon takes priority; unread warning returns afterward; success does not clear it or falsely label the newest recording failed |
| N07 | Open the result during delayed failure cleanup | Observe actual REC disappearance and processing status; a stalled synchronous user-data write may delay repaint and must be recorded separately from slow media cleanup. No premature preservation claim/reveal, Got it disabled, folder/relaunch restrictions; identify controlled-build evidence if necessary |
| N08 | Cause genuine full-disk/write failure on a bounded independent test volume; separately cause a start failure with no content | Accurate reason and partial/empty result; only confirmed nonempty content is described as kept, with possible-unplayability warning; failure is not success |
| N09 | Show partial recording, observe Finder foregrounding/selection, attempt playback of a test copy | Correct file; actual playback result recorded; preserved does not imply playable/recoverable |
| N10 | Move/delete only the dedicated partial test file or unmount its stopped test volume, then reveal; also exercise unknown after close failure | Result changes to unknown, no stale preservation claim, visible action failure without dismissal; identify controlled presentation if close failure cannot safely occur naturally |
| N11 | Change output folder from the result, including selection/cancel; record again and inspect actual destination; inspect the action during recording | Successful selection takes effect, cancel retains settings, failure has visible feedback, recording/pending locks follow final contract; combine with 033 but record separately |
| N12 | On macOS use system UI to reproduce missing permission/relaunch-required; open Settings, restore permission and relaunch from the result | Correct OS destination and understandable recovery; pending cannot relaunch; restored historical errors offer relaunch only when current permission needs it; recording works afterward. Record/restore original permission, no global TCC reset; Windows has no macOS action |
| N13 | Click Got it on a settled result, reopen from tray; repeat confirmation/expansion using Tab/Enter/Space | Only that failure is acknowledged, section collapses but remains expandable, file remains, root cause is not claimed fixed, focus stays sensible |
| N14 | Replace unacknowledged A with B, including replacement between mouse-down/up and delayed A cleanup | B stays unread; A's action/completion cannot acknowledge/overwrite B. Use a labeled controlled bundle for otherwise unreproducible timing, with the maintainer operating native UI |
| N15 | Restart first with an unread result, then after acknowledgement; also test interrupted cleanup, moved files and reminder-save failure/retry | Unread badge/result survive; acknowledged result remains viewable without warning; no repeated OS notification or file deletion. Pending becomes unknown rather than processing forever; prior partial files are rechecked, including reconnect after temporary drive unavailability and acknowledgement during inspection. Failed persistence is visible and Got it clears the badge only after every record is durably acknowledged; unread and acknowledged entries can independently retry saving |
| N16 | Inspect result/technical detail in English/zh-TW, light/dark, minimum window size; operate/read the new section using keyboard and VoiceOver | Readable text/paths/actions/errors/disabled states, no horizontal clipping, long content scrolls, sensible focus/announcements; limited to this new section, not reopening all old waivers |
| N17 | If required Windows gaps remain from 034, guide the maintainer through three icon states, scale/theme/overflow matrix, left/right click and tooltip | Record against 034's final matrix. No Windows desktop means blocked, not macOS/preview substitution |
| N18 | Add other required untested native actions from final implementation-plan reports, including 036/037; then restore/exit | Each has provenance, steps, expected/actual and result; stop test recordings, restore preferences/permissions/output, close test UI, quit normally and verify App/helpers exited |

For N03, also click an older notification after a newer failure exists: it opens history at the newest unread result with identifiable time/reason and does not acknowledge it. N12 permission changes may require multiple restarts; confirm the same result survives and distinguish its historical reason from current permission status.

## Completion and records

- [ ] Record ID, platform/build, real-fault versus controlled-state trigger, maintainer action, expected/actual, evidence, disposition and follow-up. Reuse valid historical normal recording/playback evidence, but the native actions required above still need the maintainer's operation.
- [ ] Every applicable required case passes or the maintainer explicitly accepts named untested limitations. Missing tools, silence or automated passes do not complete a case. Never relabel blocked/not-run as pass.
- [ ] Preserve bilingual design/verification conclusions, failures/fixes and cleanup evidence. Separate development test-bundle evidence from normal-bundle evidence.
- [ ] After the maintainer confirms the round, follow [completion rules](README.md#completing-a-plan), update the queue and remove this plan and its translation as the last item. No automatic commit, push or publication.

Planning-only checks: links/anchors, command names, bilingual parity and `git diff --check`. No build, recording or native case was performed while writing this plan.

## Additional multi-failure history acceptance (still last; not performed)

- [ ] N19: Create two consecutive failures (A keeps a partial, B keeps no content). Inspect each time/reason/file action, late A cleanup without reordering, and both records after restart.
- [ ] N20: Acknowledge only the newest failure: tray warning/count remains for the older one; notification/menu entry focuses the newest unread record. Acknowledge all to clear the badge; successful recording does not clear history.
- [ ] N21: With isolated test data, fail reminder storage, restore write access, and Retry saving reminder. It remains unread and both records survive restart. Failed acknowledgement/removal must not appear successful.
- [ ] N22: Use mouse/keyboard to expand an older row, reveal its partial, and remove a reviewed row without touching media or other records. Cover both languages, minimum size, light/dark and focus. Use isolated data to check the 20-most-recently-reviewed retention limit (including acknowledging an old unread record) and no unread eviction.
- [ ] N23: Launch isolated userData with a v1 result, verify migration to a separate history file, then remove all records and restart without re-import. Check offline/reconnected storage and acknowledgement during startup inspection.

Codex prepares isolated data and guides one step at a time; the maintainer performs the native operations. Unit/Settings fixture results do not substitute for this round.

## Additional asynchronous storage and overlap acceptance (not performed)

Sources: [036 closure](../docs/verification/history-2026-09.md#plan-036-closure--2026-09-25) and [037](037-overlapping-recording-finalization.md). Keep this plan last; prepare final recipes from their actual implementations. 036 is implemented: result rows show a saving line while Got it/Remove waits for a durable save, failed saves retry automatically (2, 5, 15, then 30 seconds) and quit/relaunch offers Keep waiting/Stay while a write is in flight, or Retry/Stay/Exit without saving these reminders after a failed save. Its isolated `history` lifecycle fixture and Settings fixture cases do not substitute for N24–N26.

- [ ] N24: With isolated delayed history storage, operate Settings and start/stop recording while reminder persistence is pending. Inspect saving/failed/automatic-retry feedback, English/Chinese copy, per-row warnings, and readable identifiers. Recover storage; verify the latest history survives restart without acknowledging unread records.
- [ ] N25: Quit/relaunch with unsaved history, including while recording or media cleanup is pending. Test repeated requests, bounded waiting, Stay/Retry and safe resumption. Any implemented metadata-only exit option must clearly identify lost reminders and must never bypass pending media or an active publisher.
- [ ] N26: Launch with delayed history load/migration, create a new failure during load, and check both old/new records. Exercise storage failure and recovery (rejected and delayed writes) using labeled controlled tooling; no duplicate writers, overwritten history or misleading success. Record normal-bundle responsiveness separately from synthetic delay.
- [ ] N27: If 037 passes its measurement gate and is implemented, stop A and begin distinguishable B while A publishes; verify REC priority, separate saving status, completion/failure identity, notification suppression, media integrity and playback of both files. Record actual stop-to-next-start timings.
- [ ] N28: Keep A publication pending, stop B, try C; observe bounded waiting and preserved A/B media. Test safe slow/full/offline isolated storage scenarios, older-save failure and late events without disrupting B. Do not induce a real system-disk outage.
- [ ] N29: Quit/relaunch with active B and A pending publication, then with sealed B waiting behind A; repeat requests and verify safe exit/cancel, no premature saved claim and all outcomes. Restore test state, close test UI, quit normally and verify process cleanup.

If 037 is deferred at its measurement gate, retain that explicit decision and mark its overlap cases not applicable only because the feature was not implemented; do not report them passed. New required cases discovered during implementation must also be added here. The maintainer performs each applicable native operation with one-step guidance.

## Additional health-guard acceptance (not performed)

Source: [038](038-recording-health-guards.md). Prepare recipes from its final thresholds.

- [ ] N30: With a bounded test disk image as the output folder, record until the disk guard stops the recording. Observe the early-stop wording in the notification and log, play the saved file, and confirm no failure entry appears. Then, on an isolated output folder, force-quit the labeled bundle during a recording and relaunch: one interruption entry names the temporary file, reveals it while it exists, becomes unknown after the file is moved away, and does not repeat after acknowledgement or another restart.
- [ ] N31: Put the Mac to sleep during a recording, wake it, and record the actual outcome (saved, failed with a partial, or stuck) together with the suspend/resume log lines and any failure reason. This is evidence for a later stop-on-sleep decision, not a pass/fail gate; do not change behavior inside this round.
