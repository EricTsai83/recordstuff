# 062 — Signed notification acceptance fixtures

[English](062-signed-notification-acceptance.md) | [繁體中文](062-signed-notification-acceptance.zh-TW.md)

Status: proposed; first in the queue, and 063 starts only after it closes. Dependencies: none. It fixes a confirmed acceptance prerequisite and verdict defect, and [063](063-scripted-native-acceptance.md)'s notification step follows it.

## Problem and evidence

At revision `1108b031a317a1a2e12e1567c7edc34d1529cddf`, `scripts/acceptance-quit-dialog.mts` builds a synthetic fixture and launches the Electron executable from `node_modules` directly. Unlike `pnpm start:app`, this path does not provide a fully signed application bundle. Its lifecycle checks can pass while macOS rejects the notification.

On 2026-10-01, an A/B/A comparison used the same copied Electron.app path, bundle identifier `com.github.Electron` and fixture. The original linker/ad-hoc signature produced `UNErrorDomain 1`; a complete bundle signature using the existing RecordStuff Dev identity allowed both English and Traditional Chinese notifications; restoring the original copy reproduced the rejection. macOS logs changed from `requestAuthorization/addRequest not allowed` to matching bundle identifiers and banner presentation. All four lifecycle rounds exited normally. This proves the full signing condition, without isolating certificate, Info.plist and resource sealing separately.

