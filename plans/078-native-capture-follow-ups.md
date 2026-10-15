# 078 — Native capture follow-ups: frame gaps, the development app, cadence diagnostics

[English](078-native-capture-follow-ups.md) | [繁體中文](078-native-capture-follow-ups.zh-TW.md)

Status: planned; not started. Created: 2026-10-16, from 076's step 7 at the maintainer's request ("先記下這個問題，之後再處理"). Priority: the maintainer orders it; none of it blocks 074 or 075. Hard dependencies: 076. Execute the steps in order under [the plan index](README.md).

## Goal and boundaries

Close the questions 076's acceptance and documentation left open about the native capture engine on macOS. Success is: the remaining 50 ms frame gaps are explained and removed or accepted with their cause; the development Electron app leaves its own windows out of a recording as the signed bundle does, or the limit is documented; and frame-timing diagnosis covers the engine that records.

Out of scope: rounds on Windows hardware (Windows is checked by CI only, step 4's hardware encoder included), new capture features, and the hands-on cases in [077](077-native-hands-on-acceptance.md).

## Current state

- **Frame gaps.** On a 60 Hz display at 30 fps, 0.66–2.17% of native frames were 50 ms apart against Chromium's none (2026-10-15). 076 found that ScreenCaptureKit sends idle frames when the screen does not change and fixed the slot that took the next picture a refresh late (PR #12): 0.22–0.44% remain, one or two per 15 s take, with capture never missing a refresh (longest gap between pictures 33.3 ms). Their cause is not known; the stop report's counters (`capture delivered … pictures and … without one, … apart at most`) are the starting evidence. The threshold is 2%; Chromium shows 0%.
- **Development app.** Recording through the development Electron app (`pnpm matrix`, `pnpm audio:quality`) logs `RecordStuff's own app was not found among the shareable applications; its windows may be recorded`; the signed bundle reports `1 own app(s) excluded`. Its cause (the development app's bundle identity, or its having no window when the shareable content is read) is not established.
- **Cadence diagnostics.** `pnpm diagnose:cadence` measured only the hidden renderer's capture host and was removed with it on 2026-10-16; the native engine has no per-frame diagnostic yet beyond the stop report's counters.

## Steps

### 1. The remaining frame gaps

- [ ] Find where the remaining 50 ms gaps come from: log, for a take, each encoded frame's time and source (a picture, an idle refresh, the refresh thread's slot) around every gap, and compare with the pacer's slots. Candidates to rule in or out: an idle refresh the pacer did not admit (just before half an interval), the refresh thread's `due` path encoding a pending picture at its slot while a newer one arrives, and frames left out at the start.
- [ ] Fix what the evidence shows, with a test of the case, and measure with `pnpm matrix -- quick` natively and through Chromium on the same display; or, if no cause in the engine is found, record the evidence and ask the maintainer to accept the remainder.

### 2. The development app's own windows

- [ ] Establish why the development app is not found among the shareable applications (compare its process and bundle identity with what `SCShareableContent` lists, with and without a window open), and make it excluded as the bundle is, or document why it cannot be and what that means for development recordings.

### 3. Cadence diagnostics for the native engine

- [ ] Decide with the maintainer whether the native engine needs a cadence diagnostic (from a per-frame log or a diagnostic export of each encoded frame's time and source), and build it if so; step 1 may need it first.

### 4. What the Chromium path left behind

- [ ] **Windows hardware H.264 (decided by the maintainer on 2026-10-16: build it, on by default, as Cap does).** Windows encodes with Microsoft's software transform only, while D4 meant a GPU's hardware encoder when one exists. Build the hardware path through Media Foundation's asynchronous hardware transform, with frames kept on the GPU, following the practice of Cap (revision `83237e9`, AGPL code read for design only), OBS and Chromium, none of which trusts a hardware encoder without a way back:
  - Enumerate hardware encoders on the capture device's adapter (`MFTEnum2` with its LUID); never on WARP, where frames are converted on the CPU. Skip AMD's, as Cap does (OBS dropped Media Foundation encoders after AMD's broke), leaving AMD on the software encoder.
  - Before a recording, a self-test cached per adapter, driver and size: a few grey frames encoded and decoded back, the grey checked, because some drivers open a session and then emit green or black frames without an error. Any failure, and any error before the first key frame reaches the muxer, uses the software encoder silently.
  - During a recording, a watchdog (inputs without output, repeated input failures, no output for 5 s, `MEError`) ends the recording with what was written, as a capture failure, and later recordings use the software encoder.
  - A development switch forces the software encoder; there is no user setting, as in Cap.
  - CI on `windows-2025` has no GPU: it tests enumeration finding nothing, the fallback, the self-test against the software encoder, and the event handling against a fake asynchronous transform that injects stalls, errors and format changes. Real GPUs (NVIDIA, Intel), picture correctness and CPU stay untested, listed as such, and are fixed from users' reports.
- [ ] **Windows without Media Foundation (decided by the maintainer on 2026-10-16: a code of its own, and a check before recording).** A Windows N edition without the Media Feature Pack cannot encode, and today fails as `capture_start_failed` ("Try again… choose a lower video quality"), which names neither the cause nor the remedy; whether the module even loads without `mfplat.dll` is unverified and is the first thing to establish. One code per cause and remedy:
  - A new error code (working name `media_components_missing`) with its own reason, guidance (install the Media Feature Pack under Settings → Apps → Optional features, then restart) and icon, used when the module cannot load for that reason, Media Foundation does not start, or no H.264 or AAC encoder is found.
  - Checked before a recording, as a missing screen permission is on macOS: at launch, main checks that Media Foundation is present; when it is not, Start recording is unavailable with the reason, and Settings shows a notice whose button opens `ms-settings:optionalfeatures`. The error code stays as the last line for what the check cannot see.
- [ ] **`mp4_unsupported` removed (decided by the maintainer on 2026-10-16: no legacy code).** Only the hidden renderer produced it, so the code, its reason, guidance and icon go. The failure history refuses a whole file with a code it does not know, to keep a downgraded app from overwriting a newer one's records, so a history holding an old `mp4_unsupported` record becomes unreadable; the maintainer accepted that small risk (the code fired only where Chromium could not record MP4, in practice a Windows N edition, published for Windows since 2026-10-03).
- [ ] **A way out of an unreadable failure history (decided by the maintainer on 2026-10-16).** Today Settings says only "Could not read the failure history. The file was kept; see the log.", and new failures cannot be saved until the file is deleted by hand. Add a Reset failure history button beside that message: it confirms, keeps the unreadable file as a backup (`keepFile(…, "reset-backup")`), starts an empty history and lets failures be saved again without a relaunch; the message no longer sends users to the log. It also covers a history damaged for any other reason, and the downgrade guard stays, because only the user's action replaces the file.
- [ ] **The frame-rate downgrade and resolution-cap notices removed (decided by the maintainer on 2026-10-16).** Both checked what Chromium granted against what was asked. The engine scales to the size it was given and paces frames at the chosen rate, repeating the last picture when the screen does not change, so the host reports the requested rate and never sets `capUnconfirmed`. Remove `frameRateDowngrade`, `capUnconfirmed`, the tray notifications, Settings' capture warning, their strings and tests.
- [ ] **The size estimate follows the native engine (decided by the maintainer on 2026-10-16).** `estimatedBytesPerMinute` doubles the 60 fps video estimate because MediaRecorder delivered about twice its target. The engine delivers 101–102% of its target at 30 and 60 fps (8.25–8.28 of 8.10 Mbps, 15.11–15.19 of 14.90, 16.33–16.47 of 16.20; `pnpm matrix -- quick` and `pnpm acceptance` with the test material, 2026-10-15/16), so the estimate becomes the target without the doubling; a still screen records smaller.

### 5. Windows UI shards that time out closing the app

- [ ] Recorded at the maintainer's request (2026-10-16). A Windows UI shard of `check.yml` intermittently fails a test whose checks passed, because the app does not close within `CLOSE_TIMEOUT_MS` (15 s, `tests/ui/fixtures.ts`) and its process tree needs SIGKILL (`view: did not close normally (normal close failed: Error: close timed out after 15000 ms)`). Seen in runs 38789339217 (main after PR #15, U067-3 in `settings-layout.spec.ts`), 38778364254 (PR #13) and 38456753890; each passed on rerun. Find whether the runner is merely slow or the close path sometimes stalls on Windows (time each phase of the close in the fixture's log), and fix the cause; raise the limit only if the measurement shows a slow but complete close.

### 6. Documentation

- [ ] Record the outcome in [recording](../docs/system-design/recording.md), [tooling](../docs/system-design/tooling.md) and the verification record, with translations.

## Completion and verification boundaries

Complete when each step is done or the maintainer has accepted its outcome, with its measurements recorded. Engine changes follow [the testing policy](../docs/testing.md#select-tests-from-behavior)'s recording rows: `cargo test`, `pnpm check`, and a native matrix round on the signed bundle or the development app as the step needs, each a desktop round under the [readiness handoff](../docs/testing.md#confirm-desktop-handoff-before-testing). Writing this plan needs only links, English/Chinese parity and `git diff --check`.
