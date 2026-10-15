# 078 — Native capture follow-ups: frame gaps, the development app, cadence diagnostics

[English](078-native-capture-follow-ups.md) | [繁體中文](078-native-capture-follow-ups.zh-TW.md)

Status: planned; not started. Created: 2026-10-16, from 076's step 7 at the maintainer's request ("先記下這個問題，之後再處理"). Priority: the maintainer orders it; none of it blocks 074 or 075. Hard dependencies: 076. Execute the steps in order under [the plan index](README.md).

## Goal and boundaries

Close three questions 076's acceptance left open about the native capture engine on macOS. Success is: the remaining 50 ms frame gaps are explained and removed or accepted with their cause; the development Electron app leaves its own windows out of a recording as the signed bundle does, or the limit is documented; and frame-timing diagnosis covers the engine that records.

Out of scope: Windows hardware (CI only), new capture features, and the hands-on cases in [077](077-native-hands-on-acceptance.md).

## Current state

- **Frame gaps.** On a 60 Hz display at 30 fps, 0.66–2.17% of native frames were 50 ms apart against Chromium's none (2026-10-15). 076 found that ScreenCaptureKit sends idle frames when the screen does not change and fixed the slot that took the next picture a refresh late (PR #12): 0.22–0.44% remain, one or two per 15 s take, with capture never missing a refresh (longest gap between pictures 33.3 ms). Their cause is not known; the stop report's counters (`capture delivered … pictures and … without one, … apart at most`) are the starting evidence. The threshold is 2%; Chromium shows 0%.
- **Development app.** Recording through the development Electron app (`pnpm matrix`, `pnpm audio:quality`) logs `RecordStuff's own app was not found among the shareable applications; its windows may be recorded`; the signed bundle reports `1 own app(s) excluded`. Its cause (the development app's bundle identity, or its having no window when the shareable content is read) is not established.
- **Cadence diagnostics.** `pnpm diagnose:cadence` builds the hidden renderer's capture host itself and measures only that engine, which 076 removes; the native engine exposes no per-frame timestamps to it.

## Steps

### 1. The remaining frame gaps

- [ ] Find where the remaining 50 ms gaps come from: log, for a take, each encoded frame's time and source (a picture, an idle refresh, the refresh thread's slot) around every gap, and compare with the pacer's slots. Candidates to rule in or out: an idle refresh the pacer did not admit (just before half an interval), the refresh thread's `due` path encoding a pending picture at its slot while a newer one arrives, and frames left out at the start.
- [ ] Fix what the evidence shows, with a test of the case, and measure with `pnpm matrix -- quick` natively and through Chromium on the same display; or, if no cause in the engine is found, record the evidence and ask the maintainer to accept the remainder.

### 2. The development app's own windows

- [ ] Establish why the development app is not found among the shareable applications (compare its process and bundle identity with what `SCShareableContent` lists, with and without a window open), and make it excluded as the bundle is, or document why it cannot be and what that means for development recordings.

### 3. Cadence diagnostics for the native engine

- [ ] Decide with the maintainer whether `pnpm diagnose:cadence` should measure the native engine (from the engine's per-frame log or a diagnostic export) or be retired once 076 removes the hidden renderer, and do that.

### 4. Documentation

- [ ] Record the outcome in [recording](../docs/system-design/recording.md), [tooling](../docs/system-design/tooling.md) and the verification record, with translations.

## Completion and verification boundaries

Complete when each step is done or the maintainer has accepted its outcome, with its measurements recorded. Engine changes follow [the testing policy](../docs/testing.md#select-tests-from-behavior)'s recording rows: `cargo test`, `pnpm check`, and a native matrix round on the signed bundle or the development app as the step needs, each a desktop round under the [readiness handoff](../docs/testing.md#confirm-desktop-handoff-before-testing). Writing this plan needs only links, English/Chinese parity and `git diff --check`.
