# 010 Downloadable macOS Release

[English](010-downloadable-macos-release.md) | [繁體中文](../docs/zh-TW/plans/010-downloadable-macos-release.md)

Status: Pending. Updated: 2026-09-14.

## Outcome

A recipient can download a versioned macOS arm64 DMG from a stable URL, install RecordStuff into Applications, complete normal per-app security/recording prompts, and record without developer tools or certificates. The app defaults to English and offers persistent Traditional Chinese. No Apple certification, notarization, App Store, Windows/Linux release, or other-machine verification is required.

“Ready to use” does not mean a warning-free first launch: the self-signed app may need Open Anyway. No automatic updater is required.

## Existing foundation

The self-signing script validates a fixed identity, builds and verifies nested app signatures, then creates a DMG with bilingual installation instructions. A prior arm64 package passed local install, recording, permissions, Retina, and same-identity update checks. New UI language changes have not yet been included in a verified release artifact. No public download is claimed.

## Work

1. **Make packaging unambiguous.** Make the documented/default Mac release command use the chosen self-signed workflow. Remove obsolete notarization assumptions from the primary release configuration or clearly isolate unused legacy commands. Preserve fixed identity, entitlements, failure-on-invalid-signature, and publish-never during local build. Do not weaken security checks or introduce automatic TCC resets.
2. **Prepare the release artifact.** Choose a version that identifies the final contents, run pnpm check, build the arm64 DMG, verify signatures and mounted contents, include installation guides, and generate SHA-256 from the exact final bytes. Keep private keys out of assets. Record version, source revision/dirty-tree status, platform, size, and checksum; never reuse a previous binary's hash for a rebuild.
3. **Check the installed language-enabled build.** On the available Mac, install the candidate, verify English defaults with an isolated settings fixture where feasible, switch to Traditional Chinese, relaunch and check persistence, save a short recording, confirm playback/audio and localized notification actions, and verify quit/update behavior. Reuse applicable historical evidence, but do not claim the old package tested the new language feature. No clean-account/second-Mac requirement is added.
4. **Prepare a stable download.** Use the project's GitHub Releases if its repository visibility permits recipients to download assets; otherwise choose an accessible static download location. Confirm the destination before publication if still unknown. Prepare release notes and DMG/checksum assets first. Do not make a private source repository public merely to expose downloads, and do not claim an unpublished draft is downloadable by recipients.
5. **Validate actual download and install.** After authorized publication, download the actual asset through a browser on the available Mac; compare SHA-256, mount/copy/open normally, record the quarantine/Gatekeeper behavior and any Open Anyway step, then short-record and play the result. Existing grants/caches can limit what the same Mac proves: record that limitation, not a universal fresh-machine pass. Do not strip quarantine to manufacture success.
6. **Finish the public entry points.** Add the real download URL/version/architecture/checksum, English and Chinese release notes, installation/update instructions, verified-platform statement, and a reporting route. Readers must not encounter dead links, a placeholder download badge, or an unverified Windows/Linux support promise.

## Completion criteria

- The actual final DMG and checksum are downloadable by intended recipients at a recorded stable URL.
- The downloaded bytes match the validated artifact, and installation/capture/playback results on the available Mac are documented, with permission-history limits.
- English and Traditional Chinese UI/installation instructions match the shipped build.
- README links directly to the download and states macOS-only verification plus self-signing limitations.
- No developer dependencies/certificates are required on the recipient machine.

Publishing and download-path testing are actual remaining work, not completed by writing this plan. Keep it pending until implementation starts and record concrete blockers/results during execution.
