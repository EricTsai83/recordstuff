# macOS signing identities and self-signing

[English](signing.md) | [繁體中文](../zh-TW/system-design/signing.md)

Updated: 2026-09-15. This document covers the implemented local signing contract, developer operations, and CI identity provisioning from 011. Implementation and live verification status are tracked in [release automation](releases.md).

## Purpose and terminology

recordstuff uses a fixed self-signed identity to preserve its signing source across builds and verify signed App content integrity. This requires neither Apple Developer ID nor a paid membership, but provides no Apple-backed publisher identity or notarized first-launch experience.

| Term | Role |
| --- | --- |
| Private key | Secret material used to sign the App, held by the builder |
| Certificate | Public key and usage information supplied with the signature for verification |
| Signing identity | Certificate plus its matching private key; a certificate alone cannot sign |
| Self-signed | Certificate signed with its own private key, without Apple endorsing the publisher |
| SHA-1 fingerprint | Identifier for a particular public certificate, not a DMG checksum or private key |
| SHA-256 checksum | Comparison of final downloaded bytes against the release record |
| Developer ID Application | Apple-issued App signing certificate for distribution outside the Mac App Store |
| Notarization | Apple's software checking service, separate from signing |

Signing does not require an Apple-issued certificate. Self-signing does not establish the publisher's real-world organization. Apple's archived guide advises against shipping self-signed apps; this project accepts that distribution limitation and supplies per-app first-launch instructions. See [Apple's signing guide](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html).

An Apple-recognized distribution experience would require a separately designed Developer ID Application and notarization workflow. Replacing the certificate alone does not notarize an App. See [Developer ID](https://developer.apple.com/help/account/certificates/create-developer-id-certificates) and [notarization requirements](https://developer.apple.com/documentation/security/resolving-common-notarization-issues).

## Meaning, differences, and automation

Signing tools use the private key to produce a digital signature over signing data including cryptographic digests of code content. Verification uses the public key. Changes to signature-protected content invalidate verification. Signing does not encrypt the App, conceal its code, or guarantee the absence of bugs or malicious behavior.

| Capability | Fixed self-signing | Developer ID Application | Developer ID Application + Apple notarization |
| --- | --- | --- | --- |
| Verify signature-protected content integrity | Yes | Yes | Yes |
| Verify signing by the corresponding private key | Yes | Yes | Yes |
| Apple-backed developer identity | No | Yes | Yes |
| Apple notary service checks the submitted software | No | Not yet | Yes |
| Gatekeeper experience after downloading | May require a manual exception; managed environments may prohibit it | Developer ID alone does not guarantee acceptance | Standard distribution route, still subject to system policy and security checks |
| Automated CI signing | Yes | Yes | Yes, plus notarization submission/result checks |

“Apple verification” can mean Developer ID's publisher identity endorsement or notarization's software checks. These are separate steps. Notarization is neither App Store review nor an absolute safety guarantee. See [Apple's notarization explanation](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

| Operation | Can it be automated? | Project status |
| --- | --- | --- |
| Generate a private key and self-signed certificate | Yes, using certificate tools/scripts | `pnpm signing:create` generates an encrypted identity archive; Keychain import/trust remains separate |
| Sign each build using the existing identity | Yes | Implemented in `pnpm start:app` and `pnpm dist:mac`; initial private-key access may prompt |
| Import, unlock, and use the identity in CI | Yes | Implemented in the release workflow; see release automation evidence |
| Submit to Apple notarization and check results | Yes | Outside current implementation scope |

Automated identity creation should be one-time initialization or explicit migration, never a per-release step. A fresh temporary keychain on each CI run is appropriate as long as it receives the same certificate and private key. Developer ID requires Apple's issuance eligibility and process; a locally generated self-signed certificate cannot substitute for it.

## Fixed identity and updates

The [v0.1.0 release record](../verification/releases/0.1.0.json) uses:

```text
Name: RecordStuff Dev
Public certificate SHA-1: 01B373511530BBF287CA35E54C10A5F017AAD637
App identifier: com.recordstuff.app
```

A read-only local check on 2026-09-15 found that same valid identity. This fingerprint is the existing release baseline, not a value an independent developer can recreate.

The script expects the following outer designated requirement, the condition macOS uses to identify this code:

```text
identifier "com.recordstuff.app" and certificate leaf = H"01b373511530bbf287ca35e54c10a5f017aad637"
```

Creating another certificate named `RecordStuff Dev` changes the identity. The script selects by name by default, or by `RECORDSTUFF_SIGN_IDENTITY` fingerprint. It checks the finished App against the selected certificate; it does not hardcode the historical release fingerprint. CI must separately pin and check that expected fingerprint to prevent an unnoticed identity change.

[Existing verification](../verification/README.md) records a same-identity update at the same Applications path retaining screen permission and successfully recording audio. This is local evidence, not a guarantee for every macOS TCC (privacy permission system) environment. Stop recording, quit, and replace the App in place. Settings persistence is a separate mechanism from signing identity.

## Creating a first self-signed certificate

Existing release maintainers should preserve the certificate above and use the import procedure below when moving machines. These steps apply to an independent environment without an identity, or a planned identity migration.

1. Open Keychain Access through Spotlight.
2. Choose Certificate Assistant → Create a Certificate.
3. Choose a unique name. A fresh environment can use `RecordStuff Dev`; do not create another certificate with that name when one already exists.
4. Choose `Self Signed Root` as Identity Type and `Code Signing` as Certificate Type. Select `Let me override defaults` if adjusting validity, record the expiry date, and use an RSA key of at least 2048 bits.
5. Complete the assistant, save in the login keychain, and confirm a matching private key appears beneath the certificate in My Certificates.
6. If the identity is absent from the valid signing list, check dates, private key, and keychain unlock state first. If needed, set only this certificate's Code Signing trust to Always Trust and authenticate as prompted. This is a build-machine setting; recipients do not install or trust the certificate.

Labels vary by macOS version and language. See [Apple's creation instructions](https://support.apple.com/en-ie/guide/keychain-access/kyca8916/mac) for the entry point and key limits, and [Apple's signing guide](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html) for certificate types.

List valid identities without exporting private keys:

```bash
security find-identity -v -p codesigning
```

An existing release environment should list the baseline SHA-1. A new independent identity will have a different fingerprint. Enumeration is a prerequisite check; an actual signed build must still establish usability.

## Automated identity archive creation

`pnpm signing:create` first searches Keychain read-only. Any matching certificate is preserved, including expired certificates or certificates missing a private key. Creation requires an explicit, nonexistent output directory outside Git repositories and `RECORDSTUFF_P12_PASSWORD` with at least 16 characters. The parent directory must exist.

Use hidden input in zsh to keep the password out of command history:

```zsh
read -rs 'RECORDSTUFF_P12_PASSWORD?P12 password: '
export RECORDSTUFF_P12_PASSWORD
pnpm signing:create --name "RecordStuff Personal Dev" --output "$HOME/recordstuff-personal-identity"
unset RECORDSTUFF_P12_PASSWORD
```

Outputs: encrypted `identity.p12`, public `certificate.pem`, and `identity.json` containing name, fingerprint, and expiry. System OpenSSL generates RSA 3072-bit keys and a SHA-256 self-signed Code Signing leaf, valid for 3650 days by default. The directory has mode 0700; the intermediate private key is encrypted and removed on success. Failures remove the newly created directory; existing directories are never overwritten. Forced termination may leave protected intermediate files requiring cleanup.

This command creates files only; it does not import into Keychain, configure trust, or set GitHub secrets. Follow the next section for import and select a custom name with `RECORDSTUFF_SIGN_IDENTITY`. Real OpenSSL tests cover encrypted archives, password rejection, certificate/key matching, and overwrite protection. macOS import and App signing with a newly generated identity have not been verified. The existing release certificate remains unchanged.

## Backup, export, and moving machines

Select the complete identity in My Certificates and export it as password-protected Personal Information Exchange (`.p12`) using a strong password. Include the private key. If only `.cer` is available, check that the complete identity is selected. Store the backup and password securely and separately, outside the repository, DMG, conversation, and public artifacts.

Import the `.p12` on the new Mac using its export password, then check the private key, Code Signing trust, and matching fingerprint. A `.p12` does not imply that the old machine's trust settings or tool access permissions transfer with it. See [Apple's import/export instructions](https://support.apple.com/guide/keychain-access/import-and-export-keychain-items-kyca35961/mac).

A lost private key cannot be recovered from a released App's public certificate. Expiry, loss, or compromise requires a planned replacement identity, a new release baseline, and renewed installation/permission verification. Recreating the same certificate name does not restore the old identity.

## Local build and verification contract

Install dependencies as described in [tooling](tooling.md), stop recording, and quit RecordStuff/project Electron before rebuilding. Run commands at the repository root:

```bash
# Code checks; no signing or publication
pnpm check

# Build, sign, verify, and launch the development App
pnpm start:app

# Verify and reopen an existing development App
pnpm open:app

# Release candidate DMG; defaults to RecordStuff Dev
pnpm dist:mac

# Explicit selection of the existing release identity
RECORDSTUFF_SIGN_IDENTITY=01B373511530BBF287CA35E54C10A5F017AAD637 pnpm dist:mac
```

These are alternatives for different tasks, not a consecutive checklist. Quit the App launched by `start:app` before another rebuild.

```mermaid
flowchart LR
  A[Keychain certificate and private key] --> B[Exact selection and certificate checks]
  B --> C[Build and electron-builder signing]
  C --> D[Deep signature and identity verification]
  D --> E[Package verified App into DMG]
  E --> F[Final file SHA-256 and release acceptance]
```

The final checksum and release acceptance are delivery steps, not fully automated by `dist:mac`. [start-app.mjs](../../scripts/start-app.mjs) implements this contract:

- Reject missing or ambiguous identities, duplicate names, expired or not-yet-valid certificates, non-self-signed certificates, and public certificate mismatches. Duplicate names are rejected even with SHA-1 selection because downstream signing uses the name.
- Remove `CSC_*`, `WIN_CSC_*`, and `APPLE_*` release variables from child processes, disable identity discovery, and force signing. Setting only `CSC_LINK` therefore does not import a CI certificate through this entry point.
- Run `codesign --verify --deep --strict`; inspect the outer App and nested `.app`/`.framework` certificates, validity, and identifiers; require hardened runtime on Apps. Traversal does not follow symlinks.
- Match the outer designated requirement to the selected certificate. Failures stop the operation; no ad-hoc fallback or skipped identity verification is allowed.
- Package the already verified App into a DMG. Do not import keys, notarize, publish, or reset OS permissions.

The [local packaging configuration](../../electron-builder.local.yml) disables timestamps, notarization, DMG signing, and update metadata. **The App is signed; the DMG is an unsigned container.** The arm64 output is `dist/RecordStuff-<version>-arm64-selfsigned.dmg`; only arm64 has delivery evidence.

Read-only inspection examples:

```bash
codesign --verify --deep --strict "dist/mac-arm64/RecordStuff.app"
codesign -d --verbose=4 "dist/mac-arm64/RecordStuff.app"
codesign -d -r- "dist/mac-arm64/RecordStuff.app"
# Substitute the actual release filename
shasum -a 256 "dist/RecordStuff-0.1.0-arm64-selfsigned.dmg"
```

These do not replace the script's complete identity checks, mounted DMG content checks, or manual recording/playback acceptance. See [v0.1.0 evidence](../verification/releases/0.1.0.md).

## Reusing the identity in CI

“Resolve signing first” in [release automation](releases.md) means securely provisioning the existing certificate and private key on a clean runner. It does not require a new Apple certificate. The following configuration is implemented; see [release automation](releases.md) for the tag-triggered release flow:

| Configuration | Suggested location | Purpose |
| --- | --- | --- |
| `BUILD_CERTIFICATE_BASE64` | release environment secret | Base64 of encrypted `.p12`; Base64 is not encryption |
| `P12_PASSWORD` | release environment secret | Decrypt the `.p12` |
| Temporary keychain password | Random masked job value or dedicated secret | Unlock that build's keychain, not the developer's login password |
| `RECORDSTUFF_SIGN_IDENTITY` | Workflow/environment variable | Pin the existing public SHA-1 and compare the imported identity |

Workflow sequence:

1. Restrict secrets to trusted release jobs, excluding untrusted PRs. Establish the source and version to build.
2. Restore the `.p12` in runner temporary storage; create/unlock a temporary keychain, import the identity, and configure signing-tool access to the private key.
3. Include the keychain in the search list. Configure this self-signed certificate's Code Signing trust within the isolated build environment and establish noninteractive signing. GitHub's Apple certificate example is not a verified self-signing configuration; trust handling needs separate validation.
4. Require the valid identity fingerprint to match the release baseline, then reuse `pnpm check`, `pnpm dist:mac`, and complete artifact verification.
5. Compute the final DMG checksum and retain version, source commit, platform, and size. Upload candidate artifacts and public metadata, never the keychain or `.p12`.
6. Clean private material and the temporary keychain on success and failure. Restore search lists and trust settings if changed on a persistent runner. Prefer an isolated ephemeral runner.

See [GitHub's official workflow](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications) for secrets, temporary keychains, and cleanup. This project's self-signing flow does not use the Xcode example's provisioning profile.

Signing provisioning is complete when a clean runner signs with the **same fingerprint**, passes existing verification, stops on missing/wrong identities, and leaves no secrets after failure. 011 completed real release, download/hash verification, and manual installation acceptance in [v0.1.1](../verification/releases/0.1.1.md). If secure private-key provisioning is unavailable, keep local builds and automate only candidate checks/upload, explicitly reporting partial automation.

## Troubleshooting

| Symptom | Check and action |
| --- | --- |
| No valid identity | Check private key, dates, Code Signing trust, unlocked keychain, and search list |
| Duplicate certificate names | Identify the correct certificate and backup before resolving duplicates; do not substitute a new same-name identity |
| CI keychain prompt or private-key access failure | Check unlock state and signing-tool access permissions; do not switch to unsigned builds |
| Non-self-signed certificate rejected | Current entry point intentionally accepts self-signing only; Developer ID migration requires changing and verifying the release contract |
| Valid signature but first launch blocked | Integrity verification is separate from Gatekeeper acceptance; follow per-app installation guidance |
| Screen permission requested again after updating | Check certificate, identifier, installation path, and OS state, then follow the permission recovery guide |

Recipients install only the App, with no Node, pnpm, certificate, or private key. Follow the [installation guide](../../resources/INSTALL.md) and [Apple's guidance](https://support.apple.com/102445) for Open Anyway. Do not disable Gatekeeper globally; managed Macs may disallow exceptions.

## T3 Code reference

Upstream commit `47ace94962a714a561d7cfbdbaa4c721ef6b0598`, inspected 2026-09-15: [release-desktop.yml](https://github.com/pingdotgg/t3code/blob/47ace94962a714a561d7cfbdbaa4c721ef6b0598/.github/workflows/release-desktop.yml) consumes existing `CSC_LINK`/`CSC_KEY_PASSWORD` and Apple API credentials to enable desktop signing/notarization. Its CLI flow explicitly imports `.p12` into a temporary keychain and selects Developer ID Application. These flows do not generate self-signed identities. Reuse the separation of provisioning and building; do not adopt its unsigned fallback on missing secrets, because 011 requires a missing identity to stop the release.
