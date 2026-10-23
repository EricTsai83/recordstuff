# 090 — A camera slow to its first frame, and its resumption's gap

[English](090-camera-first-frame.md) | [繁體中文](090-camera-first-frame.zh-TW.md)

Status: planned; not started. Created: 2026-10-23 at the maintainer's request, from two observations of 083's camera round ([record](../docs/verification/history-2026-10.md#plan-083-closure--2026-10-23)). Hard dependencies: none; next in the queue, ahead of 091 and 084. Execute in order under the [plan index](README.md). This task writes the plan only; none of the behavior below has been implemented or verified.

## Goal and current state

083's seventh round composed the maintainer's iPhone (Continuity Camera) into recordings. In both recordings started right after the Recording Studio closed, the camera delivered its first frame only 2.5 s and 12 s after the recording began. `CameraFeed::judge` ([camera.rs](../native/capture/src/core/camera.rs)) counts `CAMERA_SILENT_NS` (2 s) from the recording's start when the camera has delivered nothing, so each recording was told `cameraLost`, showed a dropout notification after saving and composed the screen alone until the camera came; the 60 fps recording had the camera for about 48 of its 60 s. Every other recording of the round had its first camera frame in time. The cause is not known: Continuity reconnecting after the Studio's own capture let the camera go is a guess, not a finding.

Separately, the resumption's message measures its gap from `heard_ns`, which is 0 for a camera that has delivered nothing, so it read "the camera delivered frames again after 2478244.7 s" (the host's uptime) instead of about 2.5 s. That defect has existed since plan 075.

## Steps and ownership

- [ ] **Measure first.** On the signed bundle, with the maintainer's go-ahead for each round that opens a camera, time the camera's open-to-first-frame for the iPhone and, with the lid open, the built-in camera: from idle, right after the Studio's live camera closed, right after a recording, and after a Live preview. 083's `--diagnostics` figures and the engine's `camera: after preparing … N frame(s) delivered` line are the evidence; add a first-frame time to the camera's state line if it is not readable from them. Record whether the delay follows the Studio, the device or something else.
- [ ] **Decide the start's rule (D1), then implement it.** Options to weigh from the measurements: wait in `prepare`, bounded (for example up to 3 s), for the camera's first frame before the recording starts, as `first_frame` waits for the screen's; or start at once and count the silence from the camera's first frame or from a longer first-frame bound, telling a camera that never delivers as unavailable rather than lost; or keep today's rule and only word the notice differently. A camera that never delivers must still be told, and the recording must never wait without a bound. The maintainer chooses at the decision point.
- [ ] **Fix the resumption's gap (D2).** A camera that had delivered nothing measures its gap from the recording's start (`since_ns`), as `judge` does and as the microphone's `microphone_resumed` already does. Unit tests in core/camera.rs and core/tests.rs with a fake clock.

## Gates and completion

A camera whose first frame comes within the chosen bound is neither told lost nor shown as a dropout, and is composed from its first frame; one that never delivers is still told, within the chosen bound; nothing waits without a bound, and a recording without a camera is unchanged. The resumption's message names the real gap. 083's figures for a recording with the camera stay within its baseline.

## Verification

Focused Rust tests for D2 and for D1's rule with a fake clock; `pnpm check` for the engine change. A desktop round on a fresh signed bundle, the iPhone and (lid open) the built-in camera, each opened only after the maintainer agrees: the cases of the first step before and after, the files verified (`pnpm verify`), the notices observed. Windows by CI only, as 076's D8 says.

## Execution and closure contract

Follow the [plan index](README.md) for order, decision points, desktop handoff and closure; preserve the camera's optional status (D12: losing it never fails the recording) and capture-process fault isolation. At execution start inspect the current tree and 083's closure record; the numbers here are observations of one round, not targets.