The local evidence is under ignored `docs/verification/measurements/2026-10-01-notification-signing-comparison/`. This summary remains usable without those files. No notification setting, trust, TCC or private entitlement was changed. Actual banner readability remains blocked because the native observation tool could not access NotificationCenter; a shown event or OS presentation log is not visual proof. See the [Electron Notification contract](https://www.electronjs.org/docs/latest/api/notification).

## Scope and artifact contract

Fix the isolated deferred-quit notification runner and its guidance. Keep its synthetic bytes, isolated userData, production feedback/Recorder/FileWriter/quit coordinator and owned-process supervision. Ordinary Settings fixtures do not need signing solely because they use Electron. Changes to product capture, saved-notification delivery, Electron versions, CI workflows and Playwright migration are outside scope.

Normal native App acceptance uses the matching revision's `pnpm start:app` artifact and existing signing identity. Development branches and uncommitted fixes may be tested; report commit, dirty-state/content identity (reuse `workingTreeIdentity` from [verification-timing.mts](../scripts/lib/verification-timing.mts)), dependencies, fixture hash, bundle path/identifier and selected public certificate fingerprint. Post-merge/release acceptance uses the designated main commit or release candidate under the existing release policy. Branch name alone does not establish artifact freshness or signature validity.

For this synthetic fixture, prepare a private Electron.app copy in a unique per-round directory and sign/verify that copy before launching it. Do not modify node_modules, normal dist output, installed Apps or user preferences. Preserve the working bundle identifier and launch contract demonstrated by the comparison; any identifier change requires its own permission/attribution check. Reuse the configured RecordStuff Dev identity or `RECORDSTUFF_SIGN_IDENTITY` selection and existing certificate validity/ambiguity checks. Never create/import certificates, change trust or add private entitlements as a test setup step.

Reuse the smallest suitable signing/verification support from `scripts/start-app.mjs`; if extraction is necessary, preserve its existing behavior and tests, including the phase timing and the runtime-input build record that `pnpm open:app` checks (plan 061). Verification must reject ad-hoc-only signatures, validate bundle integrity with `codesign --verify --deep --strict`, and establish the selected identity on the outer bundle and relevant nested code. A zero exit from signing alone is insufficient. Avoid a separate unsigned fallback or a new packaging workflow.

## Outcomes and cleanup

| Evidence | Required interpretation |
| --- | --- |
| Identity prerequisite missing, inaccessible or awaiting user permission | blocked (exit 2), with a reason; no fixture launch |
| Signing/verification fails after a valid identity was selected | fail (exit 1); no fixture launch |
| Lifecycle/timer/bytes or owned-process cleanup fails | fail (exit 1), independent of notification or desktop status |
| Notification failed | Delivery cannot pass; explicit OS authorization denial is blocked, other notification errors fail; retain raw error and classification reason |
| Notification show event received | Delivery-event evidence passes; banner visibility/readability remains separate |
| No show or failed event within a bounded observation period | Delivery incomplete, exit 1; no silent success |
| Required visual evidence unavailable | Visual blocked/not run with its reason; never claim complete native acceptance |

Record lifecycle, notification events/delivery, visual observation and cleanup independently in JSON and Markdown. The automated runner may return 0 only when its required lifecycle, delivery-event and cleanup checks pass on an unlocked desktop; label that as automated evidence, with visual observation explicitly pending. An agent's combined native verdict includes the required visual result and can remain blocked after automated exit 0. A show event does not prove exactly one visible banner or readable text. Any unexpected failure takes precedence over blocked results.

Continue preserving results when evidence collection fails. No request to show a notification can stand in for delivery. Keep setup/launch/notification waits bounded, including cancellation during copy/sign/verify. Clean only owned processes and temporary artifacts after exit; retain diagnostic evidence. Missing tools/permissions are recorded, never bypassed. Keep the existing desktop handoff, lock protection and caffeinate rules.

## Implementation

- [ ] Inspect current runner/fixture and signing callers; choose minimal shared identity/signature support, preserving normal packaging behavior.
- [ ] Add per-round Electron bundle preparation, complete signing, identity/integrity preflight and provenance report. Launch only the verified copied executable using scrubbed environment and existing process supervision.
- [ ] Persist structured notification events and bounded delivery outcome; combine verdicts without hiding failed delivery behind lifecycle PASS. Keep visual evidence independent.
- [ ] Cover absent/ambiguous/expired identity, signing failure, ad-hoc rejection, integrity/identity mismatch, notification failed/missing/shown, locked desktop and failure precedence with focused tests. Verify no launch on failed preflight and cleanup during setup failure, timeout and interruption.
- [ ] Run the implemented command serially in both languages, confirming accepted delivery, unchanged synthetic-byte/timer behavior and complete cleanup. Inspect banners through the project Astra computer-use skill where possible; explicitly retain any visual blocker.
- [ ] Update bilingual testing, tooling and acceptance guidance plus `.agents/skills/astra-acceptance-with-computer-use/SKILL.md`. Document the signed artifact rule, branch/provenance distinction and the three evidence layers. Publish the root-cause summary and final outcomes in durable verification documentation without rewriting historical blocked results.

## Verification and completion

Apply the [shared testing policy](../docs/testing.md) to the implemented diff: focused tooling tests and `pnpm typecheck` for TypeScript; run both language fixture paths plus changed failure/interruption/cleanup drills. If shared normal-build signing support changes, run its checks, `pnpm check` and fresh `pnpm start:app` signature verification under a desktop handoff, then quit and confirm exit. Reuse unaffected A/B/A diagnosis rather than repeating it by default. Recording smoke, capture matrix, audio, CPU and Settings regression are unnecessary when changes remain within fixture preparation/reporting and preserve product runtime; added runtime changes require reclassification.

Completion requires that the standard command automatically supplies a verified full signature; invalid prerequisites cannot launch the fixture; notification failures cannot produce automated PASS; lifecycle, delivery, visual and cleanup evidence remain distinct; and serial English/Traditional Chinese runs meet the automated contract. If the visual tool remains unavailable, record a specific remaining visual gap instead of claiming full native acceptance. Missing signing prerequisites leave the implementation's native verification blocked, not complete.

Deliverables: repaired runner and minimal support, regression tests, consistent instructions, provenance/outcome reports and durable root-cause/verification record. Follow [plan completion rules](README.md#completing-a-plan) before removing this plan and its translation. This document alone does not implement or verify the repair.
