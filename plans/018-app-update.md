# 018 In-App Update Check

[English](018-app-update.md) | [繁體中文](018-app-update.zh-TW.md)

Status: Ready to execute. The [official website](https://record.ericts.com) is live and Plan 012 is closed; this plan adds the version feed to the site. Updated: 2026-09-20.

This plan replaces `015-app-update-assessment.md`. That file existed to decide whether an update mechanism was worth building; the maintainer took the decision on 2026-09-20 and asked for the work itself, so the assessment is folded into the decision table below and the file is removed. Until this plan ships, the app still does not check for updates and the READMEs, installation guide and website Help continue to describe manual replacement.

## Outcome

RecordStuff tells the user when a newer released version exists and takes them to its download, without background polling, telemetry, silent installation or a new signing identity. Installing an update stays a manual download-and-replace until a Developer ID makes a self-installing update honest.

## Decision taken (the 015 comparison, resolved)

| Option | Decision | Reason |
| --- | --- | --- |
| Keep manual downloads only | Rejected | The user has no way to learn that a release exists; the release workflow already publishes verified metadata that the app could read. |
| User-triggered and launch-time check, with a link to the download | **Chosen** | Delivers the whole benefit (knowing an update exists) for one HTTPS request against a static file. No updater dependency, no changed install path, no new failure mode inside `/Applications`. |
| Full automatic updater (download, install, relaunch) | Deferred, not scheduled | Squirrel.Mac through `electron-updater` requires a Developer ID-signed and notarized app. RecordStuff ships a fixed self-signed identity and Apple certification stays out of scope ([releases](../docs/system-design/releases.md)); an auto-installed build would fail Gatekeeper on relaunch and could leave a broken app in `/Applications`. Revisit only with a Developer ID, in a separate plan. |

## Phase 1. Version feed

1. Publish a stable feed URL from the website build: `/{site}/release.json`, generated from the verified `website/release-manifest.json`, carrying version, tag, DMG name, size, SHA-256, published date, release page URL and the site's download page. No new backend; it is a static file deployed with the site.
2. The feed must be servable with a short cache lifetime and must never advertise a release the manifest did not verify against the published assets (the existing manifest rules already enforce this).
3. Fallback when the site is unreachable: the GitHub releases API for the repository. The app must treat a failed check as "unknown", never as "up to date".
4. Website test: the built output contains `release.json` and its version matches the manifest.

## Phase 2. The check inside the app

1. Tray menu item **Check for updates…** (bilingual, following the existing menu strings), which performs one request, reports its own result, and is disabled while a check runs.
2. A check at launch, at most once per 24 hours, controlled by a preference (`Check for updates on launch`) the user can switch off. No timer polls while the app is running, no identifiers, no query parameters that could identify the installation.
3. Recording safety: never start a check, show a dialog or change the tray title while a recording is in progress; defer to the next opportunity.
4. Comparison rules: semantic version comparison against `app.getVersion()`; ignore equal or older versions, prereleases and any feed entry whose platform/architecture does not match the running app.
5. Failure handling: the launch check fails silently to the log; the manual check states plainly that the check failed and offers the releases page. Timeouts are bounded and cancellable at shutdown.

## Phase 3. What the user sees

1. Menu states: idle (`Check for updates…`), checking, up to date with the local time of the last successful check, and `Update available: X.Y.Z` opening the download page in the browser.
2. No new notification types unless the maintainer asks: the tray menu is the surface. The update entry must not push the recording controls out of their position at the top of the menu.
3. Copy changes when this ships: remove "does not check for updates" from website Help, the README pair and the installation guide pair, and update `scripts/release.test.ts`, which currently asserts that release notes say `no automatic updater`.

## Phase 4. Verification

1. Unit tests: version comparison (newer, equal, older, prerelease, malformed), feed with missing fields, HTTP error, timeout, architecture mismatch, preference off, recording in progress, shutdown during a pending check.
2. Local acceptance on an installed build: an older installed version against a feed serving a newer version shows the update entry and opens the correct download page; the same run with a recording in progress shows no update UI until the recording ends; an offline run leaves the menu unchanged and logs the failure.
3. Record in [verification](../docs/verification/README.md) what was actually exercised, including whatever was not: a real user-visible upgrade of a published build is only proven once a newer release exists.

## Boundary

No `electron-updater` or other updater dependency, no automatic download of the DMG, no silent installation, no background polling loop, no telemetry, no new signing identity and no change to how the app is installed. Nothing in this plan authorizes replacing an installed app from within the app.

## Completion

The tray offers a working manual check and an optional launch check against the published feed, tests cover the failure paths, the local acceptance run is recorded in the verification record, and the documentation no longer says the app cannot check for updates. Then remove this plan and its translation.
