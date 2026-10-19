# 082 — The Recording Studio's first click and its measurement runner

[English](082-studio-runner-follow-ups.md) | [繁體中文](082-studio-runner-follow-ups.zh-TW.md)

Status: planned; not started. Created: 2026-10-19, from 081's closure at the maintainer's request. Priority: the maintainer orders it; one plan at a time. Hard dependencies: 081's pacing of the Studio (closed, [record](../docs/verification/history-2026-10.md#plan-081-closure--2026-10-19)). Execute the steps in order under [the plan index](README.md).

## Goal and boundaries

Three things 081's rounds left, each automatable without the maintainer's hands: a click on the Studio that seems to do nothing, a CPU report that fails every `--studio` run for a cause already accepted, and the pacing's hover path, verified so far only in unit tests. Success is a Studio whose controls answer the first click as the maintainer decides (D1), a `measure:cpu --studio` report whose verdicts fail only on a real problem, and a native check that the pointer alone moves the Studio between 5 and 10 frames a second. No camera is needed: none of the three depends on a camera delivering frames.

Out of scope: the Studio's cost (081 closed it within D18), skipping unchanged preview frames (a conditional candidate in [decisions](../docs/system-design/decisions.md), to measure on a still screen first), and the hands-on cases in 077.

## Current state

- **The first press of Live preview.** In every `measure:cpu --studio` run of 080 and 081, the runner's first press of Live preview started nothing in nearly every round, and its retry 15 s later did. The app's log has no line for the first press: nothing reached the button. The runner presses it while the material, full screen on the primary display, is frontmost, so the Settings window is not key. On macOS a click on an inactive window activates it and is not passed to the page unless the view accepts the first mouse (`acceptFirstMouse`, off by default in Electron). If so, a person recording in another app who clicks Live preview, Stop recording or a mute in the Studio beside it needs two clicks too.
- **The process-role check.** `measure:cpu` judges R's roles 5 s after the last save against the contract of a launch without the Studio. Once the Studio has been open, Chromium's `utility:video_capture` and `utility:audio` (started by the page's `getUserMedia`) stay; [tooling](../docs/system-design/tooling.md#cpu-budget) records it and [desktop](../docs/system-design/desktop.md#recording-studio) measured no CPU from them, yet every `--studio` report reads FAIL for it, hiding a real failure among them.
- **The hover path.** `studio-pace.ts` takes `pointerenter` and `pointerleave` on the page's root for the full rate. 081 saw the full rate in the app's log only after a click (`studio: preview at 10 a second` as L began); whether Chromium delivers `pointerenter` to an inactive window on macOS, with the pointer moved and no click, is unverified natively.

## Steps

### 1. Attribute the first click

- [ ] With the material frontmost and the Studio on the second display, click a Studio control once from a runner (osascript's mouse event, as `measure:cpu` does) and read the app's log and the page's events: whether the click activates the window only, reaches the page, or is lost to the accessibility tree being turned on just before. Repeat with the Settings window already key, and with a Recording settings control, to separate the window's activation from the Studio.

### 2. Decide

- [ ] **D1 The first click.** From step 1: recommended, if activation swallows the click, make the Settings window accept the first mouse (`acceptFirstMouse`) so a click on a control acts while another app is in front, as a palette or OBS's controls do; the risk is a click meant only to bring the window forward acting on what is under it, for example a recording card's Delete, which the maintainer may limit to the Studio's tab. Otherwise, the cause step 1 found and its fix, in the app or in the runner.
- [ ] **D2 The role contract.** Recommended: in a `--studio` run, R's contract allows one `utility:video_capture` and one `utility:audio` and still requires every other role as now, and the report names the allowance, so a launch without the Studio keeps today's contract.

### 3. Build, verify and document

- [ ] D1's change, with a unit or background UI test where the page's part can be checked, and the runner's single press when the cause was activation: `measure:cpu`'s L stops retrying in a round where the first press works, and still retries otherwise.
- [ ] D2's contract in `measure:cpu`, with its unit tests (`cpu-sampler`'s `judgeRoles` or the runner's own helpers).
- [ ] A hover check: a runner, or a `measure:cpu` step, that moves the pointer onto the Studio without clicking (a CGEvent mouse move, which `native-ax.mts` does not offer yet), waits, moves it away and reads `studio: preview at 10 a second` and then `at 5` from the log; it fails when either is missing. Run it once on the signed bundle after the [readiness handoff](../docs/testing.md#confirm-desktop-handoff-before-testing).
- [ ] One `pnpm measure:cpu -- --minutes 1 --camera preview=0 --skip-settings --skip-playback --studio` round on the signed bundle: no first-press retry if D1 removed its cause, the role check judged by D2's contract, and S and L within 081's figures.
- [ ] Record the outcome: [desktop](../docs/system-design/desktop.md#recording-studio) for D1, [tooling](../docs/system-design/tooling.md#cpu-budget) for D2, the hover check and the L press, and the verification record; each with its translation.

## Completion and verification boundaries

Complete when D1 and D2 are decided and built, the hover check has run on the signed bundle, and one `--studio` round reads PASS except for a real limit. Renderer, main and runner changes follow [the testing policy](../docs/testing.md#select-tests-from-behavior), taking the `settings-bridge` and `tooling` scopes and the Studio's background UI cases; desktop rounds follow the [readiness handoff](../docs/testing.md#confirm-desktop-handoff-before-testing). Writing this plan needs only links, English/Chinese parity and `git diff --check`.
