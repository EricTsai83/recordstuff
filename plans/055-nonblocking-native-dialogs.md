# 055 — Native dialogs that do not stop the main process

[English](055-nonblocking-native-dialogs.md) | [繁體中文](055-nonblocking-native-dialogs.zh-TW.md)

Status: planned. Created: 2026-09-29. Execution order: see [queue](README.md#order-and-status).

## Purpose and boundary

While a windowless message box from `dialog.showMessageBox` is on screen, the main process stops doing its own work: timers do not fire and queued log lines are not written until the user closes it. The quit-deferral notice (`createQuitFeedback`, "Recording is still starting, saving or cleaning up…") is shown exactly while recording work is pending, so the work the notice says it is waiting for waits for the notice instead.

Observed on 2026-09-29 (signed development bundle, macOS 26.6.2, M1 Pro), during a recording smoke round whose capture requests hung for an unrelated environmental reason:

- 11:37:04 a session entered `starting`; its capture-request deadline (`DEFAULT_CAPTURE_REQUEST_TIMEOUT_MS`, 120 s) was due at 11:39:04.
- 11:38:33 a quit was deferred (`quit deferred: recording work is still pending`) and the notice appeared.
- Nothing reached the log file until the notice was closed at 11:41:50; the 11:38:33 line was written only then, and the deadline fired at 11:41:50.921, 2 min 46 s late. The session then cancelled normally and the next quit exited.

Earlier in the same round, a quit requested while a session was starting waited for that deadline and exited without a notice, so the stall appears only once the notice is shown.

Every windowless native dialog in main can do the same, not only this notice ([index.ts](../src/main/index.ts)): the output-folder warning (`createOutputFolderOpener`'s `show`), the permission-pane fallback after `openScreenCaptureSettings` fails, the quit-deferral notice, the unsaved-history quit prompt (`createHistoryQuit`), the folder chooser (`showOpenDialog`) and `showErrorBox` for an uncaught exception or a failed start. Which of them actually suspend the event loop, and for how long, is not yet measured; the mechanism (a nested modal run loop in which Electron does not run Node's timers and I/O) is a hypothesis from this one observation.

Why it matters: a notice shown while saving could hold finalization, the stop deadline and the history save until the user answers. A dialog raised during a recording would also stall chunk writes and the stall guard.

Out of scope: redesigning quit or its wording, the unsaved-history consent itself (it must stay an explicit choice), and Windows, where `showMessageBox` behaves differently and is not verified.

## Work

- [ ] **Measure first.** Write a small probe (a throwaway Electron script, not app code) that starts a 1 s `setInterval` and a log line per tick, then opens each dialog shape used in main: windowless `showMessageBox`, `showMessageBox` with a hidden parent window, `showOpenDialog`, and `showErrorBox`. Record whether ticks continue while each dialog is open. Keep the results in the plan's record, not in local files.
- [ ] **Choose the presentation from the measurement.** Implementer's choice, in this order of preference: a shape the probe shows does not stop the loop (for example a sheet or a parent window, if it does not); otherwise replace the quit-deferral notice with a notification plus the tray's existing "Quitting…" state, because it only informs and needs no answer. Prompts that need an answer (unsaved history, folder chooser) keep a dialog but must not be shown while media work is pending; the history prompt already runs after media has settled, which the fix must preserve.
- [ ] **Deadlines must not depend on the dialog.** Whatever presentation is chosen, a pending capture-request, stop or history deadline must fire on time while it is on screen. Add a unit test at the boundary that can be tested (for example that the quit-deferral path no longer awaits a blocking call before returning control), and state in [desktop design](../docs/system-design/desktop.md) which dialogs may still block and why.
- [ ] Update the English and Traditional Chinese design text for the changed quit feedback.

## Verification

- [ ] `pnpm check`, and `pnpm acceptance:quit-dialog` for the changed quit presentation (inspect its screenshots in both languages).
- [ ] Native case, after the [readiness handoff](../docs/testing.md#confirm-desktop-handoff-before-testing): with recording work held pending by `pnpm acceptance:controlled -- fault cleanup=hold` (not a broken capture), request quit so the deferral is presented, leave it unanswered for at least a minute while a timer is due (for example the runner's periodic status command, or a pending deadline), and confirm from the log that the deadline and the log lines arrive on time. Then answer or dismiss it and confirm the app quits normally.
- [ ] Recording smoke on a fresh `pnpm start:app` bundle if the change touches the quit or stop path.
- [ ] Exclusions: capture matrix and audio fidelity; capture and encoding are unchanged.

## Completion and evidence handling

Follow the [shared testing policy](../docs/testing.md) and [plan completion](README.md#completing-a-plan). Record the probe results and the native case in a dated verification record in both languages, update both indexes, then remove this plan and its translation. Do not commit, push or publish without a separate request.
