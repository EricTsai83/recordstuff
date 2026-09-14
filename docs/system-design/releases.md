# GitHub release automation

[English](releases.md) | [繁體中文](../zh-TW/system-design/releases.md)

Updated: 2026-09-15. CI and draft creation are verified. 011 remains in progress until manual acceptance and public delivery; see [0.1.1](../verification/releases/0.1.1.md) for live evidence. Manual installation acceptance is not yet claimed.

## Release contract

[release.yml](../../.github/workflows/release.yml) uses `macos-15` with an arm64 runtime assertion, Node 24.21.0, pnpm 10.33.4 and frozen lockfile installation, preserving 010's toolchain. Actions are pinned to full commit SHAs; recheck upstream when updating. The DMG still includes the App, Applications link, and bilingual installation guides; 013 has not shipped.

Sequence: source/version checks → code checks → import fixed identity → `pnpm dist:mac` → mounted verification → candidate artifact → independent verification job → draft. Build has contents:read; only draft/promote jobs have contents:write. Signing secrets are supplied only to the build signing step. There is no PR trigger. The release environment permits main and v* tags, controlled by trusted repository maintainers. One concurrency group serializes release workflows without cancelling running releases.

The certificate fingerprint is pinned to `01B373511530BBF287CA35E54C10A5F017AAD637`. Each build imports encrypted PKCS#12 into a temporary keychain, configures codesign key access and certificate-specific Code Signing trust. Missing secrets or a wrong identity stop the build; no unsigned fallback exists. A trap and always cleanup remove certificate files, keychain, and trust. This supports disposable GitHub-hosted runners, not persistent runners without adaptation.

## Operation

Set package.json to an unused stable version, check, commit, and push main. Dispatch a candidate:

```bash
gh workflow run release.yml --ref main -f operation=candidate -f tag=v0.1.1
```

Alternatively push a `vX.Y.Z` tag matching package.json. Any draft or public release reserves the version; never overwrite or automatically delete it. An existing tag without a release is accepted only when it points to the same source commit. The draft job creates a missing tag after successful candidate validation; a tag created with the GitHub token does not retrigger the build.

Download all three draft assets, check the checksum, mount and install the DMG, then test recording, system-audio playback, language switching/persistence, menu quit and relaunch. Preserve the known notification/Finder foreground limitation.

```bash
gh release download v0.1.1 --dir /tmp/recordstuff-candidate-0.1.1
cd /tmp/recordstuff-candidate-0.1.1
shasum -a 256 -c SHA256SUMS
```

Only after manual acceptance, select promote in Actions, enter the SHA-256 of the candidate actually installed, and check manual_acceptance. Equivalent command:

```bash
gh workflow run release.yml --ref main -f operation=promote -f tag=v0.1.1 -f sha256=ACTUAL_VERIFIED_SHA256 -f manual_acceptance=true
```

This is the operator's attestation for those bytes; CI cannot establish the manual interactions. Promotion checks out the candidate tag, downloads the existing draft, and rechecks signatures, mounted contents, metadata, SHA256SUMS, tag source and GitHub asset digests before making the draft public. It never rebuilds or replaces assets. A public browser download/hash check remains required; API downloading is not browser installation evidence.

## Tool boundaries and failures

`node scripts/release.mts preflight|candidate|verify|draft|promote vX.Y.Z [directory]` shares local and CI validation. `candidate` computes SHA256SUMS and release.json from final DMG bytes, recording version, source commit, repository, platform, filename, size, SHA-256, certificate fingerprint, app.asar hash, Node and pnpm.

`start-app.mjs --verify-app APP_PATH` uses only the public `RECORDSTUFF_SIGN_IDENTITY` SHA-1 and reuses existing deep signature, certificate, identifier, runtime and designated requirement checks. It requires no private key, build or app launch. Verification/draft/promotion check DMG integrity, packaged version and arm64, guide bytes, Applications link, and visible root contents.

Wrong/reused versions, missing identities and signature/checksum/metadata mismatches stop delivery. An interrupted upload may leave an incomplete draft, never an automatically public release. Preserve failure evidence and handle that draft explicitly before retrying or choosing a new version. Do not remove verification gates to unblock delivery.

Apple notarization, automatic App updates, Windows/Intel delivery and warning-free installation remain outside scope. See [signing design](signing.md) for T3 Code comparisons.

After frozen installation, CI explicitly runs Electron 44 install.js because the package has no postinstall. cleanup-release-keychain.py bounds each OS cleanup operation to 15 seconds, warns on failure, and removes temporary files. Disposable runner teardown removes any remaining OS state.

For local verify/draft/promote, check out the source commit recorded in release.json. CI promotion checks out the candidate tag automatically. Later documentation commits on main do not change candidate bytes.
