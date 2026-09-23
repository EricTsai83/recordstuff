# 023 — Open Settings with a global shortcut

[English](023-settings-shortcut.md) | [繁體中文](023-settings-shortcut.zh-TW.md)

Status: not started; planning only. Priority: immediately after 020, before 021 and 022; plan numbers remain unchanged. Created: 2026-09-23.

## Problem and outcome

Native computer-use acceptance currently needs the maintainer to open Settings from the menu bar before testing can proceed. Add a user-facing global shortcut that opens and focuses RecordStuff Settings while another app is frontmost, so computer use can enter the panel without human assistance. This opens the app's preferences, not macOS System Settings.

The existing `openSettings` action in [index.ts](../src/main/index.ts) already calls `SettingsWindow.show()` in [settings-window.ts](../src/main/settings-window.ts), which creates or focuses one panel. Reuse that path. A tray label or a shortcut that works only while the panel is focused does not satisfy this plan.

## Proposed behavior

- Use a dedicated global shortcut, provisionally `CommandOrControl+Alt+,` (macOS: ⌘⌥,). Confirm the combination through native acceptance before finalizing it; ordinary ⌘, must remain available to the frontmost app. No customizable Settings shortcut is required in this plan.
- Register after app readiness; release only this registration on quit. Keep its ownership and status separate from the recording shortcut in [hotkey.ts](../src/main/hotkey.ts). Turning off or changing the recording shortcut must not disable access to Settings.
- Open, restore if minimized, and focus the existing panel; repeated presses never create extra windows or toggle the panel closed. Closing and reopening the panel works without relaunching the app.
- Opening Settings never starts or stops recording. It remains accessible while recording, with the existing preference locks intact.
- Show the shortcut beside the tray Settings entry and document it in both languages. If registration fails or throws, retain tray access, log the failure and show a localized unavailable explanation; do not present the shortcut as working or repeatedly notify on refresh.
- Handle conflicts with 020's custom recording shortcut explicitly. Reject a newly selected recording shortcut that is equivalent to the Settings combination, with a localized reason. If an existing stored recording shortcut already matches, preserve its value and recording behavior, leave the Settings shortcut unavailable, and explain how to recover by changing the recording shortcut through the tray. Reconcile registrations after a change, without interrupting an active recording.
- During custom shortcut capture, temporarily suspend the Settings registration as needed so it cannot intercept the input being captured. Restore it on commit, cancel, blur, timeout, window close or renderer failure. A reserved Settings combination must produce validation feedback, not an accidental action. Preserve 020's recording-shortcut suspension behavior.

## Implementation and verification

- [ ] Add a shared Settings-shortcut constant and explicit registration/status lifecycle; reuse the existing `openSettings` action and avoid broad `unregisterAll` cleanup that could affect recording.
- [ ] Update focus/restore behavior where needed, tray discoverability, localized failure feedback and recording-shortcut conflict validation. Compare canonical/platform-equivalent combinations rather than raw strings, including stored preferences.
- [ ] Add focused tests for registration success/failure/throw and cleanup, recording-shortcut independence, conflict recovery, capture suspension/restoration, single-window reopen/focus/restore and unchanged recording state/locks.
- [ ] Run `pnpm check` and `git diff --check`.
- [ ] Use the [native computer-use acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) with the bundle launched by `pnpm start:app`. Before quitting or rebuilding, inspect recording state; do not interrupt a user's recording.
- [ ] Start with Settings closed and another app frontmost. Have computer use send the real global key combination, observe the visible, focused Settings panel, navigate a control using the keyboard, close it and reopen it with the shortcut. No maintainer click, direct IPC, fixture window or test-only opening route substitutes for this acceptance.
- [ ] Verify repeated presses, minimized/background panel recovery, recording-shortcut disabled/customized, and custom capture commit/cancel/blur/timeout/close recovery. Exercise both English and Traditional Chinese UI.
- [ ] Start a test recording, open Settings through the shortcut, confirm locked controls and uninterrupted capture, then stop/save/play the recording. Restore changed preferences and stop/save recordings created by the test.
- [ ] Verify registration refusal and existing-shortcut collision/recovery. Use controlled tests for deterministic error paths; explicitly distinguish those results from OS-level native evidence. Report actual permission or computer-use limitations without calling an assisted run unattended.
- [ ] Update the acceptance skill and relevant tooling/desktop documentation in both languages to use this entry point. Record actual native steps, results, evidence and untested cases in the [verification record](../docs/verification/README.md).

## Completion and scope

Success means computer use opens and operates the real Settings panel from another foreground app without asking the maintainer to open it. A registered shortcut still requires the app to be running, the combination to be available and the computer-use environment to be able to deliver keyboard input; this plan does not promise automation of OS permission dialogs.

No Settings redesign, macOS System Settings automation, release, commit, push or PR is included. Keep 020's existing acceptance status honest; adding this plan does not complete its pending checks. On completion, preserve durable behavior and evidence in documentation and follow [plan completion](README.md#completing-a-plan).
