# 059 — Migrate Settings behavioral tests to Playwright

[English](059-settings-playwright-behavior.md) | [繁體中文](059-settings-playwright-behavior.zh-TW.md)

Status: deferred with 058 on 2026-10-02; executable only after 058 passes its measurement gate and adopts Playwright. Dependency: the verified harness and adoption result of [058](058-playwright-testing.md). If 058 rejects adoption, this plan is not executable. Default command cutover belongs to [060](060-settings-playwright-cutover.md).

## Problem and scope

Extend the validated pilot to the complete Settings behavioral suite, with independently selectable scenario families and equivalent IPC/input evidence. This plan does not migrate the visual screenshot matrix or replace the default acceptance command. Existing shortcut integration and native OS/capture tests remain separate.

## Coverage and isolation design

Extend 058's coverage map to every current Settings behavioral assertion. Record stable ID, setup, inputs, expected intermediate/final states, production versus controlled boundaries, activation dependence and replacement. Every assertion needs a retained case, equivalent replacement or justified consolidation; total test counts do not prove equivalence.

| Family | Required behavior |
| --- | --- |
| Startup/security/localization | Built page and preload, bridge exposure, Node isolation, initial read failure and localized feedback |
| Controls and IPC | Committed/rejected changes, disabled actions, actual round trip and state synchronization |
| Pending/error/races | Busy state, overlapping requests, older pushes, held saves, node/focus stability and intermediate frame observations |
| Keyboard/focus | Tab/arrow/Enter/Space navigation, cancel, blur, active-window focus rings and returning from owned windows |
| History/failures | Expansion, acknowledgement, retry/removal, late updates, stale mouse-down/up and independent entries |

Use the real built renderer/preload with fixture IPC and typed main controls from 058. Production model/persistence assertions remain in their existing tests; fixture handlers cannot establish full production-main integration. Shortcut registration, restoration, crash/restart persistence already covered by the separate shortcut fixture retain that evidence boundary.

Reuse an app within a family only with verified reset of data, requests, gates, listeners, timers and window state. Use fresh app instances for lifecycle/crash cases included in this suite. Specs must run independently and in a different family order without relying on a previous test's side effects. Keep main/helpers cleanup and blocked classification from 058.

Use locator actions for normal interactions. For disabled controls, verify disabled state and rejected delivery with intentional low-level input only when required. Preserve stale mouse-down/up interleavings. Assertions about no flicker, node identity or focus retention need observations during a held gate/frame interval; checking the final settled DOM is insufficient. Apply observable waits only where they preserve these semantics.

## Implementation

- [ ] Complete behavioral coverage mapping, including cases already covered by the pilot and cases retained in separate fixtures.
- [ ] Migrate controls/IPC, pending/error/races, keyboard/focus and history/failures into selectable `.spec.ts` families; retain existing pilot startup/security cases.
- [ ] Implement explicit family reset and gate release; verify independent execution and order changes. Preserve activation evidence around input-dependent cases.
- [ ] Compare old/new equivalent behavioral selections once; inspect any unexplained failures or timing regressions, including launch/reset/trace costs.
- [ ] Keep the legacy full suite available until 060 cutover. Define a migration map that 060 can use to remove obsolete behavioral driver code without removing visual cases or shared bootstrap logic.

## Verification and completion

Run focused tests for changed helper behavior and `pnpm typecheck`. Build once before Electron fixtures, then run the complete new behavioral selection and affected legacy fixture paths. Exercise changed fault/input/reset/cleanup paths and inspect relevant bilingual screenshots. Run the existing shortcut integration after shared Settings fixture changes; unchanged OS/capture behavior does not add recording acceptance. Apply additional checks only if the actual diff crosses those boundaries, under the [testing policy](../docs/testing.md).

Complete when all behavioral coverage IDs are mapped, every required scenario passes with equivalent security/IPC/input evidence, independent execution is verified, and no unexplained new failure or process leak remains. Compare behavioral median costs using 058's method if an apparent timing regression is unresolved. Default commands and the visual matrix may still use the legacy suite; that is the explicit input to 060, not full migration completion.
