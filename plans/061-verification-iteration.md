# 061 — Optimize acceptance after pnpm check

[English](061-verification-iteration.md) | [繁體中文](061-verification-iteration.zh-TW.md)

Status: proposed. Dependencies: none. Execute before [058's Playwright pilot](058-playwright-testing.md); its measurements establish whether Settings UI migration addresses a material bottleneck.

## Problem and baseline

The objective is to shorten the acceptance work after `pnpm check`: Electron UI fixtures, native desktop actions, bundle rebuilding/signing, recording, playback and AI repetition of already-passed checks. Measure these paths first; do not assume their relative costs. TypeScript/Vitest/build internals are outside the optimization scope. Eliminating an accidental second `check` is in scope; reducing its coverage is not.

One local `/usr/bin/time -p pnpm check` run in this thread passed in **20.36 s**, with **93 files / 1353 tests** passing. Vitest reported **17.85 s**; the three Vite build stages reported **321 ms** in total. The remaining approximately **2.19 s** includes typechecking and command/tool startup, not separately measured typecheck time. This is a single observation, not a stable performance budget or proof of which later checks are slow.

Keep `pnpm check` as the final app-change baseline and keep required acceptance under the [shared testing policy](../docs/testing.md). No Vitest isolation changes, Electron upgrade, persistent test-result cache, automatic filename-only test selector or replacement of native capture evidence is needed for this plan. Playwright implementation remains in 058–060.

## Design

### Measure actual verification paths

Add lightweight timing/report support around existing runner orchestration, reusing process/environment helpers. Proposed support location: `scripts/lib/verification-timing.mts`; choose the smallest integration that exposes the needed data rather than building a new general test framework. Do not alter input delivery, record extra takes or add polling to the product just to measure it.

Record monotonic elapsed times, runner/phase, revision plus working-tree content identity, dependency versions, artifact identity, requested scope, outcome and cleanup. Include failed, blocked and interrupted attempts. Separate command startup, type/unit/build, packaging/signing, Electron fixture compile/launch, interactions, screenshots, media analysis and cleanup where the existing runner exposes those boundaries. Measure composite parent wall time and child phases without counting nested durations twice.

Distinguish machine execution time from AI orchestration gaps and desktop readiness wait when a session log provides those intervals. Missing intervals stay unknown; do not label them zero or infer them from tool output. Use the existing 20.36 s observation until a changed implementation or unresolved measurement question requires another baseline.

Measure the post-check portion of a Settings change (`acceptance:regression` minus its measured `check` phase), a native-entry/focus change, and a recording change. The logic-only path uses the existing `check` observation as a reference and does not need a new optimization benchmark. Prefer retained logs and required real development rounds. Run only a missing representative path; do not launch a full capture matrix or repeat recordings solely to create timing data. A controlled runner sample measures that runner, not the entire AI workflow.

### Optimize the five acceptance costs

| Path | Concrete investigation and change boundary |
| --- | --- |
| Electron UI | Measure Settings and shortcut integration separately: fixture startup, interactions/waits and screenshot matrix. Keep required final regression; expose existing scope selectors where safe. Replacing the driver or restructuring its cases belongs to 058–060. |
| Native desktop | Map each OS action to the changed requirement, use fixtures for controlled interactions and native observation for the actual OS boundary. Avoid repeating an unaffected native matrix. Group required cases within a round while preserving cleanup between complete rounds. |
| Build/package/sign | Inspect `scripts/start-app.mjs` and bundle consumers. Build/sign once for unchanged runtime inputs; subsequent rounds can reopen the verified same artifact via `pnpm open:app`. Do not reuse a stale bundle or bypass signing verification. |
| Recording/playback | Assign each take a question. Let one appropriate take satisfy smoke, affected behavior, media analysis and playback; inspect the same saved file. Retain duration-specific cases and real playback observation; automated media analysis cannot replace them. |
| AI repeat execution | Audit `AGENTS.md`, shared policy and relevant implementation/acceptance skills for full reruns after unchanged evidence or test/documentation-only follow-up edits. Record what passed and what changed; rerun only affected requirements, and stop once required evidence is complete. |

The result must name the costly path and its before/after required case set. An apparent gain from removing a still-required native or playback case is invalid. Keep desktop blocking, process cleanup and artifact freshness as technical invariants.

### Select once, validate once per relevant revision

Create a compact verification recipe from changed behavior, affected callers and the policy's combined rows. Record required checks, which composite command covers them, artifact requirements and justified exclusions. Keep human/AI selection aligned; filenames alone cannot decide impact. No new command may silently lower existing final acceptance requirements.

| Situation | Execution rule |
| --- | --- |
| Editing/debugging | Run focused tests/type checks to resolve the current question; these do not replace final required checks |
| Final revision | Run one covering composite where available, such as `pnpm acceptance:regression`, without first repeating its `check`/build children |
| Separate runners need `out/` | Build the final inputs once and consume that artifact serially; avoid wrappers that rebuild the same inputs |
| Native acceptance needs a signed bundle | Build/sign once for the matching final runtime inputs; source `out/` evidence cannot replace signed-bundle evidence |
| Later edit or review fix | Reclassify impact; invalidate affected evidence/artifacts and rerun applicable checks, not automatically the entire desktop matrix |
| Check failed or environment changed | Resolve the failure or uncertainty, then rerun affected scope; do not reuse it as passing evidence |

Reuse within a task is explicit and bounded by source/dependency/config identity, evidence scope, artifact and environment. A new edit may leave some unrelated evidence valid only when the affected callers/dependencies establish that it is unaffected, as permitted by the policy. Prefer rebuilding when artifact freshness cannot be established; timestamps or HEAD alone cannot prove freshness for an uncommitted working tree. Do not introduce a cross-task skip cache.

One recording may supply start/stop/save, media analysis and playback evidence when it meets all required cases. Reuse the same media analysis only with matching file/analyzer/options. Stop after required checks pass; extra reruns need an edit, failure, uncertainty or explicit additional requirement. Restore settings and preserve existing process cleanup/outcome contracts; speed is not a reason to remove them.

## Implementation

- [ ] Inventory the five post-check paths and their required cases, command expansion and artifact dependencies; identify repeated UI/native rounds, bundle rebuilds, recordings/playback or already-passed checks.
- [ ] Add lightweight timing at existing phase boundaries and produce a verification cost breakdown with outcomes/artifact identity; validate timing/output on controlled processes before using real acceptance.
- [ ] Define task-local recipes and evidence invalidation rules in bilingual testing/tooling/contribution documentation and concise repository agent instructions. Reference the shared policy instead of duplicating it; audit relevant implementation/acceptance skills for conflicting unconditional reruns.
- [ ] Remove confirmed redundant wrapper calls or rebuilds while preserving standalone command behavior and fresh-artifact validation. Limit changes to the measured orchestration problem; larger driver changes stay in 058–060.
- [ ] Verify the selected representative execution graphs and affected runner failure/interruption/cleanup paths, and compare equivalent before/after totals. Use retained evidence when valid; report missing timings rather than expanding unrelated acceptance.
- [ ] Publish the measured bottleneck ranking and the resulting 058 pilot scope. Proceed to 058 only if its UI migration can address measured cost, instability or failure-diagnosis overhead; otherwise defer that chain and retain the existing driver.

## Verification and completion

Use [impact-based checks](../docs/testing.md) for the actual implementation: focused tooling tests, `pnpm typecheck` for TypeScript, build before fixtures load `out/`, and execution of changed orchestration including failure/timeout/interruption/cleanup. Changed real input or recording orchestration requires that real path; report it blocked if prerequisites are unavailable. Instruction-only edits check commands/links/translations and whitespace, not desktop behavior.

Acceptance conditions: required coverage and evidence boundaries remain intact; selected recipes have no redundant final composite invocation or rebuild of identical artifact inputs; data distinguishes total wall time from nested phases/waits; and controlled failure or cleanup cannot become pass. Demonstrate the measured time saved for at least one confirmed duplicate/over-broad execution path, with equivalent coverage. If no such path exists, report that result and the actual cost ranking rather than claiming an improvement. Do not set an arbitrary percentage target before this baseline.

Deliverables are the five-path post-check cost breakdown, minimal timing support, verified acceptance recipes and confirmed orchestration fixes. The durable result supplies 058 with bottleneck priority and reusable measurement boundaries. Removing unnecessary verification can complete this plan independently of adopting Playwright; broader migration is not required.
