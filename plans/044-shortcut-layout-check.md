# 044 — Automate the keyboard-layout shortcut check

[English](044-shortcut-layout-check.md) | [繁體中文](044-shortcut-layout-check.zh-TW.md)

Status: planned, not implemented. Created: 2026-09-26. Execution order: see [queue](README.md#order-and-status).

## Scope, evidence and separation

Follow-up to [043](../docs/verification/history-2026-09.md#plan-043-closure--2026-09-26), requested by the maintainer. 043 registers global shortcuts by physical key by disabling Chromium's `LayoutAwareGlobalHotkeys`. Its layout evidence came from hand-run steps: throwaway Electron probes, a Swift helper that switched the input source, and `pnpm acceptance:updates` run under Zhuyin.

Physical registration means ordinary rounds need no particular input source. One regression is still possible: an Electron upgrade could rename or remove the feature, and registration would silently return to layout lookup, which moves a digit shortcut to the keypad under Zhuyin. This plan makes that check one command that needs no manual input-source switching.

Separation:
- Not a change to shortcut behavior, the default shortcut, settings or the editor.
- Not physical-key acceptance: synthetic System Events keys cannot prove hardware.
- Not the letter trade-off on non-QWERTY Latin layouts.
- Not Windows.

No new Cap comparison: Cap's `global-hotkey` path has no layout lookup to test.

## Implementation contract

- [ ] Add `pnpm acceptance:shortcut-layout`. It tests the built app (`out/main/index.js`) through the existing [shortcut-failure](../scripts/fixtures/shortcut-failure.ts) boundary pattern, so the check covers [index.ts](../src/main/index.ts)'s real switch wiring rather than a separate probe.
  - Use isolated userData and logs, as the existing phases do.
  - Registration must reach the real `globalShortcut`.
  - A press must be recorded without calling the production toggle, so no capture starts and no permission prompt appears.
  - Stop with a clear message when `out/` is missing, as `acceptance:shortcut` does.
- [ ] Register a digit accelerator unlikely to collide, for example `CommandOrControl+Control+Alt+Shift+7`, through the isolated settings file. Refuse as blocked while any other RecordStuff process runs.
- [ ] Handle the input source:
  - Record the current input source.
  - Select an already-enabled input source whose number row does not type digits; Zhuyin is one on this Mac.
  - Wait, with a bound, until the current keyboard layout reports it. Missing or timed out is blocked.
  - Never add or enable input sources and never change keyboard preferences.
  - Restore the original source on success, failure, timeout, SIGINT and SIGTERM, then confirm it. A restore that cannot be confirmed is a cleanup failure.
  - Implement the query and selection without new npm dependencies. Prefer `osascript` JavaScript for Automation; if a Swift helper is needed, compile it into the run directory on demand and report a missing `swiftc` as blocked.
- [ ] Assert, with bounded waits and keys sent through System Events:
  - the number-row key code for the digit reaches the production registration;
  - the keypad key code does not;
  - one letter or punctuation control, such as the Settings shortcut ⌘⌥, sent as key code 43, still fires.

  Missing Accessibility or System Events access is blocked. Hold the desktop round guard for the whole run.
- [ ] Add a negative-control drill, outside the default run, that removes the production `disable-features` value before app ready. The number-row assertion must then fail with exit 1 and the input source must still be restored. This proves the check detects 043's bug instead of passing vacuously.
- [ ] Write `report.md` and `report.json` with:
  - the original, selected and restored input sources and the keyboard layout;
  - the accelerator and each key result;
  - cleanup;
  - exit 0 for pass, 1 for fail and 2 for blocked, as in the other runners.
- [ ] Unit-test the pure pieces: choosing a source, restore bookkeeping and result classification. Avoid tests that only restate calls.
- [ ] Update the bilingual docs:
  - [testing guide](../docs/testing.md): the global-shortcut row and the Electron/runtime-dependency row require this command;
  - [tooling](../docs/system-design/tooling.md): a new section with prerequisites, behavior and exit codes;
  - [design decisions](../docs/system-design/decisions.md): the Electron-upgrade trigger names the command;
  - [desktop design](../docs/system-design/desktop.md#recording-shortcut): a pointer to the command.

## Required verification and exclusions

These are runner and fixture changes, so the testing guide requires the relevant tests, typecheck and a real run of the affected runner, including its changed failure and cleanup paths.

- Run `pnpm check`. If the shared shortcut-failure fixture or `acceptance-shortcut.mts` changes, also run `pnpm acceptance:regression`.
- Run `pnpm acceptance:shortcut-layout` for real, starting from a different input source such as ABC. It must pass and leave the starting source restored.
- The negative-control drill must fail with exit 1 and restore the input source.
- SIGINT during the layout phase must restore the input source and leave no fixture process.
- An unavailable layout, simulated by requesting a source that is not enabled, must be blocked without changing anything.
- No recording, matrix, notification or packaging check is needed: the product does not change.
- Physical keys stay outside this check. 043's maintainer-reported physical press remains the hardware evidence.

## Completion and evidence handling

Follow [shared testing policy](../docs/testing.md) and [plan completion](README.md#completing-a-plan). Serialize shared builds; one desktop/audio/shortcut owner per round. Restore the input source and any changed settings, quit the tested process and confirm process exit; incomplete cleanup blocks the next round.

- [ ] Record checks/results, scope exclusions and required-but-unverified cases separately; mocked boundaries are not native proof. Missing prerequisites are blocked. Run `git diff --check` on the implementation.
- [ ] Preserve durable conclusions in bilingual design/verification docs, update both indexes, then remove this plan and translation only after completion. Do not commit, push or publish without a separate request.

Planning-only validation: relative links/anchors, command names, bilingual coverage and `git diff --check`; no App build, tests, launch or recording just to write this plan.
