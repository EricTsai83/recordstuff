# 027 — Permission reconciliation and query lifetime

[English](027-permission-state-and-query-lifetime.md) | [繁體中文](027-permission-state-and-query-lifetime.zh-TW.md)

Status: planned, not implemented. Created: 2026-09-24. Execution order: see [queue](README.md#order-and-status).

## Scope and evidence

Bugs **2 and 6**. Queue after 026; integrate against 025's terminal lifecycle. [Recorder.setPermission](../src/main/recorder.ts) drops denied status while busy; [PermissionWatcher](../src/main/permission.ts) deduplicates it forever after idle. A second reproduction leaves countScreens pending: default timers issue seven unresolved calls in 30 seconds. Neither test changed macOS TCC or measured native memory leakage.

## Cap assessment

Cap [uses cheap preflight, cached successful validation, serialized expensive validation, an in-flight guard and completion-based retry backoff](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/apps/desktop/src-tauri/src/permissions.rs#L320-L490). Its [permission request helper rechecks actual status](https://github.com/CapSoftware/Cap/blob/ce785e705e79652adba4b8bf752669c4093499e0/apps/desktop/src/utils/os-permissions.ts#L40-L74). These are relevant patterns; no identical Recorder event-loss fix was found in the inspected paths.

Cap also times out ShareableContent::current. This audit did not establish that dropping that future cancels the native macOS request. Therefore it is not evidence that Cap completely prevents bug 6's underlying request accumulation. RecordStuff must keep the real Electron getSources promise owned until settlement even after its UI deadline.

## Implementation and tests

- [ ] Store the latest granted/needsRelaunch status independently from recording state. On success, capture failure and startup failure, derive idle versus needsPermission from that status; preserve last-saved and failure information where the state model permits. Do not terminate an ongoing recording solely because of a status notification. Grant restores eligibility without requiring a duplicate event.
- [ ] Track an actual enumeration promise separately from the UI deadline. At most one watcher-owned countScreens call, including the registration prompt, may be unresolved. Timeout can display recovery guidance but cannot release the underlying in-flight slot. No fake cancellation by clearing a boolean.
- [ ] After actual failure settlement, apply a bounded retry backoff measured from completion. While permanently pending, keep cheap status polling and manual recovery/relaunch guidance responsive, but do not start replacement native calls. Do not promise automatic recovery while the native request never returns.
- [ ] Use generation/lifetime tokens so stop(), revoke/regrant, late completion or a superseded permission generation cannot apply stale success. Release the in-flight slot only for its own request; remove activate listeners/timers on disposal. Reconcile prompt registration and strict validation without introducing a second enumeration.
- [ ] Test revoke during starting/recording/stopping, then success/failure→settled; grant during busy; needsRelaunch transitions; successful save remains discoverable; pending/late success/late rejection across timeout, stop and revoke/regrant. Over many simulated polls assert one underlying unresolved request, not merely one wrapper. Once it settles, verify backoff and recovery.
- [ ] Update bilingual permission/recording behavior and honest recovery guidance.

Required: `pnpm check`, fresh `pnpm start:app` smoke and native revoke/regrant/relaunch recovery on the development app, recording the OS behavior when it offers or forces relaunch. Restore permissions/preferences afterward. Injected busy-transition tests cover sequences macOS will not allow interactively; report them separately. If settings projection changes, add `pnpm acceptance:regression`. No full media matrix, long recordings, hardware removal or system service killing. Missing permission-control prerequisites mean blocked, not evidence that the path is safe.

## Completion and evidence handling

Follow [shared testing policy](../docs/testing.md) and [plan completion](README.md#completing-a-plan). Use the [native acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) for any required native UI round. Serialize shared builds; one desktop/audio/shortcut owner per round. Restore changed settings, close test UI, quit the tested app and confirm process exit; incomplete cleanup blocks the next round.

- [ ] Record checks/results, scope exclusions and required-but-unverified cases separately; mocked boundaries are not native proof. Missing prerequisites are blocked. Run `git diff --check` on the implementation.
- [ ] Preserve durable conclusions in bilingual design/verification docs, update both indexes, then remove this plan and translation only after completion. Do not commit, push or publish without a separate request.

Planning-only validation: relative links/anchors, command names, bilingual coverage and `git diff --check`; no App build, tests, launch or recording just to write this plan. Cap assessment is static source review at revision `ce785e705e79652adba4b8bf752669c4093499e0`, not execution or an assurance about every Cap mode/platform.
