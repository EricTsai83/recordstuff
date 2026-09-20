# Remaining Work

[English](README.md) | [繁體中文](README.zh-TW.md)

Updated: 2026-09-20. v0.1.2 is published from tag `v0.1.2` with the simplified DMG; see [0.1.2 evidence](../docs/verification/releases/0.1.2.md). 013 and 016 are complete and removed; the recording shortcut and its unattended acceptance (`pnpm acceptance`) are documented in [desktop design](../docs/system-design/desktop.md#recording-shortcut), [tooling](../docs/system-design/tooling.md) and the [verification record](../docs/verification/README.md). Releases follow [release automation](../docs/system-design/releases.md): the tag is the version and CI records each release back on main.

017 is complete: saved-notification timing, two consecutive 15/15 runs, cancellation, overlap and playback checks are recorded in [verification](../docs/verification/README.md#saved-notification-timing--2026-09-20).

014 is complete and removed: the maintainer accepted the bilingual 30/30 local notification matrix as plan completion. Historical uncertainty and untested cases remain documented in [verification](../docs/verification/README.md#notification-lifetime-investigation--2026-09-20). Publication and public-build checks belong to a separately requested release.

## Order and status

| Order | Plan | Status | Completion target |
| --- | --- | --- | --- |
| Next | [012 Official website](012-download-website.md) | Ready to execute (English-only Astro site styled after T3 Code in `website/`, build-time verified manifest, Vercel set up by the maintainer; three variants compared before deployment) | Product/help website with direct DMG downloads and version/checksum details |
| After the website is live | [018 In-app update check](018-app-update.md) | Ready to execute; replaces the deferred 015 assessment, which the maintainer closed on 2026-09-20 by choosing to build the check | A tray check against the published version feed that points at the download; installation stays manual |

Publishing is automated by tag push; installed-app updates stay manual. 018 adds a check that reports a newer version and links to it; it does not authorize downloading or installing an update from inside the app. Public release notes stay English-only; app UI and reader guides remain bilingual. Published release bytes must not be overwritten.

No dedicated uninstaller is planned: quit and move the app to Trash; user data remains unless separately removed. No native-platform rewrite solely for size reduction, Apple certification, Windows/Linux/Intel verification or expansion is scheduled. DMG size was explained by Electron's runtime cost; discussion alone does not create a rewrite project.

All plan language versions live in this directory: English `<name>.md`, Traditional Chinese `<name>.zh-TW.md`.

## Completing a plan

Keep plans limited to unfinished work. Capture durable conclusions in [system design](../docs/system-design/README.md) and [verification](../docs/verification/README.md), update README/index and translations, then remove completed plans and their translations. Preserve failures and historical evidence; Git retains execution history.
