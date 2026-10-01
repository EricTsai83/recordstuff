# 060 — Settings visual coverage and Playwright cutover

[English](060-settings-playwright-cutover.md) | [繁體中文](060-settings-playwright-cutover.zh-TW.md)

Status: proposed, conditional on successful predecessors. Dependencies: 058's adopted harness and measurement contract, and [059's behavioral coverage](059-settings-playwright-behavior.md). This plan completes Settings migration and switches the default runner.

## Problem and scope

Behavioral migration alone cannot establish complete acceptance parity. Preserve the language/theme/size/state matrix, demonstrate full-suite behavior and timing, then make the new runner the default without duplicate builds or permanently running two suites.

CI expansion, website testing, shortcut-fixture migration and recording-runner migration are outside scope. Keep existing `pnpm check` CI. A future Electron UI CI plan requires a demonstrated graphical session, activation and cancellation/cleanup path on the actual runner; a browser mock is not equivalent evidence.

## Visual design

Inventory every existing screenshot/layout case and map it to a parameterized Playwright scenario. Preserve both languages, native light/dark themes, minimum/normal sizes, settings states, overflow, focus and history/failure presentation. Only consolidate a matrix cell when it traverses the same behavior and its distinct assertion is covered elsewhere; fewer screenshots alone are not evidence of improvement.

Use layout assertions for overflow, geometry and required control visibility. Keep required screenshots for visual inspection with stable case IDs/names. Do not introduce brittle cross-machine pixel baselines as part of this migration. Capture after observable state/theme readiness and the required frame observations, not a generic fixed sleep. Preserve activation-span checks for visual states whose rendering depends on active focus.

Use the verified reset strategy from 059 to avoid app restarts per matrix cell. Keep failure traces and essential screenshots in the default evidence mode; full diagnostic tracing is separately selectable. Screenshot/trace failures preserve prior results and retain their failure/blocked classification.

## Command and reporting design

All new command names below are proposed until implemented. Keep `pnpm acceptance:settings:playwright` for the new suite; temporarily provide `pnpm acceptance:settings:legacy` for equivalent comparison/rollback. Both require existing build output. The comparison builds once, then runs drivers serially against the same artifacts.

After full parity and performance verification, make existing `pnpm acceptance:settings` delegate to the new runner. Preserve its `--out` contract and 0/1/2 verdict semantics. Keep `pnpm acceptance:regression` as one `pnpm check`, one Settings suite and existing shortcut integration; no nested duplicate builds.

Audit consumers before changing report paths or schemas. Retain stable case IDs, partial results, not-run reasons, artifact/version manifest, activation spans and cleanup evidence; JSON/Markdown reports must distinguish assertion failures, blocked cases and cleanup defects. Keep the process-ownership guarantees established in 058.

## Implementation

- [ ] Complete the visual coverage map and migrate the language/theme/size/state matrix with layout assertions and required screenshots.
- [ ] Run the complete migrated Settings suite, inspect bilingual screenshots and account for all behavioral and visual coverage IDs.
- [ ] Compare equivalent old/new full Settings suites with 058's timing/evidence contract; run once each initially, then a bounded paired comparison only for an unexplained regression or borderline result.
- [ ] Switch default commands while preserving argument/report contracts, and verify complete regression plus runner failure/timeout/interruption/cleanup paths affected by the wrapper changes.
- [ ] Remove legacy driver/assertion code and the temporary legacy command after the final gate; retain shared bootstrap and any independently required fixtures. Record the legacy revision and evidence as the rollback reference.
- [ ] Update bilingual testing/tooling/contribution documentation with actual commands, family selection and the verified Electron/native evidence boundary.

## Verification and completion

Run `pnpm acceptance:regression` on the final revision; it includes TypeScript, Vitest and build, so do not duplicate them. Inspect required bilingual screenshots and compare the complete coverage map. Exercise changed runner failure/cleanup paths, including preservation of earlier cases on evidence-capture failure. Pure test-tooling changes do not require a new capture baseline; actual product/OS/runtime changes add applicable checks under the [testing policy](../docs/testing.md).

Required gate: complete behavioral/visual parity, security/IPC evidence retained, zero cleanup defects and no unexplained new failure. Full-suite median must not regress by more than 5% against equivalent legacy evidence; if an initial comparison is unclear, use the paired method from 058. Report absolute seconds and whole-regression savings, and identify whether the pilot's 20% target survives full-suite costs. A smaller final speed benefit must be stated accurately, including any maintenance benefit used to justify adoption.

If visual/reset/startup costs invalidate the gate, revise the implementation or keep the default legacy runner; do not switch merely because the pilot passed. Rollback restores the recorded runner/config revision without a product runtime change. After a successful cutover, restore the legacy runner from that revision if needed rather than maintaining duplicate implementations indefinitely.

Complete when the default command runs the entire required Settings coverage once, full regression and changed fault paths pass, screenshots are inspected, outcome/cleanup contracts hold and measured results are documented. No broader test-framework migration is implied.
