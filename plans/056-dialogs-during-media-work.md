# 056 — Dialogs and feedback while media work is pending

[English](056-dialogs-during-media-work.md) | [繁體中文](056-dialogs-during-media-work.zh-TW.md)

Status: planned. Created: 2026-09-29. Execution order: see [queue](README.md#order-and-status).

## Purpose and boundary

Plan 055 measured that a windowless `dialog.showMessageBox` and `dialog.showErrorBox` hold main's timers, I/O and log until they are closed ([record](../docs/verification/history-2026-09.md#plan-055-closure--2026-09-29)), and moved the deferred-quit notice to a notification. Its design text lists the dialogs that still block ([dialogs and main's event loop](../docs/system-design/desktop.md#dialogs-and-mains-event-loop)). Two of them can still meet a running recording, and the new notice has a visibility gap:

- **Uncaught exception.** `process.on("uncaughtException")` in [index.ts](../src/main/index.ts) logs the error and shows `showErrorBox` once per process, at any time. During a recording that box holds chunk writes, the stall guard and every deadline until the user closes it.
- **Output-folder warning.** `createOutputFolderOpener`'s warning ([output-folder.ts](../src/main/output-folder.ts)) is reached from the tray and Settings only in a settled state, but Show last recording and a saved notification's click fall back to it when the file is gone (`revealSaved`). A click on an earlier recording's notification during a later recording, when that file is gone and the folder cannot be opened, would hold the recording until the warning is answered. Not observed.
- **Unseen deferred quit.** When macOS refuses RecordStuff's notifications, Focus hides them, or a banner is muted while the display is captured, a deferred quit leaves only the tray returning from "Quitting…" and a log line; the app just stays open.

Out of scope: the unsaved-history prompt and the folder chooser (055 kept them: the prompt runs after media has settled and needs an answer, and the chooser does not block), the startup-failure `showErrorBox` (it runs before any media exists), quit wording, and Windows.

## Work

- [ ] **Uncaught exception during media work.** While media work is pending, do not show the modal box: log as now, and present it once media has settled (or as a notification that opens the log), still at most once per process. A settled app keeps today's box. State in the design how a fault that also breaks settling is surfaced.
- [ ] **Output-folder warning during media work.** When the opener finds a problem while media work is pending, do not raise the modal warning; tell the user without blocking (for example a notification naming the folder, with the chooser left to the settled tray and Settings) and log it. The settled path keeps its warning and Change output folder choice.
- [ ] **Deferred quit that cannot be seen.** Measure what the log and Electron report when a notification is refused (`failed`, `Notification.isSupported()`) and choose a fallback that needs no modal while media work is pending, for example a tray status line for the deferral until the next state change or quit. Implementer's choice; keep 055's rule that nothing on the quit path waits on the user.
- [ ] Unit tests at each boundary (for example that the exception handler and the opener call no blocking presentation while media work is pending), and update the English and Traditional Chinese design text that lists the dialogs that still block.

## Verification

- [ ] `pnpm check`.
- [ ] Native case, after the [readiness handoff](../docs/testing.md#confirm-desktop-handoff-before-testing): on a controlled build, raise an uncaught exception during a recording (a new controlled fault point, if the implementer adds one) and confirm from the log that chunk writes, the stall guard and the stop continue and the recording saves, then that the error is presented afterwards.
- [ ] If the deferred-quit fallback changes the tray, inspect it in both languages on a controlled build with `cleanup=hold`.
- [ ] Recording smoke on a fresh `pnpm start:app` bundle, since the change touches presentation during a recording.
- [ ] Exclusions: capture matrix and audio fidelity; capture and encoding are unchanged. The output-folder combination may rest on unit tests if it cannot be staged natively; record that limit.

## Completion and evidence handling

Follow the [shared testing policy](../docs/testing.md) and [plan completion](README.md#completing-a-plan). Record the native cases in a dated verification record in both languages, update both indexes, then remove this plan and its translation. Do not commit, push or publish without a separate request.
