# Remaining Work

[English](README.md) | [繁體中文](README.zh-TW.md)

Updated: 2026-09-25. This index lists unfinished plans, their order and their hard dependencies. A completed plan is removed; its closure record stays in [verification](../docs/verification/README.md) and its durable conclusions in [system design](../docs/system-design/README.md). Adopted decisions that bound the queue, such as no updater, no uninstaller, no native rewrite for size alone and macOS-only verification, are recorded in [design decisions](../docs/system-design/decisions.md) rather than repeated here; 034 is the one narrow exception to macOS-only verification, limited to Windows tray artwork and its necessary native acceptance. Releases follow [release automation](../docs/system-design/releases.md): the tag is the version and CI records each release back on main.

## Order and status

Every plan below is planned, not implemented. Current order: **030 → 031 → 032 → 033 → 040 → 034 → 037 → 035**.

Ordering rule: zero-risk cleanup, the prioritized history work and the data-loss guards came first and are complete; now audit fixes in their original order, then optional or measured work, and 035 last. Keep 035 last even when later-numbered implementation or fix plans are added: schedule those before it.

| Plan | Source | Scope |
| --- | --- | --- |
| [030 — Audio and synchronization evidence](030-audio-verification-evidence.md) | R1-8; R2-05 | Missing required RMS or sync evidence blocks success |
| [031 — Stable release pointers](031-stable-release-recording.md) | R2-04 | Release ordering is independent of recording |
| [032 — Update acceptance contract](032-update-acceptance-contract.md) | R2-06 | Stale runner expectations, not broken product controls |
| [033 — Output-folder recovery](033-output-folder-recovery.md) | R2-08 | Explicit folder action and feedback, not publication |
| [040 — Recording countdown and distinct tray states](040-recording-countdown.md) | 2026-09-25 maintainer request; Cap comparison | Configurable pre-recording countdown (default 3 seconds) with a transparent top-right digit and no box, capture prepared before the count and started at zero, cancel without a failure entry, and distinct busy and countdown tray icons of unchanged width |
| [034 — Windows system tray icons](034-windows-tray-icons.md) | Maintainer request | Windows tray artwork and its necessary native verification; visual drafts can proceed independently |
| [037 — Bounded overlapping finalization](037-overlapping-recording-finalization.md) | 2026-09-25 comparison; measurement gate | Measures first whether a safely separable stop delay justifies overlap; no gain has been measured yet |
| [035 — Guided native acceptance](035-guided-native-acceptance.md) | Final round | Codex prepares and guides one step at a time; the maintainer personally performs every remaining required native operation, including the untested failure-UX cases and the gaps collected from preceding plans. Tests or blocked status do not silently satisfy it |

Hard dependencies; everything else is scheduling:

- 037 depends on 025, 026, 029, 030, 036 and 038 (all but 030 complete), keeps 036's metadata quit phase after all media work, and reuses the writer backlog bound defined in 038.
- 040 changes the Recorder start phase that 038 (complete) extended and keeps its retained-disk-error rule; it precedes 034 and 037: 034's Windows artwork must cover the `busy` and `countdown` tray states, and 037's overlap must treat a counting-down session as active.
- 031–033 can run independently; 032 should precede any work that requires update acceptance.
- Before 030 closes, recording acceptance must explicitly retain channel RMS and requested sync measurements rather than trust only the overall verdict.

## Sources and evidence boundaries

- R1 is the first ten-bug audit and R2 the second eight-bug audit (2026-09-24). Round 2 merged five bugs into four existing plans and added three, without duplicate repair work. Reproduction conditions, repair contracts and evidence limits are embedded in the plans and do not depend on ignored local audit files.
- Cap comparisons in each plan are pinned to revision `ce785e705e79652adba4b8bf752669c4093499e0`; 037 and the closed 038 pin `26e1a6d882f311d10b5317e9e0d29babe4f6737e`; 040 pins `119edf04864b59abfc0d52f60bf77d7f33cfd2b8`. They are static comparisons of the inspected scope, not evidence that Cap handles these cases.
- The 2026-09-25 T3 Code/Cap architecture comparison contributed only 038 and the run id in the closed 029. Adopting Effect, a monorepo split, feature subdirectories under `src/main/` and settings-file backups were rejected to keep the app small.
- Slow-disk backlog remains an explicitly documented limitation; 037 evaluates bounded admission under contention, not a promise to eliminate sustained disk-throughput limits.
- The multi-failure history round (2026-09-25) was implemented without a standalone plan; its [record](../docs/verification/history-2026-09.md#multi-failure-history--2026-09-25) and 035's N19–N23 carry its remaining native cases.

## Closed plans

Closure records, newest first: [029](../docs/verification/history-2026-09.md#plan-029-closure--2026-09-25), [028](../docs/verification/history-2026-09.md#plan-028-closure--2026-09-25), [027](../docs/verification/history-2026-09.md#plan-027-closure--2026-09-25), [038](../docs/verification/history-2026-09.md#plan-038-closure--2026-09-25), [026](../docs/verification/history-2026-09.md#plan-026-closure--2026-09-25), [036](../docs/verification/history-2026-09.md#plan-036-closure--2026-09-25), [039](../docs/verification/history-2026-09.md#plan-039-closure--2026-09-25), [025](../docs/verification/history-2026-09.md#plan-025-closure--2026-09-25), [024](../docs/verification/history-2026-09.md#plan-024-complete-writes--2026-09-24), [023](../docs/verification/history-2026-09.md#plan-023-closure--2026-09-23), [022](../docs/verification/history-2026-09.md#plan-022-closure--2026-09-24), [021](../docs/verification/history-2026-09.md#plan-021-closure--2026-09-23), [020](../docs/verification/history-2026-09.md#plan-020-closure--2026-09-23), [019](../docs/verification/history-2026-09.md#plan-019-closure--2026-09-23), [018](../docs/verification/history-2026-09.md#plan-018-closure--2026-09-20), [017](../docs/verification/history-2026-09.md#saved-notification-timing--2026-09-20), [014](../docs/verification/history-2026-09.md#notification-lifetime-investigation--2026-09-20) and [012](../docs/verification/history-2026-09.md#plan-012-closure--2026-09-20). 013 and 016 are documented in [desktop design](../docs/system-design/desktop.md#recording-shortcut), [tooling](../docs/system-design/tooling.md) and the [verification record](../docs/verification/README.md). Each record preserves its untested cases and accepted limitations; this index does not reopen a closed plan.

All plan language versions live in this directory: English `<name>.md`, Traditional Chinese `<name>.zh-TW.md`.

## Completing a plan

Keep plans limited to unfinished work. Capture durable conclusions in [system design](../docs/system-design/README.md) and [verification](../docs/verification/README.md), update README/index and translations, then remove completed plans and their translations. Preserve failures and historical evidence; Git retains execution history.
