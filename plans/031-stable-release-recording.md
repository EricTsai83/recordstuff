# 031 — Stable release pointers must not move backward

[English](031-stable-release-recording.md) | [繁體中文](031-stable-release-recording.zh-TW.md)

Status: planned, not implemented. Created: 2026-09-24. Execution order: see [queue](README.md#order-and-status).

## Scope, evidence and separation

R2-04 (P2). [release record](../scripts/release.mts) unconditionally writes the stable manifest and both README download blocks, while only package.json has a version comparison. Running the real CLI in a disposable checkout with local network/gh fixtures, recording 0.1.4 then 0.1.3, left package.json at 0.1.4 but manifest and READMEs at 0.1.3. No remote release or website was changed.

This needs a separate plan: release metadata ordering is independent of capture finalization, settings and media verification in 024–030. Follow the [release contract](../docs/system-design/releases.md). Scope: record's output selection, manifest validation, real CLI tests and bilingual release guidance; preserve published bytes and manual verification records. No new Cap comparison is claimed.

## Implementation contract

- [ ] Separate historical evidence recording from promotion of current stable download pointers. Older stable versions may add missing historical records but must not downgrade the stable manifest or either README; prereleases remain historical-only.
- [ ] Compare a verified candidate stable version against the validated committed stable manifest, using semantic version ordering. package.json can contain an unrelated development/candidate version, so it is not the sole authority for download promotion. Preserve its existing no-downgrade behavior.
- [ ] Equal-version retries must be idempotent for matching release identity and asset facts; conflicting source commit/digest/asset identity fails before writes. Newer stable versions update manifest and both README blocks from the same verified snapshot. Report historical-only, unchanged and promoted outcomes distinctly.
- [ ] Validate current manifest and all intended outputs before writing any file. Missing/malformed stable baseline must fail with an actionable diagnostic, not silently choose the older candidate; initial bootstrap, if needed, is a separately explicit path with tests. Preserve the existing all-inputs-before-writes contract without claiming cross-file crash atomicity.
- [ ] Extend actual CLI tests in disposable checkouts: newer→older, equal retry/conflict, newer promotion, prerelease, package ahead/behind manifest, invalid/missing baseline, malformed README markers and existing manual records. Assert every output and unchanged files on failure; use fixed local network responses with no publication.
- [ ] Update bilingual release design with historical-only recording, stable-pointer authority and retries. Preserve workflow serialization; no workflow publishing/permissions changes are needed for this fix.

## Required verification and exclusions

Run relevant release-record/manifest tests, `pnpm typecheck`, and `git diff --check`; check generated manifest/README consistency with existing offline consumer assertions. No app behavior, website layout, signing or packaging changes are planned, so omit recording, DMG builds, online publication and deployment. If implementation changes website code/build inputs beyond recorded data selection, add the applicable website policy checks before closure. No tag, commit, push or release is authorized by this plan.

## Completion and evidence handling

Follow [shared testing policy](../docs/testing.md) and [plan completion](README.md#completing-a-plan). Use the [native acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md) for any required native UI round. Serialize shared builds; one desktop/audio/shortcut owner per round. Restore changed settings, close test UI, quit the tested app and confirm process exit; incomplete cleanup blocks the next round.

- [ ] Record checks/results, scope exclusions and required-but-unverified cases separately; mocked boundaries are not native proof. Missing prerequisites are blocked. Run `git diff --check` on the implementation.
- [ ] Preserve durable conclusions in bilingual design/verification docs, update both indexes, then remove this plan and translation only after completion. Do not commit, push or publish without a separate request.

Planning-only validation: relative links/anchors, command names, bilingual coverage and `git diff --check`; no App build, tests, launch or recording just to write this plan.
