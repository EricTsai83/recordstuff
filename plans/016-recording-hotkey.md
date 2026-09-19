# 016 Global Keyboard Shortcut for Start/Stop Recording

[English](016-recording-hotkey.md) | [繁體中文](016-recording-hotkey.zh-TW.md)

Status: Planned; next in order. Updated: 2026-09-19.

## Problem and outcome

Recording can only be started and stopped by clicking the menu bar icon. Two consequences: users who are presenting or gaming cannot toggle recording without reaching for the tray, and the release acceptance's only remaining manual step (make a short recording and play it back) cannot be automated, because computer-use tooling times out on a tray-only Electron process with no visible window (see the 2026-09-19 window probe under docs/verification/measurements). A global keyboard shortcut is a user feature first and, as a side effect, gives automation a system-level entry point that needs no window.

Outcome: one configurable global shortcut toggles recording exactly like a left click on the tray icon, with the same state machine, permission handling, notifications and saved-file behavior. The shortcut is shown in the tray menu, works while other apps are frontmost, and can be changed or disabled from the menu. The acceptance skill can then start and stop a recording by sending the key combination.

## Work

1. Register the shortcut with Electron `globalShortcut` on app ready and re-register on settings change; default `Command+Shift+R` on macOS (recheck for conflicts with common apps and document the finding). Unregister on quit. A registration failure (conflict with another app) must be logged and shown in the tray menu, never silent.
2. Route the shortcut through the same start/stop action as the tray click so there is one code path; no second state machine. Ignore presses while a session is starting or stopping (existing guards).
3. Persist the accelerator in settings (v3 migration keeping v1/v2 behavior); allow disabling. Expose in the tray menu: current shortcut with an enable/disable toggle and a small set of presets, or a "Change shortcut" submenu; a free-form recorder dialog is out of scope unless the preset approach proves insufficient.
4. i18n: English and Traditional Chinese menu strings and log lines per src/shared/i18n.ts conventions.
5. Tests: registration/unregistration lifecycle with a mocked globalShortcut, settings migration, conflict handling, and that the shortcut and tray click share one action. `pnpm check`.
6. Unattended acceptance (the reason this plan is first): extend the computer-use acceptance skill so that, with no visible window, it starts recording by sending the shortcut, waits for `state → recording` in the log, records about ten seconds of the test material page, stops with the shortcut, waits for `saved`, runs `pnpm verify` on the file (integrity tier, including channel energy as the audio evidence), opens the file in QuickTime and captures a playing frame. Record one complete unattended run as evidence under docs/verification/measurements. Then change the release checklist in [release automation](../docs/system-design/releases.md) so step 1 is "run the acceptance skill" with the manual recording as fallback, and have the skill write its summary into the record job's "Local acceptance before tagging" section. Cases that still need the tray menu (language, Show last recording) remain blocked and are listed as such; hearing the audio remains unverified by tooling.
7. Documentation: desktop design (tray, settings, shortcut), functions reference, README feature list, installation guide (mention of the default shortcut), plan index and translations. Ship under the next version by pushing its tag.

## Acceptance

The shortcut starts and stops a recording from any frontmost app with the same results as clicking the tray icon; a conflicting registration is reported, not ignored; the setting survives relaunch; disabling it leaves tray behavior unchanged. One computer-use acceptance run completes a recording via the shortcut without a visible window. Scope excludes an in-app recording dialog, per-window capture, or any change to capture itself.
