# 032 — Correct the update acceptance settings-lock contract

[English](032-update-acceptance-contract.md) | [繁體中文](032-update-acceptance-contract.zh-TW.md)

Status: planned, not implemented. Created: 2026-09-24. Execution order: see [queue](README.md#order-and-status).

## Scope, evidence and separation

R2-06 (P2). [assertNoUpdateActions](../scripts/acceptance-updates.mts) expects only language to remain enabled during recording, but the production settings model permits appearance and about too. Executing the actual assertion against real settingsView/trayModel recording snapshots fails on appearance. The full native runner was not run in that reproduction.

This is a separate runner contract bug, not 028's product shortcut/window lifecycle or 030's media evidence. Scope is update acceptance assertions, focused regression coverage and verification guidance. Do not lock working appearance/about controls merely to satisfy the stale test. No new Cap comparison applies.

## Implementation contract

- [ ] Define explicit expected group behavior from product intent: recording-affecting preferences and update actions remain locked; appearance, language and about remain available. Keep existing tray REC/stop checks and update-action suppression. Inspect individual action enablement as well as group flags where necessary.
- [ ] Extract/reuse the production runner assertion for direct testing. Drive it with actual settingsView/trayModel snapshots; do not generate expectations by copying the returned enabled flags. Unknown groups require an explicit policy decision rather than silently passing.
- [ ] Cover normal recording, wrongly unlocked capture/update controls, wrongly locked permitted controls and update-available variants. Cover relevant starting/stopping/idle/permission snapshots with their own intended state contracts; do not apply a recording-only REC assertion indiscriminately.
- [ ] Run the default recording segment through completion, including failure cleanup and restore. Preserve feed/update behavior and report the corrected assertion's scope without claiming browser/tray transport from instrumented snapshots.

## Required verification and exclusions

Run focused tests, `pnpm typecheck`, `git diff --check`, and actual `pnpm acceptance:updates` with its required fresh fixture build. Do not use --logic-only: the defective assertion is reached in the recording segment. Observe playback of its saved recording and record cleanup. Feed filtering/timeouts are unchanged, so the full feed matrix and a duplicate ordinary recording round are unnecessary unless app runtime changes too. Native UI work follows the acceptance skill. Update bilingual verification/tooling guidance where the asserted contract is documented.

## Completion and evidence handling

Follow [shared testing policy](../docs/testing.md) and [plan completion](README.md#completing-a-plan). Use the [native acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) for any required native UI round. Serialize shared builds; one desktop/audio/shortcut owner per round. Restore changed settings, close test UI, quit the tested app and confirm process exit; incomplete cleanup blocks the next round.

- [ ] Record checks/results, scope exclusions and required-but-unverified cases separately; mocked boundaries are not native proof. Missing prerequisites are blocked. Run `git diff --check` on the implementation.
- [ ] Preserve durable conclusions in bilingual design/verification docs, update both indexes, then remove this plan and translation only after completion. Do not commit, push or publish without a separate request.

Planning-only validation: relative links/anchors, command names, bilingual coverage and `git diff --check`; no App build, tests, launch or recording just to write this plan.
