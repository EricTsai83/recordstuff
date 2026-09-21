# Remaining Work

[English](README.md) | [繁體中文](README.zh-TW.md)

Updated: 2026-09-21. v0.1.3 is published from tag `v0.1.3` with the simplified DMG; see [0.1.3 evidence](../docs/verification/releases/0.1.3.md). 013 and 016 are complete and removed; the recording shortcut and its unattended acceptance (`pnpm acceptance`) are documented in [desktop design](../docs/system-design/desktop.md#recording-shortcut), [tooling](../docs/system-design/tooling.md) and the [verification record](../docs/verification/README.md). Releases follow [release automation](../docs/system-design/releases.md): the tag is the version and CI records each release back on main.

017 is complete: saved-notification timing, two consecutive 15/15 runs, cancellation, overlap and playback checks are recorded in [verification](../docs/verification/README.md#saved-notification-timing--2026-09-20).

014 is complete and removed: the maintainer accepted the bilingual 30/30 local notification matrix as plan completion. Historical uncertainty and untested cases remain documented in [verification](../docs/verification/README.md#notification-lifetime-investigation--2026-09-20). Publication and public-build checks belong to a separately requested release.

012 is complete and removed: the [official website](https://record.ericts.com) is live, and the maintainer confirmed the launch and requested documentation-only closure on 2026-09-20. See the [verification record](../docs/verification/README.md#plan-012-closure--2026-09-20) for the closure basis and historical verification scope. 018 is now complete.

## Order and status

Next: [019 — Notification permission guidance](019-notification-permission.md) (in progress). Settings now carries a Notifications switch and a macOS settings-pane action instead of an authorization status the app cannot read; see the [design decision](019-notification-permission.md#design-decision--2026-09-21). Remaining: reproduce the original report, and native acceptance that the switch reaches real delivery on a signed package.

Then: [020 — Custom recording shortcut](020-custom-shortcut.md) (not started). The shortcut offers four presets and Off, so a user whose own apps already own all four is left with Off. 020 adds a recorded custom combination behind a shared validator, suspends the live registration while a new one is recorded, and keeps the existing reporting for a combination the OS refuses.

Then: [021 — Choose which screen to record](021-screen-selection.md) (not started). The display-media handler always resolves the primary display, so a second screen cannot be recorded at all. 021 adds a Screen choice in Settings → Recording, keeps Primary display as the default, stores a fingerprint that can survive a reconnect, and refuses the start with a stated reason rather than recording a different screen when the stored choice cannot be resolved.

018 local acceptance, public feed delivery and 0.1.3 publication are complete; see the [closure record](../docs/verification/README.md#plan-018-closure--2026-09-20). Untested cases remain documented in verification.

Publishing is automated by tag push; installed-app updates stay manual. 018 adds a check that reports a newer version and links to it; it does not authorize downloading or installing an update from inside the app. Public release notes stay English-only; app UI and reader guides remain bilingual. Published release bytes must not be overwritten.

No dedicated uninstaller is planned: quit and move the app to Trash; user data remains unless separately removed. No native-platform rewrite solely for size reduction, Apple certification, Windows/Linux/Intel verification or expansion is scheduled. DMG size was explained by Electron's runtime cost; discussion alone does not create a rewrite project.

All plan language versions live in this directory: English `<name>.md`, Traditional Chinese `<name>.zh-TW.md`.

## Completing a plan

Keep plans limited to unfinished work. Capture durable conclusions in [system design](../docs/system-design/README.md) and [verification](../docs/verification/README.md), update README/index and translations, then remove completed plans and their translations. Preserve failures and historical evidence; Git retains execution history.
