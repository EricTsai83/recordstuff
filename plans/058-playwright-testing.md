# 058 — Playwright Electron foundation and pilot

[English](058-playwright-testing.md) | [繁體中文](058-playwright-testing.zh-TW.md)

Status: deferred by the maintainer on 2026-10-02, after [061's measurements](../docs/verification/history-2026-10.md#plan-061-closure--2026-10-02): the Settings fixtures were the largest post-check cost (settings 55.29 s, shortcut integration 37.89 s; this chain migrates only the first), every case passed, and no diagnosis problem was observed, so no adoption condition was met. Resume only between two plans of the queue or after it, never during one, and only when one holds: step 0 below shows driver-attributable time that the legacy driver cannot remove, or Settings acceptance shows failures that are hard to reproduce or diagnose. Dependencies: 061's recipes and timing support ([verification recipes and timing](../docs/system-design/tooling.md#verification-recipes-and-timing)); extend those boundaries into the fixture instead of duplicating instrumentation. This plan replaces the foundation and pilot portion of the original 058; follow-ups are [059 — behavioral migration](059-settings-playwright-behavior.md) and [060 — visual coverage and cutover](060-settings-playwright-cutover.md).

## Problem and scope

The Settings fixture combines setup, input, assertions and screenshots in one long run. Fixed settling waits and custom coordinate input can waste time and complicate failure diagnosis. Introduce a small Playwright Test pilot to verify compatibility, equivalent evidence and measurable benefit before migrating the complete suite.

Static assessment is based on revision `1108b031a317a1a2e12e1567c7edc34d1529cddf`; recheck the source and locked Electron/Node versions before implementation. Keep Vitest for logic/DOM tests and existing native acceptance for OS behavior. This plan changes test tooling only. Product runtime, Electron upgrades, website tests and other acceptance runners are outside scope.

## Design

| Component | Responsibility |
| --- | --- |
| Proposed `playwright.config.ts` | Electron specs only; `workers: 1`, full parallelism disabled, `retries: 0` |
| Proposed `tests/electron/*.spec.ts` | Pilot input and assertions; outside Vitest's `.test.ts` include |
| Proposed `tests/electron/support/` | Typed Electron launch, page selection, state control and evidence fixtures |
| Proposed `scripts/acceptance-settings-playwright.mts` | Environment, desktop status, bounded execution, verdict and owned-process cleanup |
| Test-only Settings bootstrap | Load built `out/renderer/settings.html` and `out/preload/settings.js`; supply controlled main-process IPC and save gates |

Use a pinned, runtime-verified Playwright development dependency and the existing pnpm lockfile. Use the repository's Electron executable; unrelated browser engines are unnecessary. Explicitly typecheck config/support/specs while preserving the renderer's Node-free type boundary.

Extract the minimum reusable bootstrap from `scripts/fixtures/settings-panel.ts` while keeping the legacy suite working. Test controls stay in fixture main code, outside shipped bundles and `window.settings`. Preserve CSP, sandbox, context isolation, Node isolation and web security. Select Settings by URL and readiness, not by assuming the first window is Settings. Keep native-theme propagation rather than overriding system appearance with browser emulation.

Use role/label locators or stable existing IDs and actual Chromium mouse/keyboard input. DOM evaluation is appropriate for geometry, node identity and diagnostics. Replace synchronization sleeps with observable readiness or bounded assertions; retain deliberate fault delays and observation windows. Hold deterministic gates to inspect transient states rather than allowing retrying assertions to see only a later settled state. Release gates in teardown.

Keep activation-span judgement from `scripts/lib/settings-activation.mts`: element actionability and DOM focus do not prove macOS activation. Preserve lock detection and not-run reasons. Runner outcomes stay 0 = pass, 1 = fail, 2 = blocked; skipped Playwright tests alone cannot establish a blocked verdict. Report cleanup defects independently, including on a blocked round.

Normal teardown closes the owned Electron app, then verifies main/helpers exited. Reuse `runIsolatedProcess` only after proving Playwright-launched descendants remain in the owned process group; otherwise add verified process-tree ownership tracking. Bound failure cleanup and never target unrelated Electron processes. Save partial case results before screenshot/trace capture so evidence failure does not erase earlier outcomes.

Explicitly manage tracing on `electronApp.context()` in the custom fixture; standard `{ page }` tracing settings must not be assumed to cover it. Store results, timing, errors, activation spans, required screenshots and cleanup in unique directories under `docs/verification/measurements/`. Verify failure-trace retention, including usable evidence around renderer crashes. Measure the default evidence mode; full tracing may be a separate diagnostic option.

## Implementation

Step 0 decides whether the rest runs; it changes no driver.

- [ ] **0. Measurement gate.** Report the legacy settings fixture's phases through `RECORDSTUFF_TIMING_FILE`: compilation, Electron launch, each case family, fixed `settle()` waits, theme/size switches and `capturePage()` screenshots. Run `pnpm acceptance:recipe -- settings` once and classify each wait as synchronization, fault injection or observation. If synchronization waits dominate, replace them with observable readiness in the legacy driver, rerun the recipe once, record the before/after, close this plan as rejected and cancel 059–060. Continue only when driver-attributable time remains at least 20% of the fixture's after that change, or a recorded failure needed a trace the legacy driver cannot give. Record the decision in the verification history.
- [ ] Inventory pilot cases, reusing step 0's wait classification; assign stable coverage IDs and map assertions, inputs, IPC/security boundary and language/theme/size cells.
- [ ] Add test dependency, typecheck/config, minimal bootstrap, outer runner and explicit custom Electron fixtures. Add the proposed `pnpm acceptance:settings:playwright` entry with a pilot selection; it requires existing build output and is not available before implementation. Existing default commands keep running the legacy suite.
- [ ] Verify locked-runtime launch, argument parsing, page selection, production security settings, IPC and native theme. Official Electron support remains experimental; do not weaken production security or change fuses to make the driver launch ([Electron API](https://playwright.dev/docs/api/class-electron)).
- [ ] Cover normal exit, assertion failure, timeout, interruption, launch failure, renderer crash, screenshot/trace failure and lock/activation classification through real runner drills or controlled tests as appropriate. Verify owned-process exit, isolated data and preserved partial results.
- [ ] Implement representative startup/security, tab keyboard navigation, committed/rejected save, held save plus older push, one history/failure action and activation-sensitive focus case. Cover both languages and representative light/dark minimum-size cells.
- [ ] Compare equivalent old/new pilots on identical unchanged app artifacts, machine and evidence settings; record a dependency/artifact manifest and per-phase timing.

## Measurement and adoption gate

Time startup, fixture compilation, interactions, screenshots/reporting and cleanup separately. Also record `pnpm check` and whole regression time; UI savings cannot be presented as equivalent whole-pipeline savings. Overall gain depends on the migrated layer's share of total time and its measured saving, including added overhead.

Use the `settings` recipe (`pnpm acceptance:recipe -- settings`) as the baseline so orchestration savings are not attributed to Playwright. Use one warm-up per driver, then five alternating paired measurements, with retries off. Record every failed/blocked attempt and its cause separately; blocked attempts are not passes. Report median and maximum valid times, first-attempt outcomes and cleanup. Five samples per driver do not establish a precise p95 or rare-flake rate. Diagnose unexplained failures or borderline results with a bounded additional comparison.

Target: at least 20% lower pilot median with equivalent evidence. Required adoption conditions: preserved coverage/security/IPC, no new unexplained failure and zero cleanup defects. If the speed target is missed, adoption may still be justified by reproducible failure-localization improvement or removal of custom interaction/report machinery, with median regression no greater than 5%; document that as a maintenance benefit. If neither branch passes, retain the legacy driver and pursue targeted wait improvements. Do not proceed to 059/060 after a rejected pilot.

## Verification and completion

Apply the [testing policy](../docs/testing.md): focused tooling tests, `pnpm typecheck`, build before loading `out/`, pilot success/failure/cleanup paths, and legacy Settings acceptance after shared fixture changes. Inspect pilot screenshots. Product/runtime changes, if introduced, require their own impact checks.

Complete when step 0 closes the plan with a legacy-driver wait fix (before/after recorded, 059–060 cancelled), or when compatibility, evidence and process ownership are verified and the pilot has a recorded adoption or rejection result. Capture the shared design contract and results in durable documentation before removing a completed plan, so 059 can consume them. Deliverables are the runnable pilot, coverage map, measured result and verified harness. Full Settings migration and default command changes belong to the follow-ups.
