# 064 — Windows build, verification and release

[English](064-windows-release.md) | [繁體中文](064-windows-release.zh-TW.md)

Status: proposed; third in the queue, started only after [062](062-signed-notification-acceptance.md) and [063](063-scripted-native-acceptance.md) have closed. Dependencies: step 1 is a maintainer decision gate and every later step requires it; step 3 requires step 2's installer; steps 4–7 require step 3's feasibility verdict; step 8 requires steps 4–7. Step 2 changes `scripts/start-app.mjs` in the shape 062 leaves it; step 3 labels evidence with 063's kinds; step 4's macOS recheck uses 063's `pnpm acceptance:tray` when 063 built it, otherwise Computer Use or manual observation under 063's selection rule; step 9 reuses 063's evidence labels. Independent of the deferred 058–060.

## Problem and evidence

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

One `vX.Y.Z` tag publishes one GitHub release carrying both the existing macOS DMG and a Windows x64 installer, or publishes nothing. Each platform is built, verified, published, re-downloaded anonymously and verified again by the same gates it has today. Already-installed macOS apps see no change in the feed or assets they read. The website offers each verified platform and describes the Windows first-run warning honestly. The release record states which Windows behaviour was verified on real hardware and which was not.

## Steps

Each step is independently completable and leaves the documents consistent.

### 1. Maintainer decision gate

Ask the maintainer to decide, and record each answer with its date in [design decisions](../docs/system-design/decisions.md) and its translation, replacing the "macOS-only verification and packaging" row. Recommendations are listed first.

- **Verification hardware.** Which Windows machine counts as verification: a physical x64 Windows 11 PC (recommended), or a Windows 11 on Arm VM on the reference Mac, whose x64 emulation and virtual audio device are not equivalent. A VM result is labelled as such and cannot close step 3's capture cases alone. Without any Windows machine, stop here: the existing decision stays and this plan is deferred.
- **Architecture.** x64 only for the first release (recommended); arm64 Windows is a later, separately verified addition.
- **Installer and the "no uninstaller" decision.** A per-user NSIS installer (`oneClick`, `perMachine: false`, no admin prompt) creates the Start-menu shortcut that toast notifications need and registers the Windows-conventional uninstaller in Settings → Apps (recommended). A portable ZIP keeps the "no uninstaller" rule but loses notifications unless the app creates its own shortcut. With NSIS, record that uninstalling never deletes user data (`deleteAppDataOnUninstall: false`), so the existing data rule holds, and that the macOS rule is unchanged.
- **Signing.** Options: unsigned, with integrity carried by SHA256SUMS, `release.json` and a GitHub build-provenance attestation (recommended for the first release); an OV code-signing certificate on a hardware or cloud key, which costs money and still shows SmartScreen until reputation builds; Azure Artifact Signing, which as of 2026 issues public-trust certificates to individuals only in the USA and Canada. A macOS-style self-signed certificate adds nothing on Windows: users would have to trust it by hand. Whatever is chosen, the asset name states it, as `-selfsigned` does for the DMG, and warning-free installation stays outside scope.
- **Release coupling.** A Windows failure fails the whole tag before publication (recommended, matching "the tag is the version"), rather than publishing macOS alone.
- **Minimum Windows version.** Electron 44's supported floor, narrowed to what step 3 verifies, enforced the way `osSupported` enforces Darwin 22.

If the maintainer rejects Windows delivery, record the decision and close this plan.

### 2. Windows build and Windows check in CI

- Add `win` and `nsis` sections to `electron-builder.yml` per step 1, an explicit Windows artifact name, and `build/icon.ico` generated by `pnpm icons` (16–256 px) with a byte test like the tray ICOs. Keep `files` and `extraResources` shared so `app.asar` contents stay platform-independent.
- Add `pnpm dist:win`, a plain `electron-builder --win --x64` without the macOS signing path in `start-app.mjs`, and have `start-app.mjs` keep refusing non-macOS hosts with a pointer to it. Keep the phase timing and the runtime-input build record that `pnpm open:app` checks (plan 061), and any signing support 062 extracted, unchanged on macOS.
- Add `.gitattributes` (`* text=auto eol=lf`) and fix the Windows test failures listed above with platform-aware expectations or guarded fixtures, never by skipping a behaviour test on both platforms.
- Add a `windows-latest` job to `check.yml` that runs `pnpm check`, then `pnpm dist:win`, and uploads the installer as a short-retention artifact. This is a build artifact, not a release; it exists to feed step 3.

