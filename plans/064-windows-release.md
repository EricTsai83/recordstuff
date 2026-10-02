# 064 — Windows build, verification and release

[English](064-windows-release.md) | [繁體中文](064-windows-release.zh-TW.md)

Status: active since 2026-10-03, revised by the maintainer's decisions of that day. They replaced the same-day deferral at step 1 (no Windows machine) with the decision recorded in [design decisions](../docs/system-design/decisions.md): publish Windows x64 together with the macOS DMG through the same tag-triggered release, packaged and checked by GitHub Actions, without verification on Windows hardware ("the flow should be the same as Mac"). Progress on branch `windows-packaging`, not yet on main: step 1 is decided; steps 2, 5, 6 and 7 and the update-check part of step 4 are implemented. Waived by the decision: step 3's hardware round, the hardware smoke in step 8 and step 9. Remaining: the rest of step 4 (Windows-specific wording and a Windows version floor), which stays in this plan but does not block the release; step 8's pre-release rehearsal and first two-platform stable release, each only on the maintainer's explicit tag request; and the closure record. CI evidence so far: run 37040450544 passed both jobs: on Windows `pnpm check` (typecheck, 94 test files with 5 platform-skipped, build), `pnpm dist:win` and the `windows-smoke` install, inspection and uninstall of the 1.1.1-stamped installer. Its predecessors 062, 063 and 065 have closed ([062](../docs/verification/history-2026-10.md#plan-062-closure--2026-10-02), [063](../docs/verification/history-2026-10.md#plan-063-closure--2026-10-02), [065](../docs/verification/history-2026-10.md#plan-065-closure--2026-10-03)). Dependencies: step 8 requires steps 2 and 5–7 on main with both check jobs passing; the rest of step 4 does not gate step 8 and, if finished after it, ships in a later release; its macOS tray recheck uses 063's `pnpm acceptance:tray`. Independent of the deferred 058–060.

## Problem and evidence

This section records the state before the work began (2026-10-02). The decision it quotes was replaced on 2026-10-03, and the branch changed the items each step below marks as done.

RecordStuff ships only a self-signed macOS arm64 DMG. Windows is not merely unconfigured; it is excluded by an adopted decision. [Design decisions](../docs/system-design/decisions.md) record "macOS-only verification and packaging: … no `win`/`nsis` build target or `dist:win` script until a maintainer can verify on hardware", and [release automation](../docs/system-design/releases.md) lists "Windows/Intel delivery" as outside scope. The closed 034 drew the Windows tray artwork without a Windows machine; 035 waived its native check (N17), so nothing Windows-specific has ever run on Windows.

Inventory of the current tree (2026-10-02):

- **App code is partly portable.** Capture answers `setDisplayMediaRequestHandler` with `{ video: source, audio: "loopback" }` with no platform branch (`src/main/index.ts`), and Electron supports loopback system audio on Windows. The permission watcher runs on macOS only. Tray ICOs, the "system tray" first-run hint, Ctrl shortcut labels, `~/Videos/RecordStuff` and the 30 fps cap off macOS already exist. Unverified on Windows: `MediaRecorder` support for `video/mp4;codecs=avc1,mp4a.40.2` (otherwise `mp4_unsupported`), `restrictOwnAudio` with loopback, and toast notifications, which need a Start-menu shortcut whose AppUserModelID matches `app.setAppUserModelId("com.ericts.record")`.
- **Some wording is macOS on every platform.** "the Mac went to sleep" (`src/main/tray-model.ts`, `src/shared/session-record.ts`), the `no_audio_track` and `unsupported_os_version` guidance (`src/main/recording-result.ts`), "macOS reserves this combination" and the reserved macOS screenshot/Spotlight chords (`src/shared/hotkey.ts`), and "menu bar" in Settings (`src/main/settings-model.ts`). There is no Windows version floor.
- **The update check rejects Windows.** `feedVersion` requires a `dmg` block and `githubVersion` requires `platform === "darwin"` and the DMG asset (`src/main/updates.ts`). Installed macOS apps (1.1.1 and earlier) parse `https://record.ericts.com/release.json` and the GitHub latest release with exactly these rules, so their shape cannot change.
- **Release tooling is single-platform.** `scripts/lib/release-manifest.mts` fixes `PLATFORM = "darwin-arm64"`, one `dmg` block and exactly three assets; `scripts/release.mts` verifies with `hdiutil`, `plutil`, `lipo` and `start-app.mjs --verify-app`, writes a one-line SHA256SUMS, macOS-only notes, README text and record titles. `release.yml` runs build, publish and verification on `macos-15` with keychain signing; `start-app.mjs` throws off macOS.
- **Packaging.** `electron-builder.yml` has only `mac`/`dmg`; `extraResources` already ships `*.ico`. There is no `build/icon.ico` (`scripts/make-icons.mjs` writes `build/icon.png` at 512 px) and no `dist:win` script.
- **CI.** `check.yml` runs `pnpm check` on `macos-15` only. On `windows-latest` these tests would fail: POSIX separators expected from `path.join` (`src/main/tray.test.ts`, `src/main/recorder.test.ts`), `chmod`-based unreadable/unwritable fixtures (`src/main/session-sentinel.test.ts`, `src/main/settings.test.ts`), unguarded `/usr/bin/openssl` and shebang fakes (`scripts/create-signing-identity.test.ts`, `scripts/lib/audit-tools.test.ts`, `scripts/release-record.test.ts`), a README match that depends on LF endings, with no `.gitattributes`, and the symlink cases in `scripts/lib/runtime-inputs.test.ts`, which need a privilege Windows runners do not grant by default. `pnpm acceptance:recipe` supervises process groups and runs on macOS and Linux only (plan 061). Rename/unlink/hard-link behaviour on open files in the writer tests is untested there.
- **Website.** The manifest, `/release.json` feed and download, help and support pages are macOS-only and say Windows is not supported.
- **Acceptance tooling.** Every runner uses `osascript`, JXA, `pgrep` or `~/Library` paths; nothing can check a recording on Windows automatically.

## Target

One `vX.Y.Z` tag publishes one GitHub release carrying both the existing macOS DMG and a Windows x64 installer, or publishes nothing. Each platform is built, gated, published, re-downloaded anonymously and gated again on its own runner type. Already-installed macOS apps see no change in the feed or assets they read. The website offers both platforms, says that the Windows installer is unsigned and unverified on hardware, and describes its SmartScreen warning honestly. The release record states that Windows was checked by CI only and lists what is untested.

## Steps

Each step is independently completable and leaves the documents consistent.

### 1. Maintainer decision gate — decided 2026-10-03

The first answer that day, no Windows machine, deferred this plan; the maintainer then decided to publish without hardware verification ("Do not verify Windows for me, but let GitHub Actions do the packaging"). The answers, recorded in [design decisions](../docs/system-design/decisions.md) and its translation, replacing the "macOS-only verification and packaging" row and amending the manual-update row:

- **Verification hardware.** None. Windows evidence is CI only, from GitHub's `windows-2025` runners, and is labelled as such; there is no VM round.
- **Architecture.** x64 only; Windows on Arm stays out of scope.
- **Installer and the "no uninstaller" decision.** A per-user one-click NSIS installer (`oneClick: true`, `perMachine: false`, no admin prompt), chosen as the common practice: T3 Code (pingdotgg/t3code) ships one from the same GitHub release as its DMG. Its Start-menu shortcut carries the appId `com.ericts.record` as AppUserModelID, and it registers the Windows uninstaller in Settings → Apps with `deleteAppDataOnUninstall: false`, so uninstalling never deletes user data. The macOS rule (manual update, Trash removal) is unchanged; there is still no updater on either platform.
- **Signing.** Unsigned, with integrity carried by SHA256SUMS (one line per binary asset), `release-win32-x64.json` and a GitHub build-provenance attestation; the asset name `RecordStuff-<version>-x64-unsigned-setup.exe` states it. The options weighed are kept in [signing](../docs/system-design/signing.md#windows-installer-unsigned-by-decision).
- **Release coupling.** A Windows failure fails the whole tag before publication.
- **Minimum Windows version.** Not decided: no hardware can narrow Electron 44's floor. Left to step 4's remainder.

### 2. Windows build and Windows check in CI — done on the branch

- `electron-builder.yml` has `win` and `nsis` sections per step 1, the artifact name above and `build/icon.ico`, which `pnpm icons` now writes (16–256 px) and `scripts/make-icons.test.ts` checks byte for byte. `files` and `extraResources` stay shared.
- `pnpm dist:win` is `electron-vite build && electron-builder --win nsis --x64 --publish never`, without the macOS signing path; `start-app.mjs` still refuses non-macOS hosts and points to it. The macOS phase timing, runtime-input record and signing support are unchanged.
- `.gitattributes` sets `* text=auto eol=lf`; the Windows-sensitive tests are platform-aware rather than skipped on both platforms.
- `check.yml` has a `check-windows` job on `windows-2025` (the pinned image the release uses, rather than `windows-latest`): `pnpm check`, `pnpm dist:win`, `release.mts windows-smoke dist` (the step 5 install gates) and the installer as a 7-day build artifact. `workflow_dispatch` lets a work branch be checked.

Evidence: run 37040450544 passed `pnpm check`, `pnpm dist:win` and the `windows-smoke` gates on `windows-2025`; the release workflow's jobs have not run, since no tag was pushed.

### 3. Feasibility round on Windows hardware — waived

Waived by the decision: there is no Windows machine. The decision accepts that a published Windows build may not record at all, so the gate this step held ("a Windows build that cannot record does not proceed") no longer applies, and the release notes, README and website say capture is unverified. The CI gates of step 5 stand in only for installation, registration, the shortcut's presence and uninstallation, and only as runner evidence. Every other case stays untested on Windows and is listed as such in each release record: SmartScreen's text, the Start-menu shortcut's AppUserModelID in use, the first-run "system tray" hint, the five tray ICO states on light and dark taskbars at 100/125/150/200 %, tray clicks and tooltip (035's N17 matrix stays open and carried), recording with picture and system audio, `MediaRecorder` MP4 support, `restrictOwnAudio`, the saved toast and its Explorer reveal, Settings persistence, single-instance focus, sleep during recording, Quit, and uninstalling and reinstalling with data kept. If a Windows machine becomes available, these cases need their own round under the [desktop handoff](../docs/testing.md#confirm-desktop-handoff-before-testing).

### 4. App adjustments for Windows — update check done; the rest remaining, not blocking the release

- **Done on the branch: the update check.** On win32/x64 it reads GitHub's latest release only and accepts it only with the Windows asset, because the website feed describes the macOS DMG. There is no Windows feed: the website manifest's optional `windows` block serves the download page. `feedVersion` and `githubVersion` still accept exactly what macOS apps already read; `src/main/updates.test.ts` covers a two-platform release, another platform, a macOS-only release and Windows reading only GitHub.
- **Remaining:** platform-specific wording for sleep, missing system audio, unsupported OS and "menu bar"/"system tray", in both languages; reserved shortcuts per platform (macOS screenshot/Spotlight chords on macOS only); a Windows version floor, which without hardware can only be Electron 44's documented floor, enforced through `osSupported` and the existing `unsupported_os_version` path with Windows guidance, or recorded as not enforced. Each fix gets a focused test; on macOS, changed tray wording is checked with `pnpm acceptance:tray` in both languages; Windows appearance stays unverified. This does not block step 8; done after it, it ships in a later release.

### 5. Multi-platform release tooling — done on the branch

- **Compatibility.** The `release.json` asset and the website's `/release.json` keep their darwin-arm64 shape for installed macOS apps. Windows has its own record, `release-win32-x64.json`. SHA256SUMS lists every binary asset, one line each, so `shasum -a 256 -c` still checks it and a Windows user can compare `Get-FileHash` with its line.
- **Asset sets by version.** `LAST_MACOS_ONLY_VERSION = "1.1.1"`: earlier tags keep the three-asset contract, so `published` can still re-verify them from main; every later version, pre-releases included, carries five: the DMG, the Windows installer, SHA256SUMS and both records. `release.mts assets` prints a tag's set for the workflow.
- **Windows gates**, on a Windows runner (`candidate-windows`, `published-windows`, `windows-smoke`): silent per-user install; exactly one HKCU uninstall entry, none under HKLM, with DisplayVersion equal to the version; `RecordStuff.exe` PE machine x64 and ProductVersion equal to the version; Authenticode `NotSigned` for the installer and the exe; the tray ICOs and the Start-menu shortcut present; the `app.asar` hash recorded; then silent uninstall and a check that the app, the shortcut and the registration are gone. The two platforms' `app.asar` hashes sit in their two records; equality is not enforced.
- **Records and text.** The manifest schema has an optional `windows` block, required exactly for versions after 1.1.1; promotion, unchanged and historical-only rules compare its fields; README download blocks, release notes (macOS, Windows and Verify sections), verification record skeletons and the release title cover both platforms. The release tests cover releases before and after Windows and a missing, mismatched or unlisted Windows asset.

### 6. Release workflow — done on the branch

- `build-windows` on `windows-2025` (x64 assertion) runs in parallel with the macOS build: the same preflight, version stamp, frozen install, explicit Electron install, `pnpm check`, `pnpm dist:win`, `candidate-windows`, `actions/attest-build-provenance` and its own artifact, with no signing secrets.
- `publish` needs both builds, re-verifies both candidates and publishes one release. `verify-published` runs on macOS; `verify-published-windows` on `windows-2025` downloads anonymously, compares `Get-FileHash` with SHA256SUMS, runs `gh attestation verify` and `published-windows`. `record` needs both; `deploy-website` is unchanged.
- The workflow is renamed "Release" and its delivery group `recordstuff-macos-delivery` → `recordstuff-delivery`. The new name takes effect when the branch reaches main: merge it while no release run is queued, because a run queued under the old group would not serialize with one under the new.

The workflow has not run on a tag yet; step 8 exercises it.

### 7. Website and user guidance — done on the branch

The download page has a Windows section with size, SHA-256 and links from the manifest's `windows` block; Help covers Windows install, the SmartScreen "More info → Run anyway" step, manual update, uninstall and where data stays; Support's platform boundary is updated. `resources/INSTALL.md`, both READMEs and the release notes template carry the Windows instructions, in both languages where the document has two. Every claim is limited to CI evidence.

### 8. Pre-release rehearsal, then the first stable release — remaining

- After steps 2 and 5–7 are on main with both check jobs passing, and only on the maintainer's explicit request, do the usual macOS acceptance before tagging and tag `vX.Y.Z-rc.1` (a version after 1.1.1). Confirm both builds, `publish`, both verification jobs and `record`; the pre-release must not move the stable manifest, README or package.json. The install from the public URL on Windows hardware is waived; `verify-published-windows` is the only Windows download check.
- Then, on the maintainer's explicit request, tag the stable version. Afterwards, on the Mac, check that an installed macOS 1.1.1 app still reports its update status correctly against the new feed and release and that the download page shows both platforms. A Windows app's "current" result rests on unit tests only. Complete the release record: Windows evidence is CI only, and every step 3 case is untested on hardware.

### 9. Optional: Windows acceptance runner — waived

Waived: there is no Windows machine to run it on. The [release operation](../docs/system-design/releases.md#operation) states that no manual Windows smoke precedes a tag.

## Out of scope

Windows on Arm and Intel Mac builds, Microsoft Store, MSIX, winget, automatic updates on either platform, Windows code signing, warning-free installation, Windows hardware verification while no machine exists, Linux, and any change to the macOS signing identity or DMG contract.

## Verification and completion

Apply the [testing policy](../docs/testing.md) to each step's diff. Step 1 and this plan are documentation: links, anchors, command names, translations and `git diff --check`. Steps 2 and 5 fall under build configuration and release tooling: `pnpm check` on both runners, the release-tool tests, `pnpm dist:win` with `windows-smoke` on the runner, and `pnpm dist:mac` unchanged on the Mac. The rest of step 4 is app source: `pnpm check` plus macOS rechecks of changed visible behaviour. Step 6 is the release workflow: its tests and step 8's pre-release run. Step 7 is the website: `pnpm site:check`. A code or documentation task never authorizes a push to main or a tag push; both need the maintainer's explicit request. CI proves the installer builds, installs per user, matches its records and attestation, publishes the verified bytes and uninstalls; it does not prove capture, system audio, notifications or tray appearance, and nothing in this plan now establishes them on Windows.

Completion requires all of the following:

- The design decision rows record the maintainer's choices and date, and the macOS-only statements in [overview](../docs/system-design/overview.md), [releases](../docs/system-design/releases.md), [tooling](../docs/system-design/tooling.md), [delivery](../docs/system-design/delivery.md) and [signing](../docs/system-design/signing.md) describe the new boundary in both languages (done with this revision).
- A stable release carries both platforms, `verify-published` and `verify-published-windows` both passed, and an installed macOS app's update check behaves as before.
- The Windows release record states that Windows evidence is CI only and lists each step 3 case as untested on hardware; N17's tray matrix is explicitly carried.
- The rest of step 4 is done, or the maintainer decides to keep it as a documented known limitation.

Record the outcomes in the verification history and the durable rules in system design, then follow [plan completion](README.md#completing-a-plan).
