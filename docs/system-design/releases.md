# GitHub release automation

[English](releases.md) | [繁體中文](../zh-TW/system-design/releases.md)

Updated: 2026-09-19. Pushing a version tag is the only release action: CI builds, signs, verifies and publishes in one run. The draft/promote flow with an in-pipeline manual acceptance gate was used for [0.1.1](../verification/releases/0.1.1.md) and retired the same day 0.1.2 was prepared; manual checks now happen before tagging. [0.1.2](../verification/releases/0.1.2.md) was the first release on this flow: tag push to public release in under three minutes.

## Release contract

[release.yml](../../.github/workflows/release.yml) builds and publishes only on `v*` tag pushes. There is no branch or pull-request trigger, so ordinary commits to main never build or publish anything. A manual dispatch with an existing tag runs only the post-publish verification job, never a build or publish. It uses `macos-15` with an arm64 runtime assertion, Node 24.21.0, pnpm 10.33.4 and frozen lockfile installation. Actions are pinned to full commit SHAs; recheck upstream when updating.

Sequence in one workflow run: tag/source checks → code checks (`pnpm check`) → import fixed identity → `pnpm dist:mac` → mounted verification → candidate artifact → independent publish job that reverifies without private keys and creates the public release → `verify-published` job that downloads the three assets anonymously from the public release URL, checks SHA256SUMS, reruns the mounted/signature/metadata gates and compares GitHub's own asset digests (`release.mts published`). The build job has contents:read; only the publish job has contents:write; the verification job needs neither secrets nor write access. Signing secrets are supplied only to the build signing step. The release environment permits `v*` tags, controlled by trusted repository maintainers. One concurrency group serializes release workflows without cancelling running releases.

Gates that stop a release, in order: the tagged commit is not an ancestor of `origin/main`; package.json version does not equal the tag without its `v`; the tree is not clean; a release for that tag already exists (drafts included); code checks fail; secrets are missing or the imported identity fingerprint is not `01B373511530BBF287CA35E54C10A5F017AAD637`; bundle signatures, identifiers, hardened runtime or designated requirement fail; the DMG root is not exactly `Applications` and `RecordStuff.app` plus permitted hidden Finder layout files; packaged version or architecture mismatch; candidate metadata or SHA256SUMS differ on reverification; the tag no longer points to the verified commit. No unsigned or partially verified fallback exists.

Version semantics: `vX.Y.Z` publishes as the latest release. `vX.Y.Z-suffix` (for example `v0.2.0-rc.1`, with package.json `0.2.0-rc.1`) publishes flagged as a pre-release and is never marked latest. Both use the same build and gates.

The certificate fingerprint is pinned. Each build imports encrypted PKCS#12 into a temporary keychain, configures codesign key access and certificate-specific Code Signing trust. A trap and always-cleanup remove certificate files, keychain, and trust. This supports disposable GitHub-hosted runners, not persistent runners without adaptation.

Since 0.1.2 the DMG contains only the App and the Applications link over a generated drag-arrow background; no help documents are bundled in any format. Installation, manual update and removal guidance lives in the release notes and the commit-pinned [installation guide](../../resources/INSTALL.md).

## Operation

Verification is a development activity, done before the tag exists. The checklist for a release commit:

1. Run `pnpm check`.
2. Run `pnpm start:app`: it builds, signs, verifies and opens the same App bundle CI will package. Make a short recording and play it back. This is the whole functional check; the DMG adds nothing for App behavior, and CI verifies DMG structure on every tag.
   Only when packaging configuration changed (electron-builder files, icons, background, DMG layout) also run `pnpm dist:mac`, open the DMG from `dist/` and confirm the Finder window shows the App, the arrow and Applications with nothing else.
3. Set package.json to an unused version, update documentation that names the version, and commit on main.
4. Tag and push:

```bash
git tag v0.1.2
git push origin main v0.1.2
gh run watch --exit-status "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

About ten minutes later `gh release view v0.1.2` shows the public release with three assets: the DMG, SHA256SUMS and release.json. Record the run link, size and SHA-256 in `docs/verification/releases/<version>.md`, then update the README download section. The `verify-published` job is the download check: it fetches what an anonymous user gets and reruns every artifact gate on GitHub's network, so no local re-download is needed. If it fails, the release stays public and the maintainer decides between a fix-forward version and leaving it; the job never unpublishes. To re-verify an existing release later, dispatch the workflow with its tag:

```bash
gh workflow run release.yml --ref main -f tag=v0.1.2
```

Rollback is a new version: never overwrite, delete or re-tag a published release. If the workflow fails before publishing, fix the source, bump the version, and tag again; a tag on a failed run may be left in place or deleted, but its version must not be reused for a release once any release object (even a partial one) exists for it. If a run fails after the release object was created, treat that version as consumed and handle the partial release by hand. Do not remove verification gates to unblock delivery.

## Tool boundaries and failures

`node scripts/release.mts preflight|candidate|verify|publish vX.Y.Z [directory]` shares local and CI validation. `preflight` requires a clean tree, a matching version and an unused release. `candidate` computes SHA256SUMS and release.json from final DMG bytes, recording version, source commit, repository, platform, filename, size, SHA-256, certificate fingerprint, app.asar hash, Node and pnpm. `verify` rechecks a candidate directory against those files. `published` does the same on files downloaded from the public URL and additionally requires the GitHub release to be non-draft with exactly those three assets, matching by name, size and GitHub-computed SHA-256 digest. `publish` rechecks, confirms the tag points at the verified commit, writes the English notes and creates the public release with `gh release create --verify-tag` (`--latest` or `--prerelease`).

`start-app.mjs --verify-app APP_PATH` uses only the public `RECORDSTUFF_SIGN_IDENTITY` SHA-1 and reuses existing deep signature, certificate, identifier, runtime and designated requirement checks. It requires no private key, build or app launch. `assertDmgContents` requires the root to contain exactly `Applications` and `RecordStuff.app` plus, at most, the hidden regular files `.DS_Store`, `.VolumeIcon.icns` and `.background.png`/`.background.tiff`; any other entry, any hidden directory or symlink, or a guide hidden with a leading dot fails the release.

CI cannot prove screen or system-audio capture: runners have no TCC grants. That is why recording is checked locally before tagging. What CI proves is that the committed source builds, signs with the pinned identity, packages to the expected layout, and that the published bytes are the verified bytes.

Apple notarization, automatic App updates, Windows/Intel delivery and warning-free installation remain outside scope. See [signing design](signing.md) for T3 Code comparisons.

After frozen installation, CI explicitly runs Electron 44 install.js because the package has no postinstall. cleanup-release-keychain.py bounds each OS cleanup operation to 15 seconds, warns on failure, and removes temporary files. Disposable runner teardown removes any remaining OS state.

For local `verify` or `publish`, check out the source commit recorded in release.json; later documentation commits on main do not change candidate bytes.
