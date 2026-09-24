# Remaining Work

[English](README.md) | [繁體中文](README.zh-TW.md)

Updated: 2026-09-24. v0.1.3 is published from tag `v0.1.3` with the simplified DMG; see [0.1.3 evidence](../docs/verification/releases/0.1.3.md). 013 and 016 are complete and removed; the recording shortcut and its unattended acceptance (`pnpm acceptance`) are documented in [desktop design](../docs/system-design/desktop.md#recording-shortcut), [tooling](../docs/system-design/tooling.md) and the [verification record](../docs/verification/README.md). Releases follow [release automation](../docs/system-design/releases.md): the tag is the version and CI records each release back on main.

017 is complete: saved-notification timing, two consecutive 15/15 runs, cancellation, overlap and playback checks are recorded in [verification](../docs/verification/history-2026-09.md#saved-notification-timing--2026-09-20).

014 is complete and removed: the maintainer accepted the bilingual 30/30 local notification matrix as plan completion. Historical uncertainty and untested cases remain documented in [verification](../docs/verification/history-2026-09.md#notification-lifetime-investigation--2026-09-20). Publication and public-build checks belong to a separately requested release.

012 is complete and removed: the [official website](https://record.ericts.com) is live, and the maintainer confirmed the launch and requested documentation-only closure on 2026-09-20. See the [verification record](../docs/verification/history-2026-09.md#plan-012-closure--2026-09-20) for the closure basis and historical verification scope. 018 is now complete.

## Order and status

Next: [024 — Complete recording writes before reporting success](024-complete-recording-writes.md). Planned, not implemented; adapt Cap’s complete-write/error-propagation contract and short-write regression approach to FileWriter.

Use R1 for the first ten-bug audit and R2 for the second eight-bug audit. Round 2 merges **five bugs into four existing plans and adds three plans**, without duplicate repair work. All remain planned, not implemented. Suggested order: **024 → 025 → 026 → 027 → 028 → 029 → 030 → 031 → 032 → 033**. Complete writes in 024 underpin 025/026; 029 depends on the terminal-event contract in 025. Other ordering is scheduling, not a hard dependency; 031–033 can run independently, and 032 should precede work requiring update acceptance. Before 030, recording acceptance must explicitly retain channel RMS/requested sync measurements rather than trust only the overall green verdict.

| Plan | Audit bugs | Repair scope / grouping reason |
| --- | --- | --- |
| [025 — Recording termination and safe exit](025-recording-finalization-and-exit.md) | R1-3, R1-4, R1-10; R2-01, R2-02 | Renderer final data/cause and main finalization share one terminal contract |
| [026 — Reject empty recordings](026-reject-empty-recordings.md) | R1-9 | Actual byte guard after complete writes; unchanged scope |
| [027 — Permission state and query lifetime](027-permission-state-and-query-lifetime.md) | R1-2, R1-6 | Permission reconciliation and underlying requests; unchanged scope |
| [028 — Settings window and shortcut lifecycle](028-shortcut-editing-lifecycle.md) | R1-1, R1-5; R2-03 | Window crash recovery and capture leases share ownership |
| [029 — Log identity and rotation-safe acceptance](029-recording-log-correlation.md) | R1-7; R2-07 | Correct event identity plus reliable reading and cleanup |
| [030 — Audio and synchronization evidence](030-audio-verification-evidence.md) | R1-8; R2-05 | Missing required RMS or sync must block success |
| [031 — Stable release pointers](031-stable-release-recording.md) | R2-04 | New: release ordering is independent of recording |
| [032 — Update acceptance contract](032-update-acceptance-contract.md) | R2-06 | New: stale runner expectations, not broken product controls |
| [033 — Output-folder recovery](033-output-folder-recovery.md) | R2-08 | New: explicit folder action and feedback, not publication |

Existing Cap comparisons remain in each plan, pinned to revision `ce785e705e79652adba4b8bf752669c4093499e0`. They are static comparisons of the inspected scope, not evidence that Cap handles the eight new cases. Round 2 reproduction conditions, repair contracts and evidence limits are embedded in the plans and do not depend on ignored local audit files. Slow-disk backlog remains an explicitly documented limitation and is not counted as a new bug or plan.

019 is complete and removed following the maintainer’s manual acceptance and the settings-flicker fix/regression checks. The existing Notifications overview → RecordStuff path is retained; historical findings and untested conditions remain in the [closure record](../docs/verification/history-2026-09.md#plan-019-closure--2026-09-23).

020 is complete and removed following the maintainer’s acceptance of automated verification. Actual OS conflict and notification banners remain explicitly untested; existing native recording/playback, 14 failure/restart assertions and cleanup evidence are preserved in the [closure record](../docs/verification/history-2026-09.md#plan-020-closure--2026-09-23).

023 is complete and removed; the maintainer requested final closure after the bitrate retest on 2026-09-23. Acceptance includes hybrid native entry, bilingual/capture/recording regression checks, 25 controlled integration assertions, three passing 30-second integrity retests and verified window cleanup. Historical failures and evidence limits are preserved in the [closure record](../docs/verification/history-2026-09.md#plan-023-closure--2026-09-23). 022 is also complete.

021 is complete and removed following maintainer manual acceptance: unplugged-target refusal, recovery by choosing Primary, direct reconnect recovery, and capture termination/save/playback/feedback after removal during recording. Error visibility improvements belong to 022; evidence limits and untested scenarios remain in the [closure record](../docs/verification/history-2026-09.md#plan-021-closure--2026-09-23).

022 is complete and removed with maintainer acceptance: the maintainer verified the mouse Confirm fix; the final footer credits the author on the left and places website/GitHub icons on the right. The maintainer explicitly waived remaining manual acceptance, retained as accepted untested limitations in the [closure record](../docs/verification/history-2026-09.md#plan-022-closure--2026-09-24). 024 is the next queued development plan.

018 local acceptance, public feed delivery and 0.1.3 publication are complete; see the [closure record](../docs/verification/history-2026-09.md#plan-018-closure--2026-09-20). Untested cases remain documented in verification.

Publishing is automated by tag push; installed-app updates stay manual. 018 adds a check that reports a newer version and links to it; it does not authorize downloading or installing an update from inside the app. Public release notes stay English-only; app UI and reader guides remain bilingual. Published release bytes must not be overwritten.

No dedicated uninstaller is planned: quit and move the app to Trash; user data remains unless separately removed. No native-platform rewrite solely for size reduction, Apple certification, Windows/Linux/Intel verification or expansion is scheduled. DMG size was explained by Electron's runtime cost; discussion alone does not create a rewrite project.

All plan language versions live in this directory: English `<name>.md`, Traditional Chinese `<name>.zh-TW.md`.

## Completing a plan

Keep plans limited to unfinished work. Capture durable conclusions in [system design](../docs/system-design/README.md) and [verification](../docs/verification/README.md), update README/index and translations, then remove completed plans and their translations. Preserve failures and historical evidence; Git retains execution history.
