# 070 — Focused test scope for faster code iteration

[English](070-focused-test-scope.md) | [繁體中文](070-focused-test-scope.zh-TW.md)

Status: planned; implementation not started. Created: 2026-10-08. Priority: next. Hard dependencies: none. Execute the steps in order under [the plan index](README.md).

## Goal and boundaries

For each edit, run the smallest set of checks that can detect regressions in the affected behavior and dependencies. Reduce unrelated work in the local edit–verify cycle while keeping meaningful assertions and complete CI/release coverage. Success means both fewer unrelated cases and a measurable reduction in feedback time, not simply fewer assertions.

This plan implements the low-risk selection rules already added to [the testing policy](../docs/testing.md). It changes test selection, developer commands, recipe descriptions and case granularity. It does not change product behavior, remove required native/capture evidence, increase desktop concurrency, weaken cleanup, replace production UI with a synthetic design, or introduce a monorepo, remote test service or automatic dependency-graph selector.

## Current evidence

- `pnpm check` combines all root type checks, all Vitest tests and a production build. Vitest can already select individual files; `pnpm test:ui` can select Playwright files/titles, but the convenient Settings recipe combines the full check with every background UI spec.
- `tests/ui/settings-matrix.spec.ts` exposes twelve language/theme/size cases. Each case internally runs ten states plus player/menu interactions, making a single tab or state difficult to select. Other specs also bundle several behaviors into one case.
- UI global setup requires the full `out/` page/preload set and compiles three hosts even for a focused selection. This is shared setup overhead, distinct from unnecessary test execution.
- Three passing Settings recipe reports from 2026-10-06 recorded approximately 1 s typecheck, 26–27 s unit tests, 2–3 s build and 210–215 s background UI. These are historical local measurements, not current guarantees. Sources: `docs/verification/measurements/2026-10-06T07-51-06-837Z-recipe-settings/report.json`, `2026-10-06T10-20-38-990Z-recipe-settings/report.json` and `2026-10-06T11-06-09-720Z-recipe-settings/report.json`. These ignored files are supporting evidence; the plan remains understandable without them.
- At planning start, the plan index said to keep `pnpm check` as every app change's final baseline, and recipe descriptions steered logic/Settings edits toward broad checks. The index is corrected while registering this plan; recipe descriptions must still be reconciled with the low-risk path.

## Selection contract

Selection starts from the task's diff, affected callers and shared dependencies. Do not treat unrelated pre-existing working-tree changes as part of the task. This separation does not justify reusing stale artifacts: anything executed must match the actual relevant runtime inputs.

Every selected check must answer a named regression question. Missing coverage calls for a relevant test or explicit limitation, not unrelated full suites. Shared changes select the union of their affected consumers; expand to a full suite only for a named cross-cutting risk, insufficiently bounded impact or an explicit task requirement. Manual selection is authoritative; file paths alone never establish impact.

The following are selection examples, not commands to run when writing this plan:

- Display copy: meaning, language/placeholder consistency; typecheck when typed keys/placeholders/calls change; affected rendered surface if wrapping can change. No unrelated logic, player, capture or all-theme matrix.
- One Settings tab's local spacing: that tab's relevant visual state/viewport. Build once when fresh rendered evidence needs it; no other tabs' interactions or full matrix by default.
- Isolated helper: relevant module tests and TypeScript checking; no UI/build without an integration reason.
- Settings persistence or IPC: affected production-main integration cases plus relevant model tests; native cases only if OS activation/frame/focus changes.
- Shared primitive/token: affected consumers and representative states; full visual coverage only when the shared impact warrants it.
- Recording, native shortcut delivery, permissions, signing, runtime dependencies: retain the affected high-risk checks from the policy. A focused background pass cannot establish capture or OS effects.

## Implementation sequence

### 1. Inventory selection units and define representative tasks

- [ ] Map existing unit/UI/native groups to behaviors and dependencies in one small, reviewable scope catalog. Start with Settings recording preferences, General, library, failures/troubleshooting, theme/layout, player, countdown and shortcut integration. Reuse filenames and stable case IDs; do not duplicate test bodies or build a second test framework.
- [ ] Separate visual rendering from interaction, persistence/IPC and real OS behavior. Record cases that currently mix these and shared consumers that require a union of scopes.
- [ ] Pick representative edits: copy, one-tab spacing, isolated helper, one persistence path and one shared token. List expected included/excluded cases before implementation. Use retained timings where available; do not rerun native/recording baselines for a test-selection change.

Deliverable: scope definitions, expected selections and an assertion/ID coverage inventory for the cases to split.

### 2. Provide a focused entry point with visible selection

