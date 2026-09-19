# Remaining Work

[English](README.md) | [繁體中文](README.zh-TW.md)

Updated: 2026-09-19. v0.1.2 is published from tag `v0.1.2` with the simplified DMG; see [0.1.2 evidence](../docs/verification/releases/0.1.2.md). 013 and 016 are complete and removed; the recording shortcut and its unattended acceptance (`pnpm acceptance`) are documented in [desktop design](../docs/system-design/desktop.md#recording-shortcut), [tooling](../docs/system-design/tooling.md) and the [verification record](../docs/verification/README.md). Releases follow [release automation](../docs/system-design/releases.md): the tag is the version and CI records each release back on main.

## Order and status

| Order | Plan | Status | Completion target |
| --- | --- | --- | --- |
| Next | [014 Finder notification focus](014-finder-notification-focus.md) | Planned | Reproduce and fix explicit-click foreground behavior; verify native focus |
| Ready for implementation | [012 Official website](012-download-website.md) | Planned | Bilingual product/help website with direct DMG downloads and version/checksum details |
| When update convenience is prioritized | [015 App update assessment](015-app-update-assessment.md) | Deferred decision only | Compare manual, user-triggered check and automatic update; establish self-signing feasibility |

014 does not require a website. Publishing is automated by tag push; installed-app updates are manual. 015 does not authorize implementation of an updater. Public release notes stay English-only; app UI and reader guides remain bilingual. Published release bytes must not be overwritten.

No dedicated uninstaller is planned: quit and move the app to Trash; user data remains unless separately removed. No native-platform rewrite solely for size reduction, Apple certification, Windows/Linux/Intel verification or expansion is scheduled. DMG size was explained by Electron's runtime cost; discussion alone does not create a rewrite project.

All plan language versions live in this directory: English `<name>.md`, Traditional Chinese `<name>.zh-TW.md`.

## Completing a plan

Keep plans limited to unfinished work. Capture durable conclusions in [system design](../docs/system-design/README.md) and [verification](../docs/verification/README.md), update README/index and translations, then remove completed plans and their translations. Preserve failures and historical evidence; Git retains execution history.
