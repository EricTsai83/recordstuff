# Remaining Work

[English](README.md) | [繁體中文](README.zh-TW.md)

Updated: 2026-09-23. v0.1.3 is published from tag `v0.1.3` with the simplified DMG; see [0.1.3 evidence](../docs/verification/releases/0.1.3.md). 013 and 016 are complete and removed; the recording shortcut and its unattended acceptance (`pnpm acceptance`) are documented in [desktop design](../docs/system-design/desktop.md#recording-shortcut), [tooling](../docs/system-design/tooling.md) and the [verification record](../docs/verification/README.md). Releases follow [release automation](../docs/system-design/releases.md): the tag is the version and CI records each release back on main.

017 is complete: saved-notification timing, two consecutive 15/15 runs, cancellation, overlap and playback checks are recorded in [verification](../docs/verification/README.md#saved-notification-timing--2026-09-20).

014 is complete and removed: the maintainer accepted the bilingual 30/30 local notification matrix as plan completion. Historical uncertainty and untested cases remain documented in [verification](../docs/verification/README.md#notification-lifetime-investigation--2026-09-20). Publication and public-build checks belong to a separately requested release.

012 is complete and removed: the [official website](https://record.ericts.com) is live, and the maintainer confirmed the launch and requested documentation-only closure on 2026-09-20. See the [verification record](../docs/verification/README.md#plan-012-closure--2026-09-20) for the closure basis and historical verification scope. 018 is now complete.

## Order and status

019 is complete and removed following the maintainer’s manual acceptance and the settings-flicker fix/regression checks. The existing Notifications overview → RecordStuff path is retained; historical findings and untested conditions remain in the [closure record](../docs/verification/README.md#plan-019-closure--2026-09-23).

020 is complete and removed following the maintainer’s acceptance of automated verification. Actual OS conflict and notification banners remain explicitly untested; existing native recording/playback, 14 failure/restart assertions and cleanup evidence are preserved in the [closure record](../docs/verification/README.md#plan-020-closure--2026-09-23).

023 is complete and removed; the maintainer requested final closure after the bitrate retest on 2026-09-23. Acceptance includes hybrid native entry, bilingual/capture/recording regression checks, 25 controlled integration assertions, three passing 30-second integrity retests and verified window cleanup. Historical failures and evidence limits are preserved in the [closure record](../docs/verification/README.md#plan-023-closure--2026-09-23). Next is 022.

021 is complete and removed following maintainer manual acceptance: unplugged-target refusal, recovery by choosing Primary, direct reconnect recovery, and capture termination/save/playback/feedback after removal during recording. Error visibility improvements belong to 022; evidence limits and untested scenarios remain in the [closure record](../docs/verification/README.md#plan-021-closure--2026-09-23).

Next: [022 — Settings panel visual design](022-settings-visual-design.md) (not started). The panel is the only window the app has, and every preference — including the two that are simply on or off — renders as the same full-width dropdown in the same card. 022 groups the rows into sections, lets main declare a switch, a segmented control or a popup menu per group, reports a failure at the control that failed, and follows the system accent instead of one hard-coded blue. It also refines focus, consolidates custom shortcut entry, and adds inline capture, key previews, local feedback and focus restoration within a refined macOS style. No preference, id, default or lock rule changes.

018 local acceptance, public feed delivery and 0.1.3 publication are complete; see the [closure record](../docs/verification/README.md#plan-018-closure--2026-09-20). Untested cases remain documented in verification.

Publishing is automated by tag push; installed-app updates stay manual. 018 adds a check that reports a newer version and links to it; it does not authorize downloading or installing an update from inside the app. Public release notes stay English-only; app UI and reader guides remain bilingual. Published release bytes must not be overwritten.

No dedicated uninstaller is planned: quit and move the app to Trash; user data remains unless separately removed. No native-platform rewrite solely for size reduction, Apple certification, Windows/Linux/Intel verification or expansion is scheduled. DMG size was explained by Electron's runtime cost; discussion alone does not create a rewrite project.

All plan language versions live in this directory: English `<name>.md`, Traditional Chinese `<name>.zh-TW.md`.

## Completing a plan

Keep plans limited to unfinished work. Capture durable conclusions in [system design](../docs/system-design/README.md) and [verification](../docs/verification/README.md), update README/index and translations, then remove completed plans and their translations. Preserve failures and historical evidence; Git retains execution history.