- [ ] Add a minimal `pnpm test:scope` entry point (proposed, not yet available) that accepts explicit named scopes or test files and forwards supported filters to existing Vitest/Playwright runners. Support composing scopes without duplicate checks. Keep existing full-suite commands unchanged.
- [ ] Add a list/dry-run mode that reports exact files/cases, checks, required artifacts, build decision and exclusions before running; dry-run must not build or launch Electron. A filter can be used internally but selection must not depend on fragile prose in titles.
- [ ] Reject unknown scopes, unmatched filters and unexpectedly empty selections instead of reporting success or silently falling back to the full suite. Preserve test runner exit codes and blocked/cleanup outcomes.
- [ ] Build at most once when the selected cases need production `out/`. Do not rebuild for pure unit checks. Reuse only artifacts whose relevant inputs are proven unchanged; otherwise build. No new cross-task pass cache is required.
- [ ] Reuse existing typecheck projects where appropriate. Do not invent per-file TypeScript checks that miss imports/shared contracts. Measure their cost before investing in finer typecheck splitting.

Deliverable: one predictable local entry point; broad recipes remain explicitly broad. If direct existing commands are simpler for a particular task, they remain valid.

### 3. Split only cases that obstruct useful selection

- [ ] Refactor the Settings visual matrix so tab/state, language, theme and viewport are independently selectable; move player/menu behavioral sequences into dedicated cases. Use shared helpers/data, not copied assertions.
- [ ] Split other bundled cases only where a representative task needs a narrower selection. Do not atomize every assertion or add unnecessary Electron launches. Keep coupled steps together when state continuity is the behavior being tested.
- [ ] Preserve every existing meaningful assertion, ledger ID, production page/style/preload path and full-suite dimension. Compare old/new coverage inventories; changed test counts alone do not prove coverage retention.
- [ ] Keep reviewed snapshot coverage and baseline names stable where practical. Reorganized tests must not silently update baselines; visual differences require inspection. Full invocation still executes the entire retained matrix.
- [ ] Retain isolation and cleanup for each executed case. Do not parallelize desktop use or share mutable state across otherwise independent cases merely to improve timings.

Deliverable: a local General-tab change can be checked without running library/player/countdown cases, while a full invocation retains their coverage.

### 4. Align policies and recipes with the new entry point

- [ ] Update `AGENTS.md`, both testing guides, both contributing guides, tooling docs and the plan indexes. Remove contradictory blanket app baselines. Keep examples short: affected behavior → smallest check → expansion trigger.
- [ ] Update recipe purposes and document that `settings`, `check` and `acceptance:regression` are broad compositions, not defaults for every local edit. Do not silently narrow an existing command that CI or maintainers rely on.
- [ ] Require a brief task-local selection note and a brief result; no permanent report for every small edit. Stop after selected checks pass. Rerun only invalidated checks after a later edit.
- [ ] Keep current CI and release gates unchanged. A focused local result must state its scope and never be reported as full regression evidence.

Deliverable: instructions, commands and default agent behavior agree on minimal relevant scope.

### 5. Validate selection and measure the improvement

- [ ] Test meaningful selector behavior: unions/deduplication, unknown and empty scopes, filter forwarding, build necessity, child failure propagation and dry-run without side effects. Run the affected tool tests and type checks; fixture/host/teardown changes additionally need the existing drills under the testing policy.
- [ ] For the five representative tasks, inspect selected files/cases and confirm the named unrelated groups are absent. Execute useful representative focused runs on matching final inputs; record wall time, setup/build time and executed cases separately. These are checks of selection, not simulated product changes requiring new recordings.
- [ ] After the final UI split, run the full background suite once on one final build to establish coverage migration and cleanup. Run full root checks if impact reclassification requires them; do not repeat completed phases already covered by a composite. Intermediate edits use affected cases, not a full regression after every step.
- [ ] Compare focused and full timings on matching sources, artifact and environment. Reuse a full final migration run for this comparison. Aim for at least 50% less wall time for the representative local visual edit; report the measured result and remaining overhead if the target is missed, rather than repeatedly benchmarking until a favorable result appears. Pure unit scope must launch no Electron; copy-only static inspection must invoke no test runner.
- [ ] Optimize global setup/host compilation only if it materially dominates focused runs. This is a conditional follow-up within the plan, not a prerequisite for shipping useful selection. If changed, validate fixture boundaries and cleanup drills; do not discard artifact freshness or required production inputs to save setup time.

## Completion criteria and verification limits

Complete when the entry point and docs meet the selection contract, representative tasks exclude unrelated cases, split-case coverage is accounted for, the final migration checks pass and timings/limitations are recorded. A time target alone cannot excuse missing relevant assertions; missing tools/permissions are blocked, not not-applicable.

This work does not normally require signed packaging, a real desktop round, recording, audio/matrix or publication: no capture or OS input path changes are planned. If implementation reaches those boundaries, reclassify and add only their affected cases, following the readiness handoff and native acceptance skill. Background Electron checks remain background checks.

For this plan-writing task only: check relative links/anchors, existing versus proposed command names, bilingual consistency and `git diff --check`; no tests, build, app launch or recording.

At closure, save durable command/selection contracts in tooling/testing documentation, record coverage migration and timing evidence in verification with translations, update both indexes and remove the completed plan files under the repository's completion rules. Do not commit, push or publish without a user request.
