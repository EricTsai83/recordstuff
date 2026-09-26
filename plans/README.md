# Remaining Work

[English](README.md) | [繁體中文](README.zh-TW.md)

Updated: 2026-09-27. This index lists unfinished plans, their order and their hard dependencies. A completed plan is removed; its closure record stays in [verification](../docs/verification/README.md) and its durable conclusions in [system design](../docs/system-design/README.md). Adopted decisions that bound the queue, such as no updater, no uninstaller, no native rewrite for size alone and macOS-only verification, are recorded in [design decisions](../docs/system-design/decisions.md) rather than repeated here; The Windows tray acceptance that the closed 034 carried into 035's N17 is the one narrow exception to macOS-only verification, limited to the tray artwork and its necessary native acceptance. Releases follow [release automation](../docs/system-design/releases.md): the tag is the version and CI records each release back on main.

## Order and status

Every plan below is planned, not implemented. Current order: **035**.

Ordering rule: zero-risk cleanup, the prioritized history work and the data-loss guards came first and are complete, as are the maintainer-requested shortcut follow-up 044, the last audit fix, 033, the faster recording rounds, 042, the recording countdown, 040, the Windows tray artwork, 034, whose native Windows acceptance moved to 035, and the measured finalization work, 037, which closed at its measurement gate: saving now links instead of copying, so no separable wait was left to overlap. Only 035 remains. Keep 035 last even when later-numbered implementation or fix plans are added: schedule those before it.

| Plan | Source | Scope |
| --- | --- | --- |
| [035 — Guided native acceptance](035-guided-native-acceptance.md) | Final round | Codex prepares and guides one step at a time; the maintainer personally performs every remaining required native operation, including the untested failure-UX cases and the gaps collected from preceding plans. Tests or blocked status do not silently satisfy it |

Hard dependencies: none remain; 035 follows every other plan.

## Sources and evidence boundaries

- R1 is the first ten-bug audit and R2 the second eight-bug audit (2026-09-24). Round 2 merged five bugs into four existing plans and added three, without duplicate repair work. Reproduction conditions, repair contracts and evidence limits are embedded in the plans and do not depend on ignored local audit files.
- Cap comparisons in each plan are pinned to revision `ce785e705e79652adba4b8bf752669c4093499e0`; the closed 037 and 038 pin `26e1a6d882f311d10b5317e9e0d29babe4f6737e`; the closed 040 pins `119edf04864b59abfc0d52f60bf77d7f33cfd2b8`; the closed 043 pins `40f44a803f0980fb7ed530f17d12b8fed40f6b5a`; the closed 041 pins `b2b6ae45d4cae303107b10a9df166d91caed7702` and reads Chromium at tag 152.0.7977.78. They are static comparisons of the inspected scope, not evidence that Cap handles these cases.
- The 2026-09-25 T3 Code/Cap architecture comparison contributed only 038 and the run id in the closed 029. Adopting Effect, a monorepo split, feature subdirectories under `src/main/` and settings-file backups were rejected to keep the app small.
- Slow-disk backlog remains an explicitly documented limitation; the closed 037 added no overlap and therefore no admission rule under contention.
- The multi-failure history round (2026-09-25) was implemented without a standalone plan; its [record](../docs/verification/history-2026-09.md#multi-failure-history--2026-09-25) and 035's N19–N23 carry its remaining native cases.

## Closed plans

Closure records, newest first: [037](../docs/verification/history-2026-09.md#plan-037-closure--2026-09-27), [034](../docs/verification/history-2026-09.md#plan-034-closure--2026-09-27), [040](../docs/verification/history-2026-09.md#plan-040-closure--2026-09-26), [042](../docs/verification/history-2026-09.md#plan-042-closure--2026-09-26), [033](../docs/verification/history-2026-09.md#plan-033-closure--2026-09-26), [044](../docs/verification/history-2026-09.md#plan-044-closure--2026-09-26), [043](../docs/verification/history-2026-09.md#plan-043-closure--2026-09-26), [032](../docs/verification/history-2026-09.md#plan-032-closure--2026-09-26), [031](../docs/verification/history-2026-09.md#plan-031-closure--2026-09-26), [041](../docs/verification/history-2026-09.md#plan-041-closure--2026-09-26), [030](../docs/verification/history-2026-09.md#plan-030-closure--2026-09-25), [029](../docs/verification/history-2026-09.md#plan-029-closure--2026-09-25), [028](../docs/verification/history-2026-09.md#plan-028-closure--2026-09-25), [027](../docs/verification/history-2026-09.md#plan-027-closure--2026-09-25), [038](../docs/verification/history-2026-09.md#plan-038-closure--2026-09-25), [026](../docs/verification/history-2026-09.md#plan-026-closure--2026-09-25), [036](../docs/verification/history-2026-09.md#plan-036-closure--2026-09-25), [039](../docs/verification/history-2026-09.md#plan-039-closure--2026-09-25), [025](../docs/verification/history-2026-09.md#plan-025-closure--2026-09-25), [024](../docs/verification/history-2026-09.md#plan-024-complete-writes--2026-09-24), [023](../docs/verification/history-2026-09.md#plan-023-closure--2026-09-23), [022](../docs/verification/history-2026-09.md#plan-022-closure--2026-09-24), [021](../docs/verification/history-2026-09.md#plan-021-closure--2026-09-23), [020](../docs/verification/history-2026-09.md#plan-020-closure--2026-09-23), [019](../docs/verification/history-2026-09.md#plan-019-closure--2026-09-23), [018](../docs/verification/history-2026-09.md#plan-018-closure--2026-09-20), [017](../docs/verification/history-2026-09.md#saved-notification-timing--2026-09-20), [014](../docs/verification/history-2026-09.md#notification-lifetime-investigation--2026-09-20) and [012](../docs/verification/history-2026-09.md#plan-012-closure--2026-09-20). 013 and 016 are documented in [desktop design](../docs/system-design/desktop.md#recording-shortcut), [tooling](../docs/system-design/tooling.md) and the [verification record](../docs/verification/README.md). Each record preserves its untested cases and accepted limitations; this index does not reopen a closed plan.

All plan language versions live in this directory: English `<name>.md`, Traditional Chinese `<name>.zh-TW.md`.

## Completing a plan

Keep plans limited to unfinished work. Capture durable conclusions in [system design](../docs/system-design/README.md) and [verification](../docs/verification/README.md), update README/index and translations, then remove completed plans and their translations. Preserve failures and historical evidence; Git retains execution history.
