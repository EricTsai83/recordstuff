# 010 Downloadable macOS Release

[English](010-downloadable-macos-release.md) | [繁體中文](../docs/zh-TW/plans/010-downloadable-macos-release.md)

Status: In progress. Updated: 2026-09-15.

## Execution status — 2026-09-15

Published [v0.1.0](https://github.com/EricTsai83/recordstuff/releases/tag/v0.1.0) from clean source 2746d1b after 255 tests, signing/content checks and installed-candidate recording/language checks. See [artifact and verification evidence](../docs/verification/releases/0.1.0.md). Finder selects the notified file but did not come forward; disclosed in release notes. Browser asset navigation hit ERR_BLOCKED_BY_CLIENT; actual browser-download hash/install/recording remains open. Keep this plan until that path is verified.

## Outcome

A recipient can download a versioned macOS arm64 DMG from a stable URL, install RecordStuff into Applications, complete normal per-app security/recording prompts, and record without developer tools or certificates. The app defaults to English and offers persistent Traditional Chinese. No Apple certification, notarization, App Store, Windows/Linux release, or other-machine verification is required.

“Ready to use” does not mean a warning-free first launch: the self-signed app may need Open Anyway. No automatic updater is required.

## Priority and release destination

Execute this plan first. It is the first GitHub release, not a prerequisite packaging project followed by another first-release plan. Build and validate locally using the existing fixed self-signing identity, then publish the exact validated bytes to `EricTsai83/recordstuff`. The repository was confirmed public and had no releases on 2026-09-15. No release workflow exists yet, and CI automation or a website is not required for this delivery.

The future stable entry is `https://github.com/EricTsai83/recordstuff/releases/latest`; use a version-specific release URL for verification evidence. These are planned destinations, not a claim that a downloadable release exists. Planning does not itself authorize public publication; apply the user’s execution authorization when implementation starts and do not ask again if publication is already authorized.

## Existing foundation

The self-signing script validates a fixed identity, builds and verifies nested app signatures, then creates a DMG with bilingual installation instructions. A prior arm64 package passed local install, recording, permissions, Retina, and same-identity update checks. New UI language changes have not yet been included in a verified release artifact. No public download is claimed.

## Work

1. **Make packaging unambiguous.** Make the documented/default Mac release command use the chosen self-signed workflow. Remove obsolete notarization assumptions from the primary release configuration or clearly isolate unused legacy commands. Preserve fixed identity, entitlements, failure-on-invalid-signature, and publish-never during local build. Do not weaken security checks or introduce automatic TCC resets.
2. **Prepare the release artifact.** Choose a version that identifies the final contents, run pnpm check, build the arm64 DMG, verify signatures and mounted contents, include installation guides, and generate SHA-256 from the exact final bytes. Keep private keys out of assets. Record version, source revision/dirty-tree status, platform, size, and checksum; never reuse a previous binary's hash for a rebuild.
3. **Check the installed language-enabled build.** On the available Mac, install the candidate, verify English defaults with an isolated settings fixture where feasible, switch to Traditional Chinese, relaunch and check persistence, save a short recording, confirm playback/audio and localized notification actions, and verify quit/update behavior. Reuse applicable historical evidence, but do not claim the old package tested the new language feature. No clean-account/second-Mac requirement is added.
4. **Prepare the GitHub release.** Finalize release-affecting changes in a source commit before building the release candidate; the version tag must identify that exact source. Choose an unused version consistent with package.json. Prepare a draft release for `EricTsai83/recordstuff`, with the arm64 self-signed DMG, SHA256SUMS, and English/Traditional Chinese notes covering changes, installation, supported/verified platform, and limitations. Record tag, source commit, file names, sizes, and checksums. Upload the already validated bytes without rebuilding. Check draft assets before authorized publication; a draft is not public delivery. Retain the local build's `--publish never`: upload is a separate explicit step.
5. **Validate actual download and install.** After authorized publication, download the actual asset through a browser on the available Mac; compare SHA-256, mount/copy/open normally, record the quarantine/Gatekeeper behavior and any Open Anyway step, then short-record and play the result. Existing grants/caches can limit what the same Mac proves: record that limitation, not a universal fresh-machine pass. Do not strip quarantine to manufacture success.
6. **Finish the public entry points.** Add the real download URL/version/architecture/checksum, English and Chinese release notes, installation/update instructions, verified-platform statement, and a reporting route. Readers must not encounter dead links, a placeholder download badge, or an unverified Windows/Linux support promise.

## Failure handling and subsequent work

A failed signature, checksum, install, or recording check blocks declaring this release complete. If the published download fails validation, document the failure and correct the download guidance promptly; ship corrected bytes under a new version instead of silently replacing an already published asset. Do not describe an unverified first release as ready to use.

After this plan completes, [011 release automation](011-github-release-automation.md) can reduce repeated work, and [012 download website](012-download-website.md) can provide a product entry point. Neither is required to complete 010, and 012 does not depend on 011.

## Completion criteria

- The actual final DMG and checksum are downloadable by intended recipients at a recorded stable URL.
- The downloaded bytes match the validated artifact, and installation/capture/playback results on the available Mac are documented, with permission-history limits.
- English and Traditional Chinese UI/installation instructions match the shipped build.
- README links directly to the download and states macOS-only verification plus self-signing limitations.
- No developer dependencies/certificates are required on the recipient machine.

Publishing and download-path testing are actual remaining work, not completed by writing this plan. Keep it pending until implementation starts and record concrete blockers/results during execution.
