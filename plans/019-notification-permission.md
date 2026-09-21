# 019 — Notification permission guidance

[English](019-notification-permission.md) | [繁體中文](019-notification-permission.zh-TW.md)

Status: switch implemented and unit-checked; cause unreproduced and native acceptance pending. Priority: current. Created: 2026-09-21.

## Problem and outcome

A user reported that a downloaded release neither displayed notifications nor offered guidance to enable notification permission. The specific release and macOS cause have still not been reproduced.

Give the user a visible, bilingual way to control notifications for saved recordings and errors, and a stated recovery path when macOS is blocking them. Recording must remain usable whatever the notification state. Scope is the supported macOS app; preserve existing behavior on other platforms without claiming their acceptance.

## Design decision — 2026-09-21

Electron cannot read notification authorization. `systemPreferences.getMediaAccessStatus` is typed for `microphone | camera | screen`, and the shipped `Electron Framework` binary contains no `getNotificationSettingsWithCompletionHandler`. It does contain `requestAuthorizationWithOptions:completionHandler:`, so `Notification.show()` already asks macOS for authorization — notifications were never missing an authorization request, only a recovery path.

The app therefore does not mirror the OS permission. It ships one `notifications` boolean, after Cap's design, and names the recovery path in the settings note instead of a status line it cannot substantiate. A Node-API bridge to `UserNotifications` was implemented first and reverted; see the [verification record](../docs/verification/README.md#notification-switch-replaces-the-native-bridge--2026-09-21) for why, and `wip/019-native-notification-bridge` for the code.

## Expected experience

- Settings → General shows Notifications On/Off, default On, and on macOS an Open notification settings… action. The note says what notifications are for and that macOS must also allow RecordStuff in System Settings → Notifications.
- The macOS Open notification settings… button lives in the switch's own card, so changing the switch and checking the OS read as one decision.
- macOS offers its authorization prompt only while the status is `notDetermined`, once per bundle ID, surviving reinstalls. The app spends that one chance on the first-run hint at launch, where macOS is already asking for screen recording, rather than at the end of the user's first recording. The switch stays on by default.
- Turning the switch off and on again sends one confirmation notification, a delivery test the user can repeat.
- Turning the switch off drops every notification the app would send, before Electron is asked, with one log line per drop. The note then states the cost — an interrupted or unsaved recording will not announce itself — and points at the output folder, which already holds any partial file. The app stores no error state of its own: the choice is obeyed, not compensated for.
- The switch is locked during a capture, like every other preference, and no notification state ever blocks saving or changes the recording state.

## Implementation order

### 1. Establish actual authorization behavior

- [ ] Record the affected release version, macOS version, installation path, bundle ID, signing identity, notification preferences and relevant delivery logs where available. Distinguish user evidence from independently reproduced results.
- [x] Inspect the repository's resolved Electron version and its macOS notification implementation. Done by binary symbol inspection of Electron 44.3.0, not by observing a signed packaged build.
- [x] Decide whether a native bridge is required. It is not: the missing capability is status reading, which is a nice-to-have, and a bridge load failure suppresses more than it adds.

### 2. Implement the switch

- [x] Add an additive `notifications` boolean to [settings](../src/main/settings.ts), default on, read leniently with no warning for older files.
- [x] Gate [`AppTray.show`](../src/main/tray.ts) on the switch before any OS call, and log each drop.
- [x] Add the Settings group, the macOS settings-pane action and the enable confirmation, with English and Traditional Chinese strings.
- [x] Run `pnpm check` and `git diff --check`.

### 3. Verify behavior

- [x] Unit tests for the default, round-trip and non-boolean value; the drop-while-off path; the confirmation; and the settings model's committed value, recording lock, note text and macOS-only pane action.
- [ ] Launch the app and confirm the switch reaches real delivery: turning it on produces a visible confirmation banner, turning it off stops saved-recording notifications, and Open notification settings… lands on the RecordStuff pane. Use the [native computer-use acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) with `pnpm start:app`. Check for an existing user recording before rebuilding or quitting.
- [ ] Confirm on a fresh notification authorization state that turning the switch on raises the macOS prompt. A reinstall alone is not a fresh permission state; use a test account or controlled environment.
- [ ] Regress start/stop/save/playback with screen and system audio, saved-banner click and Finder reveal. Record what was actually tested and what was not.
- [ ] Validate an installed release-style signed package built by the release packaging path. Record version/commit, signing facts, OS and evidence.

## Completion and boundaries

No commit, push, tag or publication is authorized by this plan. No APNs service, auto-update system, screen-permission redesign or platform expansion is included. Do not reset a user's existing notification preferences merely to create a test fixture.

The durable conclusions are already in [desktop design](../docs/system-design/desktop.md#notification-switch) and the [verification record](../docs/verification/README.md#notification-switch-replaces-the-native-bridge--2026-09-21). This plan stays open until the native acceptance above is resolved, then follows [plan completion](README.md#completing-a-plan). Reproducing the original report is tracked here and is not blocked by the switch.

## Technical references

- [Apple: asking permission to use notifications](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications): native authorization request and contextual guidance.
- [Electron: notifications](https://www.electronjs.org/docs/latest/tutorial/notifications): macOS signing requirement.
- [Electron: Notification API](https://www.electronjs.org/docs/latest/api/notification): delivery API and lifecycle events.
- [Cap: desktop notifications](https://github.com/CapSoftware/Cap/blob/main/apps/desktop/src-tauri/src/notifications.rs): the one-boolean send path this design follows.
