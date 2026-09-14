# 011 GitHub Release Automation

[English](011-github-release-automation.md) | [繁體中文](011-github-release-automation.zh-TW.md)

Status: CI, manual acceptance and public promotion passed; public browser-download checksum pending. Updated: 2026-09-15.

Signing background and provisioning contract: [macOS signing identities and self-signing](../docs/system-design/signing.md). CI provisioning remains pending under this plan.

## Outcome and dependencies

An explicit version tag or manual GitHub Actions run produces a traceable macOS arm64 release candidate with consistent signing, checksums, and English release notes with links to bilingual installation guidance. Reuse the release contract established by 010. First-release delivery must not wait for this plan. A website is independent.

## Work

1. Capture the known-good Node/pnpm versions, lockfile installation, build command, artifact names, and verification checks from 010. Use one canonical packaging path locally and in CI. Reject a tag/package version mismatch and an already published version.
2. Resolve signing before selecting the build runner. The current script requires a fixed self-signed identity in Keychain. Use the same identity in a temporary CI keychain only when secure certificate provisioning is available; use repository/environment secrets for certificate and password, mask output, and clean up even on failure. Never commit credentials or generate a different signing identity per release. Do not weaken certificate or bundle verification to make CI pass. If identity provisioning is unavailable, retain local builds and automate validation/upload of the verified candidate instead; document that this is partial automation.
3. Add a macOS arm64 workflow that runs the established checks and packaging, verifies signatures and mounted contents, and computes SHA256SUMS from final bytes. Save source commit, version, platform, sizes, and checksums alongside the candidate. Pin tool/action versions deliberately. Keep signing credentials unavailable to untrusted pull requests, restrict release writes to the publishing job, and serialize releases so concurrent runs do not overwrite a version.
4. Create a draft GitHub Release only after required checks succeed. Keep public publication as an explicit promotion of the reviewed, installed candidate; do not rebuild during promotion. Manual recording/playback and language checks remain required where CI cannot establish them. Preserve release notes and the self-signing installation guidance from 010.
5. Verify a successful draft and failure paths for mismatched version, missing identity, invalid signature/checksum, and duplicate version using nonpublic candidates or focused checks. Confirm failures cannot publish a public release. Complete an authorized real release and browser download/hash validation before claiming the automated delivery path is proven.

## Completion criteria

- The documented trigger produces a traceable, correctly signed arm64 candidate and checksum without exposing credentials.
- Failed required checks prevent promotion; existing published bytes are not overwritten.
- At least one real release and downloaded artifact are verified; manual checks and any remaining local build step are documented honestly.
- Update tooling/design, verification records, README instructions, and translations.

## Scope and reference

No Windows/Linux/Intel Mac expansion, Apple certification/notarization, Nightly channel, npm distribution, or automatic app updater is included. T3 Code’s [release orchestration](https://github.com/pingdotgg/t3code/blob/main/.github/workflows/release.yml) and [desktop build](https://github.com/pingdotgg/t3code/blob/main/.github/workflows/release-desktop.yml) illustrate build jobs followed by asset aggregation and GitHub publication; its full multi-platform pipeline is not required here. Recheck upstream implementation when executing this plan.

App-side update delivery is separate; see [015](015-app-update-assessment.md). Use the latest packaging contract from [013](013-macos-installation-experience.md) when it has shipped.

Implementation/operation: [release automation](../docs/system-design/releases.md). Live success/failure evidence: [0.1.1](../docs/verification/releases/0.1.1.md). Retain this plan until final manual acceptance and delivery verification.
