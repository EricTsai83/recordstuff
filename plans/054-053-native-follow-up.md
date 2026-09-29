# 054 — Plan 053 native follow-up

[English](054-053-native-follow-up.md) | [繁體中文](054-053-native-follow-up.zh-TW.md)

Status: planned. Created: 2026-09-29. Execution order: see [queue](README.md#order-and-status).

## Purpose and boundary

Plan 053 closed on 2026-09-29 with three native checks unfinished ([record](../docs/verification/history-2026-09.md#plan-053-closure--2026-09-29)). Its code is merged and covered by unit tests; this plan only collects the missing evidence and changes code only if a check fails.

- **Notification click on the installed app.** A notification click must not open Settings. With a development bundle running, a click made macOS launch the copy registered in /Applications, which reached the bundle as `second-instance`; 053 therefore ignores `second-instance` and the macOS reopen (`activate`) for 2 s after a notification click ([desktop](../docs/system-design/desktop.md#settings-shortcut)). What a registered copy that is itself running receives for a click was not observed: the round stopped on a locked session. Plan 014 recorded the activation about 110 ms after the click callback, which supports the window without proving it.
- **The checkpoint in a real report.** `pnpm measure:finalization` was blocked because the 053 worktree's development Electron.app had no screen-recording grant, so no report has shown `checkpoint` yet ([tooling](../docs/system-design/tooling.md#finalization-measurement)).
- **Leftover permission prompts.** That blocked run left macOS's “Electron is requesting to bypass the system private window picker” prompts on screen; they must be declined, not allowed, so the worktree copy gains no grant.

Out of scope: new features; the capture-start notice recording, which needs a display larger than the smallest resolution cap (1080p) and a cap the capture cannot confirm, neither available on the reference Mac; run it only if such a display is attached.

## Verification

- [ ] Before the round: follow the [readiness handoff](../docs/testing.md#confirm-desktop-handoff-before-testing) and confirm the session is unlocked; a locked session stops the round before anything launches.
- [ ] Decline any leftover Electron permission prompt.
- [ ] From the main checkout on `main`, build a fresh signed bundle with `pnpm start:app` and quit it, then run `pnpm acceptance:notification -- --install --clicks 2`. Pass: the clicks pass as the runner judges them, the installed app is restored and verified, and the app log shows no `reopen: … Settings opened` after any click. A `reopen: … ignored … ms after a notification click` line is expected evidence that the window caught the activation. If Settings opens, record the event and its delay after `notification: clicked`, then fix the window or listener in a separate change.
- [ ] From the main checkout, whose development Electron has the screen-recording grant, run `pnpm measure:finalization -- --dir <absolute folder> --repeat 1`. Pass: the take saves and verifies and the report lists `checkpoint` with a number.
- [ ] Optional, only with a display larger than 1080p: one recording with the 1080p cap, observing that any capture-start notice arrives after saving and never during capture.
- [ ] Exclusions: the capture matrix, long recordings and audio fidelity; capture and encoding are unchanged.

## Completion and evidence handling

Follow the [shared testing policy](../docs/testing.md) and [plan completion](README.md#completing-a-plan). One desktop owner per round. Restore every changed setting, close test UI, quit the tested app and confirm process exit.

- [ ] Add the results to the plan 053 record or a new dated record in both languages, update both indexes, then remove this plan and its translation. Do not commit, push or publish without a separate request.
