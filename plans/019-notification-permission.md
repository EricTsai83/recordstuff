# 019 — Notification permission guidance

[English](019-notification-permission.md) | [繁體中文](019-notification-permission.zh-TW.md)

Status: planned. Priority: next. Created: 2026-09-21.

## Problem and outcome

A user reported that a downloaded release neither displayed notifications nor offered guidance to enable notification permission. Current [notification delivery](../src/main/tray.ts) calls Electron `Notification.show()` and logs unsupported/failed delivery; it has no application-owned notification authorization check, request flow, or recovery UI. The existing [permission watcher](../src/main/permission.ts) covers screen recording only. The specific release and macOS cause have not been reproduced.

Provide a visible, bilingual way to enable notifications for saved recordings and errors, including users upgrading from an older release. Recording must remain usable when permission is declined or unavailable. Scope is the supported macOS app; preserve existing behavior on other platforms without claiming their acceptance.

## Expected experience

| State | Guidance and action |
| --- | --- |
| Not determined | At the first safe idle opportunity, show an app-owned explanation with “Enable notifications” and “Not now”. Enable requests system authorization; Not now keeps recording available. |
| Denied | Show a one-time explanation with “Open notification settings” and “Not now”. Do not repeatedly request system authorization. |
| Authorized | No onboarding prompt. Settings shows permission status and a way to open system notification settings. |
| Authorized but alerts disabled, or other restricted delivery state | When supported by the native status API, explain the specific limitation in Settings and offer system settings. Do not label every non-banner configuration as permission denial. |
| Unknown / query or request failed | Show an honest unavailable status in Settings, a retry action and manual settings instructions. Log the diagnostic; never assume authorization or enter a prompt loop. |

- Add a Notifications section in Settings → General, with current status, the appropriate enable/settings/retry action, and a user-triggered test notification after authorization. Say that permission does not guarantee a visible banner.
- Persist an app-owned onboarding version/acknowledgement separately from OS permission. Apply it to existing installations too; do not reuse the Windows `tray-hint-shown` marker. Dismissing guidance suppresses automatic repeats across launches and app updates, while Settings remains available. Persist only after the guidance was actually presented/handled; a deferred or failed presentation must not consume it.
- Defer automatic guidance during starting, recording, saving, and screen-permission/relaunch recovery. Avoid overlapping permission dialogs and focus stealing at save completion. Present when idle and existing recovery UI has finished; recheck state before presenting.
- Refresh status at startup, on opening Settings, after requesting authorization, and when returning from system settings. Since this is a menu-bar app, also refresh while its settings panel is visible using a bounded mechanism; do not rely solely on app activation.
- Revoking permission later updates Settings without restarting automatic onboarding. Notification failure must not trigger repeated modal dialogs, block saving, or change the recording state.
- Guidance must use an app dialog/settings UI that is visible without notification permission. Do not use a notification to explain missing notification permission.

## Implementation order

### 1. Establish actual authorization behavior

- [ ] Record the affected release version, macOS version, installation path, bundle ID, signing identity, notification preferences and relevant delivery logs where available. Distinguish user evidence from independently reproduced results.
- [ ] Inspect the repository's resolved Electron version and its macOS notification implementation. On a signed packaged app, establish whether the first `Notification.show()` requests authorization and what happens for not-determined and denied states. `Notification.isSupported()` is capability detection, not authorization status; failed/show events are not a reliable permission query or proof of a visible banner.
- [ ] Prove a way to query native notification settings and explicitly request authorization for the **RecordStuff app identity**. Prefer a supported Electron API if the installed version exposes one; otherwise implement a minimal in-process macOS native bridge to UserNotifications. Do not use a standalone helper whose permission belongs to another app, renderer web-notification permission as a proxy, or APNs registration for this local-notification feature.
- [ ] If a bridge is required, cover native compilation, Electron ABI/architecture, packaging, signing and CI release builds. Verify the native module loads from the packaged app before integrating UX. Request only needed notification options; existing notifications remain silent.
- [ ] Verify the notification-settings destination on supported macOS. If direct navigation fails or only opens the general pane, show manual steps: System Settings → Notifications → RecordStuff. Do not make an unverified private deep link the only recovery path.

