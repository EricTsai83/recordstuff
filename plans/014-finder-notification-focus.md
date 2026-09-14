# 014 Finder Foreground After Notification Click

[English](014-finder-notification-focus.md) | [繁體中文](014-finder-notification-focus.zh-TW.md)

Status: Planned after 010; coordinate with 013 for the next release. Updated: 2026-09-15.

## Problem and outcome

The v0.1.0 user test selected the correct recording in Finder, but Finder stayed behind other windows. Existing tray tests mock shell.showItemInFolder and verify a deferred request, not native foreground state. An explicit saved-notification click should reveal the correct file and bring its Finder window forward; recording completion alone must not steal focus.

## Work and acceptance

1. Reproduce on the installed signed app with another app in front. Record Finder state (closed, open behind, minimized, and another Space/full-screen app where feasible), notification delivery/click timing, selected file and actual foreground app/window. Check the menu's reveal action as a control. Preserve the user's current desktop state where practical.
2. Investigate current Electron/macOS APIs and choose the smallest supported solution. Do not rely on arbitrary repeated delays or claim that a logged request establishes foreground success. Do not add Accessibility/Automation permission requirements or shell command interpolation just to force Finder forward; document any unavoidable OS limitation.
3. Add focused regression tests for the chosen trigger/callback and failure behavior. Only explicit user reveal actions may activate Finder; saving in the background must remain silent. Cover paths with spaces/non-ASCII characters and ensure errors do not disrupt recording or lose files.
4. Verify the native installed-app behavior in the reproduced scenarios, including English and Traditional Chinese notification actions. Record file selection separately from foreground success. Mock unit tests alone cannot close this plan. If an OS restriction prevents the intended behavior, document evidence and leave the unresolved outcome explicit instead of declaring a fix.
5. Run pnpm check and relevant manual checks; update desktop design, verification, release notes and translations. Ship fixed bytes under a new version, potentially together with 013. Never replace v0.1.0 assets.

No general window manager, focus polling service, notification redesign, or recording-path change is included.
