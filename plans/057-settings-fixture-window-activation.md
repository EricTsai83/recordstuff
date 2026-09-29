# 057 — Settings fixture results when its window loses activation

[English](057-settings-fixture-window-activation.md) | [繁體中文](057-settings-fixture-window-activation.zh-TW.md)

Status: planned. Created: 2026-09-30. Execution order: see [queue](README.md#order-and-status).

## Purpose and boundary

The 20-item audit of 2026-09-30 ran `pnpm acceptance:regression` three times on the same revision. The first settings fixture round stopped with `UnknownVizError` from `webContents.capturePage()` after `result-focus-inside-en-light.png` and reported no results; the second failed 22 of 176 cases, every one a focus-line case whose outline read `none` although focus had arrived (`reached: true`); the third, with nothing else brought forward, passed 176/176. Both failures fell in the fixture's late section, where it opens a second window, destroys it and calls `window.focus()` ([settings-panel.ts](../scripts/fixtures/settings-panel.ts)). The page draws no focus line while its window is inactive (`data-window="inactive"`, plan 047), and on macOS `BrowserWindow.focus()` does not take activation back from another app; the chat app driving the round was frontmost afterwards. A round whose window another app deactivated is therefore reported as a product failure, and a capture failure as a fixture crash with no results, which reads as a regression and costs a rerun.

Out of scope: the focus-line styles and the page's inactive-window rule (they behaved as designed), the shortcut integration runner, and other runners' activation handling.

## Work

- [ ] **Know whether the window was active.** Before each case that depends on window activation (the focus-line matrix and any screenshot compared with an active window), record `BrowserWindow.isFocused()` and the page's `data-window`, and ask for activation again the way the app does (`app.focus({ steal: true })` before `window.focus()`), then check it held.
- [ ] **Report lost activation as blocked.** When activation cannot be confirmed for such a case, record it as not run with the frontmost app's name when it can be read, and end the round with the desktop-blocked exit (2, [desktop-session.mts](../scripts/lib/desktop-session.mts)) rather than 1, as a locked session does. A case that ran with an active window keeps its pass or fail.
- [ ] **Keep results when a capture fails.** Write the cases recorded so far when `capturePage()` throws, name the screenshot that failed, and classify the round as blocked when the window was inactive or hidden at that moment, as failed otherwise.
- [ ] Unit tests for the classification (active → judged, inactive → not run and blocked, capture error with and without activation), and update the English and Traditional Chinese tooling text for the settings acceptance.

## Verification

- [ ] `pnpm check`, then `pnpm acceptance:settings` after the [readiness handoff](../docs/testing.md#confirm-desktop-handoff-before-testing): one undisturbed round passes every case; one round in which another app is brought forward during the focus-line section ends blocked (exit 2) with the affected cases named, not failed.
- [ ] Exclusions: recording, native shortcut delivery and the app bundle; only a developer runner changes.

## Completion and evidence handling

Follow the [shared testing policy](../docs/testing.md) and [plan completion](README.md#completing-a-plan). Record both rounds in a dated verification record in both languages, update both indexes, then remove this plan and its translation. Do not commit, push or publish without a separate request.
