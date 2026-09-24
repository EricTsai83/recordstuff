# 028 — Settings window and shortcut lifecycle

[English](028-shortcut-editing-lifecycle.md) | [繁體中文](028-shortcut-editing-lifecycle.zh-TW.md)

Status: planned, not implemented. Created: 2026-09-24. Execution order: see [queue](README.md#order-and-status).

## Scope and evidence

Bugs **1 and 5**. Queue after 027; independent of media encoding. A real renderer DOM test shows valid macOS Control+W closes the window. A SettingsWindow test holds the save pending: close plus 20 seconds never resumes suspended global shortcuts until save settles.

Affected: [settings renderer](../src/renderer/settings.ts), [SettingsWindow](../src/main/settings-window.ts), [main shortcut integration](../src/main/index.ts), hotkey ownership and tests. Preserve explicit Confirm, reserved-combination validation, rollback after write failure and saved-setting/live-registration consistency.

## Round 2 extension: R2-03

Merge R2-03 (P2) here: the crashed window and its shortcut-capture lease share lifecycle ownership. Existing bugs 1 and 5 are R1. [SettingsWindow](../src/main/settings-window.ts) handles render-process-gone by ending capture, but retains the window. The next show only focuses it. A real SettingsWindow with a fake Electron boundary retained one window and one loadFile call after crash/reopen; native blank-window appearance was not measured.

- [ ] Invalidate and dispose the crashed instance; the next show must create/load a usable window. Avoid automatic infinite reload loops. Tie close/crash callbacks to the instance generation so late events cannot clear a replacement window or release its capture lease.
- [ ] Preserve committed settings and the capture/transaction separation below. A pending confirmed save keeps its defined commit/failure behavior across a crash; abandoned unconfirmed input must not be submitted.
- [ ] Cover crash while idle, capturing and committing; repeated show/crash; old close after new show; failed load and successful reopen. Assert restored shortcuts and visible persisted values, not only window counts.
- [ ] Extend settings regression with an isolated real Electron renderer crash and reopen, observing usable controls with native input. Keep the native shortcut and recording checks below; a fake render-process-gone alone is insufficient proof of recovery.

Cap's existing hotkey-input comparison does not establish settings renderer crash recovery.

## Cap assessment

Cap's [shortcut editor captures physical code plus individual modifier flags](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/apps/desktop/src/routes/%28window-chrome%29/settings/hotkeys.tsx#L63-L96) and has preview/confirmation controls. Its [backend replaces registrations](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/apps/desktop/src-tauri/src/hotkeys.rs#L458-L485); that path discards registration errors with .ok(). The inspected editor does not provide RecordStuff's same suspend-during-capture/save contract. This is a limited input-model reference, not evidence that Cap solves our stalled-save/close problem. Do not copy weaker registration-error handling or immediate persistence of preview state.

## Implementation and tests

- [ ] Define one platform-aware close-chord predicate used by field and document handlers: exact Command+W on macOS, exact Control+W where that is the close shortcut; exclude extra modifiers. macOS Control+W remains capturable. Test platform mappings and lowercase/physical-key handling explicitly; do not infer macOS Option key output from synthetic event.key='w'.
- [ ] Give each capture session an ownership token. Release its suspension on cancel, blur, timeout, close, renderer failure and destroy, even if a save is pending. Release is idempotent. A late response from an old window cannot end a new window's capture.
- [ ] Separate the capture lease from the setting transaction. Closing releases input capture and restores the currently committed registration; an already-confirmed save may complete afterward. Only after persistence succeeds may the new setting request registration. If a recording starts under the restored old key, defer applying the new key until that recording settles, retaining its stop key. Failure keeps the prior setting and registration.
- [ ] Ensure an old transaction completing while a new capture is active does not resume shortcuts early. Use ownership/generation checks rather than a global committingHotkey exception. Preserve conflict reporting and both recording/settings registrations; do not silently unregister another owner.
- [ ] Regress valid Control+W, exact close chords, extra modifiers, Confirm/Cancel; slow-success/failure save combined with every release path, reopen while saving, new capture while old commit finishes, and recording started before late commit. Verify saved state, live registration and visible feedback together.
- [ ] Update bilingual desktop design and localized feedback if needed.

Required: `pnpm acceptance:regression` (includes check/build); fresh `pnpm start:app`, physical macOS Control+W capture/Confirm, ordinary Command+W close, and restored recording/settings shortcuts after closing during a controlled delayed save. Complete a recording smoke and observed playback because global registration changes can affect stop delivery. Use isolated fixture delay for deterministic I/O stalls; disclose its boundary separately from real OS key delivery. Windows mappings are unit coverage only unless a Windows environment is actually tested. Exclude full media matrices, permissions, display removal and long runs.

## Completion and evidence handling

Follow [shared testing policy](../docs/testing.md) and [plan completion](README.md#completing-a-plan). Use the [native acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) for any required native UI round. Serialize shared builds; one desktop/audio/shortcut owner per round. Restore changed settings, close test UI, quit the tested app and confirm process exit; incomplete cleanup blocks the next round.

- [ ] Record checks/results, scope exclusions and required-but-unverified cases separately; mocked boundaries are not native proof. Missing prerequisites are blocked. Run `git diff --check` on the implementation.
- [ ] Preserve durable conclusions in bilingual design/verification docs, update both indexes, then remove this plan and translation only after completion. Do not commit, push or publish without a separate request.

Planning-only validation: relative links/anchors, command names, bilingual coverage and `git diff --check`; no App build, tests, launch or recording just to write this plan. Cap assessment is static source review at revision `ce785e705e79652adba4b8bf752669c4093499e0`, not execution or an assurance about every Cap mode/platform.