### 2. Implement permission state and guidance

- [ ] Add a main-process permission adapter/controller with explicit not-determined, denied, authorized, limited and unknown states, bounded asynchronous operations, deduplicated requests and shutdown cleanup. Keep it separate from screen-capture permission and recording state.
- [ ] Add the onboarding persistence/migration and idle scheduling described above. Serialize authorization requests against ordinary notification delivery so the first notification cannot race the explicit request. Drop stale notifications rather than replaying a backlog after authorization.
- [ ] Wire status and whitelisted actions through existing Settings models/preload; add English and Traditional Chinese strings. Handle query, request, opening-settings and native-load errors without crashing or falsely reporting success.
- [ ] Retain current saved-notification delay/cancellation, notification ownership, file reveal and diagnostics. Add permission-transition/request diagnostics without logging unrelated private data.

### 3. Verify behavior

- [ ] Add focused tests for state mapping, first-run and upgrade guidance, persistent dismissal, unknown/error/timeout cases, concurrent requests, settings refresh and shutdown. Test deferral during recording/recovery and ensure notification failures cannot block file finalization.
- [ ] Run `pnpm check` and `git diff --check` after application changes.
- [ ] Use the [native computer-use acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) with `pnpm start:app`; record bilingual evidence for the matrix below. Stop/save only recordings started by the tester; check for an existing user recording before rebuilding or quitting.

| Native case | Required evidence |
| --- | --- |
| Fresh notification authorization state | Explanation is visible; Enable produces the actual system authorization flow for RecordStuff; allow leads to a visible test/saved notification. Use a fresh test account or controlled environment; reinstall alone is not proof of a fresh permission state. |
| Deny, dismiss, relaunch | Recording/save/playback still work; automatic guidance does not recur; Settings still offers recovery. |
| Existing installation without permission | Upgrade receives the one-time guidance even with existing app preferences. |
| Open settings, grant, return | Correct pane or usable fallback; status refreshes; subsequent notification appears without an unnecessary restart. |
| Already authorized / permission revoked | No unsolicited prompt when authorized; revocation is reflected and recording still works. |
| Recording and screen-permission recovery | No overlapping prompts, save interruption or focus stealing from an automatically deferred prompt. |
| Focus or banners disabled | No false “permission denied” claim; test requests and actual visual delivery are reported separately. |
| Technical failure | Query/request/native-load/settings-open failures produce usable fallback and logs, without repeated prompts or hangs. |

- [ ] Regress start/stop/save/playback with screen and system audio, saved-banner click/Finder reveal, and a new recording during pending saved notification. Record actual behaviors tested and remaining gaps.
- [ ] Validate an installed release-style signed package using the release packaging path and production bundle identity. Record version/commit, signing facts, OS, permission state and evidence. A locally signed development bundle alone does not establish downloaded-release behavior. After a separately authorized publication, verify the downloaded public artifact and append that evidence; do not claim this check was done beforehand.

## Completion and boundaries

No commit, push, tag or publication is authorized by this plan. No APNs service, auto-update system, screen-permission redesign or platform expansion is included. Do not reset a user's existing notification preferences merely to create a test fixture.

Complete the implementation and local release-style acceptance, preserve failures and untested cases in the bilingual [verification record](../docs/verification/README.md), update [desktop design](../docs/system-design/desktop.md) and relevant Help/install guidance with translations, then follow [plan completion](README.md#completing-a-plan). Public-download acceptance remains explicitly tracked as release follow-up if unpublished.

## Technical references

- [Apple: asking permission to use notifications](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications): native authorization request and contextual guidance.
- [Electron: notifications](https://www.electronjs.org/docs/latest/tutorial/notifications): macOS signing requirement; inspect the resolved version before choosing APIs.
- [Electron: Notification API](https://www.electronjs.org/docs/latest/api/notification): delivery API and lifecycle events.
