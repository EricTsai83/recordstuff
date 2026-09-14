# 013 macOS Installation Experience

[English](013-macos-installation-experience.md) | [繁體中文](013-macos-installation-experience.zh-TW.md)

Status: Planned follow-up after 010; before the next installer release. Updated: 2026-09-15. Planning only; do not replace published v0.1.0 assets.

## Outcome

A simple DMG presents RecordStuff → Applications without any bundled installation/help documents. Users can find first-launch, manual-update, and uninstall guidance before downloading. This does not depend on release automation (011) or a website (012).

## Work

1. Remove INSTALL.md and INSTALL.zh-TW.md from the visible DMG contents in electron-builder.local.yml. Include only the App, Applications shortcut, and a clear drag-to-install background as the installation UI. Adjust the Finder window and icon layout so no scrolling, clipping, or ambiguous extra icons appear. Keep Markdown as documentation source rather than deleting the guides.
2. Put concise installation and self-signing guidance in the English GitHub Release notes, linking to maintained English/Traditional Chinese guides. Cover Open Anyway, screen/system-audio permissions, and relaunch. Link the same guides from 012 when that site exists; do not require a website to ship this change.
3. Do not bundle installation/help files in any format (Markdown, PDF, TXT, HTML or web shortcuts). The user explicitly wants no instruction documents in the installer. Keep help on GitHub and the official website; do not hide guides elsewhere in the DMG as a workaround. This does not remove runtime license notices required inside the app.
4. Document the existing manual update: stop recording, quit, download the new DMG, and replace the App at the same Applications path. Preserve the fixed signing identity and user settings. Automatic app updates are not implemented and are not added by this plan; 011 automates release production/publication only.
5. Document ordinary macOS removal: stop recording, quit, move RecordStuff.app from Applications to Trash. Explain that settings/cache in ~/Library/Application Support/recordstuff, logs in ~/Library/Logs/recordstuff, and recordings (default ~/Movies/RecordStuff, or the user's chosen folder) remain. Describe optional personal-data cleanup separately; never delete recordings automatically. No dedicated uninstaller, background service, or automatic TCC reset is introduced.
6. Ship changed bytes under a new unused version, with a source commit/tag, fresh checksum, and the established signature checks. Verify the actual mounted layout, guide access, browser download/install, existing-installation replacement with settings retained, and a short recording/playback on the available Mac. Verify removal on an isolated disposable copy without deleting user recordings/settings. Update README, tooling, verification records, and translations. Keep 010's outstanding download-path evidence separate.

## Reference and acceptance

T3 Code's [current official packaging configuration](https://github.com/pingdotgg/t3code/blob/main/scripts/build-desktop-artifact.ts) was checked on 2026-09-15: its DMG contents list only the App and /Applications link, plus a themed background. This is source-configuration evidence, not inspection of every released DMG. Recheck when implementing if using it as a reference.

The next DMG contains no installation/help documents, the installation path is obvious, and help remains accessible. Update/removal instructions reflect actual behavior. The existing v0.1.0 remains unchanged. No automatic updater, Apple certification, other-platform work, or Finder notification-focus fix is included.

Coordinate notification fixes with [014](014-finder-notification-focus.md); app update feasibility is tracked separately in deferred [015](015-app-update-assessment.md). Ejecting a DMG is not uninstalling the app. Any temporary test backup should have a recorded purpose and be cleaned up after verification and settings restoration, without touching user recordings.
