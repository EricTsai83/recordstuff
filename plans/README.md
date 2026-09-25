# Remaining Work

[English](README.md) | [繁體中文](README.zh-TW.md)

Updated: 2026-09-25. This index lists unfinished plans, their order and their hard dependencies. A completed plan is removed; its closure record stays in [verification](../docs/verification/README.md) and its durable conclusions in [system design](../docs/system-design/README.md). Adopted decisions that bound the queue, such as no updater, no uninstaller, no native rewrite for size alone and macOS-only verification, are recorded in [design decisions](../docs/system-design/decisions.md) rather than repeated here; 034 is the one narrow exception to macOS-only verification, limited to Windows tray artwork and its necessary native acceptance. Releases follow [release automation](../docs/system-design/releases.md): the tag is the version and CI records each release back on main.

## Order and status

Every plan below is planned, not implemented. Current order: **026 → 038 → 027 → 028 → 029 → 030 → 031 → 032 → 033 → 034 → 037 → 035**.

Ordering rule: zero-risk cleanup and the prioritized history work came first and are complete; now guards that prevent data loss, then audit fixes in their original order, then optional or measured work, and 035 last. Keep 035 last even when later-numbered implementation or fix plans are added: schedule those before it.

| Plan | Source | Scope |
| --- | --- | --- |
| [026 — Reject empty recordings](026-reject-empty-recordings.md) | R1-9 | Actual byte guard after complete writes |
| [038 — Recording health guards](038-recording-health-guards.md) | 2026-09-25 T3 Code/Cap comparison | Disk-headroom stop, stalled-capture failure, bounded writer backlog, per-session interruption sentinel and sleep/wake logging, all through existing stop/failure paths; no new UI or recovery |
| [027 — Permission state and query lifetime](027-permission-state-and-query-lifetime.md) | R1-2, R1-6 | Permission reconciliation and one owned enumeration request |
| [028 — Settings window and shortcut lifecycle](028-shortcut-editing-lifecycle.md) | R1-1, R1-5; R2-03 | Close chord, capture lease separated from the setting transaction, and crashed-window recovery under one ownership |
| [029 — Log identity and rotation-safe acceptance](029-recording-log-correlation.md) | R1-7; R2-07; run id from the comparison | Session-keyed structured records, a per-launch run id, and a rotation-aware reader shared by waiting and cleanup |
| [030 — Audio and synchronization evidence](030-audio-verification-evidence.md) | R1-8; R2-05 | Missing required RMS or sync evidence blocks success |
| [031 — Stable release pointers](031-stable-release-recording.md) | R2-04 | Release ordering is independent of recording |
| [032 — Update acceptance contract](032-update-acceptance-contract.md) | R2-06 | Stale runner expectations, not broken product controls |
| [033 — Output-folder recovery](033-output-folder-recovery.md) | R2-08 | Explicit folder action and feedback, not publication |
| [034 — Windows system tray icons](034-windows-tray-icons.md) | Maintainer request | Windows tray artwork and its necessary native verification; visual drafts can proceed independently |
| [037 — Bounded overlapping finalization](037-overlapping-recording-finalization.md) | 2026-09-25 comparison; measurement gate | Measures first whether a safely separable stop delay justifies overlap; no gain has been measured yet |
| [035 — Guided native acceptance](035-guided-native-acceptance.md) | Final round | Codex prepares and guides one step at a time; the maintainer personally performs every remaining required native operation, including the untested failure-UX cases and the gaps collected from preceding plans. Tests or blocked status do not silently satisfy it |

Hard dependencies; everything else is scheduling:

- 026 and 038 build on the complete-write accounting from 024 (complete). 038 follows 026 because its early stop relies on the nonempty-file guarantee, and precedes the audit UI plans because it prevents data loss.
- 029 depends on the terminal-event contract from 025 (complete).
- 037 depends on 025, 026, 029, 030, 036 and 038 (025 and 036 complete), keeps 036's metadata quit phase after all media work, and reuses the writer backlog bound defined in 038.
- 031–033 can run independently; 032 should precede any work that requires update acceptance.
- Before 030 closes, recording acceptance must explicitly retain channel RMS and requested sync measurements rather than trust only the overall verdict.

## Sources and evidence boundaries

- R1 is the first ten-bug audit and R2 the second eight-bug audit (2026-09-24). Round 2 merged five bugs into four existing plans and added three, without duplicate repair work. Reproduction conditions, repair contracts and evidence limits are embedded in the plans and do not depend on ignored local audit files.
- Cap comparisons in each plan are pinned to revision `ce785e705e79652adba4b8bf752669c4093499e0`; 037 and 038 pin `26e1a6d882f311d10b5317e9e0d29babe4f6737e`. They are static comparisons of the inspected scope, not evidence that Cap handles these cases.
- The 2026-09-25 T3 Code/Cap architecture comparison contributed only 038 and the run id in 029. Adopting Effect, a monorepo split, feature subdirectories under `src/main/` and settings-file backups were rejected to keep the app small.
- Slow-disk backlog remains an explicitly documented limitation; 037 evaluates bounded admission under contention, not a promise to eliminate sustained disk-throughput limits.
- The multi-failure history round (2026-09-25) was implemented without a standalone plan; its [record](../docs/verification/history-2026-09.md#multi-failure-history--2026-09-25) and 035's N19–N23 carry its remaining native cases.

## Closed plans

Closure records, newest first: [036](../docs/verification/history-2026-09.md#plan-036-closure--2026-09-25), [039](../docs/verification/history-2026-09.md#plan-039-closure--2026-09-25), [025](../docs/verification/history-2026-09.md#plan-025-closure--2026-09-25), [024](../docs/verification/history-2026-09.md#plan-024-complete-writes--2026-09-24), [023](../docs/verification/history-2026-09.md#plan-023-closure--2026-09-23), [022](../docs/verification/history-2026-09.md#plan-022-closure--2026-09-24), [021](../docs/verification/history-2026-09.md#plan-021-closure--2026-09-23), [020](../docs/verification/history-2026-09.md#plan-020-closure--2026-09-23), [019](../docs/verification/history-2026-09.md#plan-019-closure--2026-09-23), [018](../docs/verification/history-2026-09.md#plan-018-closure--2026-09-20), [017](../docs/verification/history-2026-09.md#saved-notification-timing--2026-09-20), [014](../docs/verification/history-2026-09.md#notification-lifetime-investigation--2026-09-20) and [012](../docs/verification/history-2026-09.md#plan-012-closure--2026-09-20). 013 and 016 are documented in [desktop design](../docs/system-design/desktop.md#recording-shortcut), [tooling](../docs/system-design/tooling.md) and the [verification record](../docs/verification/README.md). Each record preserves its untested cases and accepted limitations; this index does not reopen a closed plan.

All plan language versions live in this directory: English `<name>.md`, Traditional Chinese `<name>.zh-TW.md`.

## Completing a plan

Keep plans limited to unfinished work. Capture durable conclusions in [system design](../docs/system-design/README.md) and [verification](../docs/verification/README.md), update README/index and translations, then remove completed plans and their translations. Preserve failures and historical evidence; Git retains execution history.
