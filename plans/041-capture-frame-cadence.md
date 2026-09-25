# 041 — Capture cadence at the requested frame rate

[English](041-capture-frame-cadence.md) | [繁體中文](041-capture-frame-cadence.zh-TW.md)

Status: planned, not implemented. Created: 2026-09-25. By maintainer decision (2026-09-25) it goes first in the queue, before 031, and it precedes 040 and 037. Execution order: see [queue](README.md#order-and-status). Source: the frame-timestamp analysis after the [plan 030](../docs/verification/history-2026-09.md#plan-030-closure--2026-09-25) native round.

## Problem and evidence

Every recording on this machine delivers frames slightly slower than requested, with no dropped frames. Frame timestamps read with ffprobe (time base 1/30000 or 1/60000) from four recordings:

| Recording | Requested | Delivered | Median interval (nominal) | Drops |
| --- | --- | --- | --- | --- |
| `2026-09-25 16-31-41.mp4`, 10-second hotkey round | 60 fps | 57.54 fps | 17.32 ms (16.67) | 0 |
| `2026-09-25 23-06-14.mp4` and `23-07-53.mp4`, `pnpm matrix -- quick` | 30 fps | 29.42 and 29.41 fps | 33.90 ms (33.33) | 0 |
| `2026-09-25 23-08-54.mp4`, `pnpm matrix -- long`, 180 seconds | 30 fps | 29.38 fps | 33.90 ms (33.33) | 0 |

At 30 fps the intervals lie between 1000 and 1046 ticks of 1/30000 s (33.3–34.9 ms): almost none is shorter than the nominal period and none is twice it. The mean excess is about 0.7 ms per frame at both rates, which costs about 2% of the frames at 30 fps and 4% at 60 fps. Earlier records agree: the ten-minute baseline measured 29.30 fps and 60 fps was accepted at about 57 fps ([results](../docs/verification/history-2026-09.md#results)), the update acceptance 29.28 fps, and two 60 fps hotkey rounds reported 55.32 and 56.60 fps with 2.58% and 2.85% drops ([plan 020 verification](../docs/verification/history-2026-09.md#plan-020-development-verification--2026-09-23)).

The deficit is systematic, not random, but it makes the tests fragile: 30 fps already uses 0.6 of the ±2 fps tolerance, so extra scheduling latency under load can tip it over, and 60 fps fails the average frame rate whenever frame timing is judged (`pnpm matrix -- fps`, `pnpm verify -- … --sync`). A 60 fps recording holds about 4% fewer frames than requested. Audio/video sync is unaffected because the timestamps are real time: the long case drifted 1.3 ms.

## Static reading and hypothesis

Static source review of Chromium 152.0.7977.78, the version in Electron 44.3.0 (not a trace of the running app):

- macOS screen capture uses `ScreenCaptureKitDeviceMac`: [`kScreenCaptureKitMacScreen` is enabled by default](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.78/content/browser/renderer_host/media/in_process_video_capture_device_launcher.cc#92) and [screens prefer that device](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.78/content/browser/renderer_host/media/in_process_video_capture_device_launcher.cc#195). The timer-driven `DesktopCaptureDevice`, whose rescheduling also accumulates latency, is only the fallback.
- The device sets [`SCStreamConfiguration.minimumFrameInterval` to exactly 1/requested rate](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.78/content/browser/media/capture/screen_capture_kit_device_mac.mm#239).
- [`IOSurfaceCaptureDeviceBase` timestamps each frame with `base::TimeTicks::Now()` on arrival](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.78/content/browser/media/capture/io_surface_capture_device_base_mac.cc#57), not with ScreenCaptureKit's presentation time.
- RecordStuff requests `frameRate: { ideal: N, max: N }` in `getDisplayMedia` and repeats it in `applyConstraints` ([capture host](../src/renderer/capture-host.ts)).

Hypothesis: the requested rate becomes a minimum interval, a floor, so each delivered interval is the floor plus scheduling latency and the average stays below the request. Not yet measured: whether the excess comes from ScreenCaptureKit's delivery, from Chromium's frame-rate limiter on the track (`max`) or from timestamping. Step 1 decides that before any product change.

## Cap reference

At pinned revision `b2b6ae45d4cae303107b10a9df166d91caed7702` (static source review, Cap not run), Cap [sets the minimum frame interval in whole milliseconds, `1000 / fps` truncated](https://github.com/CapSoftware/Cap/blob/b2b6ae45d4cae303107b10a9df166d91caed7702/crates/scap-screencapturekit/src/config.rs#L24-L31): 33 ms for 30 fps and 16 ms for 60 fps, slightly below the nominal period. It [timestamps frames with the sample buffer's presentation time](https://github.com/CapSoftware/Cap/blob/b2b6ae45d4cae303107b10a9df166d91caed7702/crates/recording/src/sources/screen_capture/macos.rs#L314-L317) and [scales the queue depth with the frame rate](https://github.com/CapSoftware/Cap/blob/b2b6ae45d4cae303107b10a9df166d91caed7702/crates/recording/src/sources/screen_capture/macos.rs#L241-L251). These are design choices, not evidence that Cap's cadence is exact. RecordStuff controls only what it requests through web constraints; Chromium's timestamp source and queue depth are outside its reach.

## Scope

In scope: the frame-rate request in the capture host and what reports it, a diagnostic that confirms the layer, optional reporting of cadence in `pnpm verify`, and bilingual documentation. Out of scope: `THRESHOLDS` (the ±2 fps tolerance and the drop rate), the bitrate formula (still computed from the requested rate), resolution caps, audio, Windows, patching Chromium, or replacing its capture with a native module.

## Step 1 — Confirm the layer

- [ ] Build a labeled diagnostic that is not shipped (temporary instrumentation or an isolated fixture). While it records the moving test material at 30 and 60 fps, log every video frame's timestamp in the renderer before MediaRecorder (`MediaStreamTrackProcessor` or `requestVideoFrameCallback`), `track.stats` (delivered, discarded and total frames) and `track.getSettings().frameRate`, and compare them with the file's pts. Run at least two 30-second recordings per rate on the 60 Hz primary display; record its refresh rate and the CPU.
- [ ] Classify from the distributions, not the means: (A) frames already arrive at the period plus the excess and none is discarded — the source floor; (B) frames arrive at or above the rate and the track discards some — Chromium's limiter; (C) frames arrive on time but the file's intervals are longer — recorder timestamps. Repeat once under a controlled CPU load to see whether the excess grows. Write the classification down before choosing a fix.

## Step 2 — Fix at the owning layer

- [ ] For (A) or (B), compare candidate requests that keep the recorded rate at the setting, such as a `max` a few percent above it or `ideal` alone. Choose the smallest change that meets the go criteria, explain in the code why the request differs from the setting, and keep bitrate targets on the requested rate. At 30 fps on a 60 Hz display confirm that the limiter adds no doubled intervals; at 60 fps confirm that nothing exceeds the display rate or repeats frames.
- [ ] For (C), fix the timestamps if RecordStuff controls them; otherwise treat it as a no-go below.
- [ ] Keep `frameRateDowngrade` and `CaptureReport.frameRate` truthful: a changed request must neither trigger nor hide the 60→30 downgrade notification. Add unit tests for the constraint builder and the downgrade rule.
- [ ] Optionally show the median frame interval next to the average frame rate in `pnpm verify`, so a cadence deficit is told apart from drops. Reporting only; no new threshold.
- [ ] No-go: if no candidate meets the criteria without drop, CPU or sync regressions, change no product code. Report upstream to Chromium/Electron with the measurements and the static reading, document the measured cadence as a platform limit in the recording and tooling guides, and record in [design decisions](../docs/system-design/decisions.md) the maintainer's decision on whether 60 fps stays offered. Do not loosen `THRESHOLDS`; a known 60 fps failure stays visible.

## Go criteria

On this machine and material, before and after on the same display, with at least two runs per rate:

- the average within 0.5 fps of 30 and 1 fps of 60, and the median interval within 1% of the nominal period;
- no more doubled intervals or drops than the baseline, and a drop rate below 2%;
- average CPU within 3 percentage points of the baseline, flash/beep offset and long-case drift within their thresholds, channel energy passing and video bitrate at least 70% of the target.

## Verification and exclusions

- [ ] `pnpm check` with the focused unit tests.
- [ ] A recording smoke on a fresh `pnpm start:app` bundle: start, stop, save, media verification and playback, for example `pnpm acceptance` with the 60 fps setting plus QuickTime playback through the [native acceptance skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md).
- [ ] `pnpm matrix -- fps`, `pnpm matrix -- quick` and `pnpm matrix -- long` before and after the change, keeping the channel RMS and sync evidence required since 030.
- [ ] Excluded unless the cadence turns out to depend on them: the levels matrix, ten-minute runs, permission resets and settings regression (the settings UI does not change). Any required native case left unperformed goes to 035.

## Completion and evidence handling

Follow the [shared testing policy](../docs/testing.md) and [plan completion](README.md#completing-a-plan). Keep a `caffeinate` running during desktop rounds, give one executor the desktop, audio and shortcuts per round, serialize builds, and restore settings, close test UI, quit the tested app and confirm its processes exited.

- [ ] Record checks and results, scope exclusions and required-but-unverified cases separately. The diagnostic's instrumentation must not ship; remove it or keep it behind an isolated fixture. Run `git diff --check`.
- [ ] Preserve the classification, the chosen request or the no-go decision and the before/after measurements in the bilingual recording, tooling and verification documents, update both indexes, then remove this plan and its translation. Do not commit, push or publish without a separate request.

Planning-only validation: relative links/anchors, command names, bilingual coverage and `git diff --check`; no build, tests, launch or recording just to write this plan. The Chromium and Cap references are static source reading at the pinned tag and revision, not execution.