Verification: `pnpm check` on both runners, `pnpm dist:mac` unchanged on the Mac, the installer artifact downloaded and its contents listed.

### 3. Feasibility round on Windows hardware

On the machine chosen in step 1, under the [desktop handoff](../docs/testing.md#confirm-desktop-handoff-before-testing), install step 2's artifact and record pass, fail or blocked for each case, keeping VM results separate:

- Install without admin rights, SmartScreen text as shown, the Start-menu shortcut and its AppUserModelID, first launch with the "system tray" hint.
- The tray: the five ICO states on light and dark taskbars at 100/125/150/200 %, left click starts and stops, right click opens the menu, tooltip text. This closes 035's N17 under the same matrix.
- Recording with the default shortcut and from the tray: a test video with sound playing, the MP4 opens in the Windows player and plays with picture and system audio, RecordStuff's own countdown tick is not recorded when the sound is on (`restrictOwnAudio`), the file name and `Videos\RecordStuff` folder. Copy the file to the Mac and run `pnpm verify -- <file>` for integrity, format and audio energy.
- The saved toast appears and its click opens Explorer with the file selected; Settings opens, changes the shortcut and output folder, and keeps them across relaunch; a second launch focuses the running instance; sleep during recording saves the file; Quit leaves no process.
- Uninstall from Settings → Apps leaves settings, history and recordings in place; reinstall picks them up.

Gate: if capture, audio or MP4 encoding fails, record the evidence and stop. A capture path change is a separate plan; steps 4–8 do not proceed on a Windows build that cannot record.

### 4. App adjustments for Windows

- Platform-specific wording for sleep, missing system audio, unsupported OS and "menu bar"/"system tray", in both languages; reserved shortcuts per platform (macOS screenshot/Spotlight chords on macOS only; Windows chords such as Win-key combinations already refused).
- A Windows version floor from step 1 with the existing `unsupported_os_version` path and Windows guidance.
- The update check for Windows: a Windows feed and a GitHub fallback that look for the Windows asset, while `feedVersion` and `githubVersion` keep accepting exactly what macOS apps already read. Tests cover old macOS release objects, new multi-asset releases on both platforms and a Windows app reading a macOS-only release (no update, not an error worth reporting as broken).
- Anything else step 3 found. Each fix gets a focused test; visible changes are rechecked on both platforms. On macOS, changed tray wording is checked with `pnpm acceptance:tray` in both languages when 063 provided it; otherwise follow 063's selection rule.

### 5. Multi-platform release tooling

- **Compatibility first.** The `release.json` asset and the website's `/release.json` keep their current darwin-arm64 shape and bytes semantics. Windows gets its own record, `release-win32-x64.json`, and feed, `/release-win32-x64.json`. SHA256SUMS lists every binary asset, one line each, so `shasum -a 256 -c` still checks it and a Windows user can compare `Get-FileHash` output with its line.
- **Asset sets by version.** Releases before the first Windows version keep the three-asset contract so `published` can still re-verify any older tag from main; from that version on the set is the DMG, the Windows installer, SHA256SUMS and both records.
- **Windows candidate gates**, run on the Windows runner: silent per-user install into a temporary directory, PE machine type x64 for `RecordStuff.exe`, file and product version equal to the tag, `resources/app.asar` hash recorded, the tray ICOs present, the expected signature state (absent, or the pinned certificate), then silent uninstall and a check that no installed files remain. Record whether the two platforms' `app.asar` hashes match; enforce equality only if repeated builds show it is deterministic.
- **Records and text.** The manifest schema gains a Windows entry; promotion, unchanged and historical-only rules compare each platform's facts; README download blocks, release notes, verification record skeletons and the GitHub release title cover both platforms. Extend `scripts/release-record.test.ts` and the release tests with releases before and after Windows, a missing Windows asset, a mismatched digest and a Windows-only failure.

### 6. Release workflow

- Add a `build-windows` job on `windows-latest` (x64) in parallel with the macOS build, running the same preflight, version stamp, `pnpm install --frozen-lockfile`, the explicit Electron install, `pnpm check`, `pnpm dist:win` and the step 5 candidate gates, then uploading its own artifact. If step 1 chose signing, provision the key the way the macOS job does: environment `release`, secrets only in that step, masked values and always-cleanup.
- `publish` needs both builds, re-verifies both candidates and publishes one release. `verify-published` runs on both runner types against the public URLs. If step 1 chose attestation, add `actions/attest-build-provenance` to each build and `gh attestation verify` to `verify-published`.
- Rename the workflow and its concurrency group to cover both platforms, changing the group name only when no release run is queued. `record` and `deploy-website` stay single jobs.

### 7. Website and user guidance

- Download page with a section per verified platform, size, SHA-256 and links; the Windows feed endpoint; help for Windows install, the SmartScreen "More info → Run anyway" step, manual update, uninstall and where data stays; Support's platform boundary updated. Keep claims to what step 3 and step 8 verified.
- `resources/INSTALL.md`, both READMEs and the release notes template gain Windows instructions in both languages. Run `pnpm site:check`.

### 8. Pre-release rehearsal, then the first stable release

- Tag `vX.Y.Z-rc.1` on main: the pre-release path publishes both platforms without moving the stable manifest, README or package.json. Confirm the workflow, both `verify-published` runs and an install from the public URL on the step 1 machine, repeating the step 3 smoke on the downloaded installer.
- Then tag the stable version. Afterwards, check that an installed macOS 1.1.1 app still reports its update status correctly against the new feed and release, and that the Windows app reports "current". Complete the release record with the Windows evidence and its untested cases.

### 9. Optional: Windows acceptance runner

Only if the maintainer wants repeatable Windows rounds after step 8: a PowerShell or Node runner that starts and stops a recording with the global shortcut and checks the log and file, labelled with 063's evidence kinds. Without it, Windows acceptance before each release is the manual step 3 smoke on the candidate, which the [release operation](../docs/system-design/releases.md) must then list.

## Out of scope

Windows on Arm and Intel Mac builds (separate verification), Microsoft Store, MSIX, winget, automatic updates on either platform, warning-free installation, Linux, and any change to the macOS signing identity or DMG contract.

## Verification and completion

Apply the [testing policy](../docs/testing.md) to each step's diff. Step 1 and this plan are documentation: links, anchors, command names, translations and `git diff --check`. Step 2 and step 5 fall under build configuration and release tooling: `pnpm check` on both platforms, the affected package commands and the release-tool tests. Step 4 is app source: `pnpm check` plus Windows and macOS rechecks of changed visible behaviour. Step 6 is the release workflow: its tests and a pre-release run; a code or documentation task never authorizes a tag push, so step 8's tags need the maintainer's explicit request. CI proves the installer builds, installs, matches its records and publishes the verified bytes; it does not prove capture, system audio, notifications or tray appearance, which only step 3 and step 8 on real hardware establish.

Completion requires all of the following:

- The design decision row records the maintainer's choices and date, and the macOS-only statements in [overview](../docs/system-design/overview.md), [releases](../docs/system-design/releases.md), [tooling](../docs/system-design/tooling.md), [delivery](../docs/system-design/delivery.md) and [signing](../docs/system-design/signing.md) describe the new boundary in both languages.
- A stable release carries both platforms, both passed `verify-published`, and an installed macOS app's update check behaves as before.
- The Windows release record lists each step 3 case as passed on hardware, passed only in a VM, or untested, and N17's tray matrix is closed or explicitly carried.

Record the outcomes in the verification history and the durable rules in system design, then follow [plan completion](README.md#completing-a-plan).
