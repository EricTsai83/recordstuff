# 090 — A camera slow to its first frame

[English](090-camera-first-frame.md) | [繁體中文](090-camera-first-frame.zh-TW.md)

Status: planned; not started. Created: 2026-10-23 at the maintainer's request, from 083's camera round ([record](../docs/verification/history-2026-10.md#plan-083-closure--2026-10-23)); revised the same day: its former D2, the resumption's gap, became 093, which closed on 2026-10-23 ([record](../docs/verification/history-2026-10.md#plan-093-closure--2026-10-23)), so the rounds here read real gaps. Hard dependencies: none open. First in the queue, ahead of 091. Execute in order under the [plan index](README.md). This task writes the plan only; none of the behavior below has been implemented or verified.

## Goal and current state

083's seventh round composed the maintainer's iPhone (Continuity Camera) into recordings. In both recordings started right after the Recording Studio closed, the camera delivered its first frame only 2.5 s and 12 s after the recording began. `CameraFeed::judge` ([camera.rs](../native/capture/src/core/camera.rs)) counts `CAMERA_SILENT_NS` (2 s) from the recording's start when the camera has delivered nothing, so each recording was told `cameraLost`, showed a dropout notification after saving and composed the screen alone until the camera came; the 60 fps recording had the camera for about 48 of its 60 s. Every other recording of the round had its first camera frame in time. The cause is not known: Continuity reconnecting after the Studio's own capture let the camera go is a guess, not a finding.

The engine already opens the camera in `prepare`, before the screen and before the countdown ([mac/session.rs](../native/capture/src/mac/session.rs)), so with a countdown the camera has a head start. 083's rounds ran with the countdown Off (`measure:cpu` writes it Off), which gave the camera none; whether the default countdown hides the 2.5 s case is not known either.

083's camera figures are also not a clean baseline: the 60 fps R composed the camera for only 48 s, and its 16.2% is low for that (the [pipeline baseline](../docs/system-design/tooling.md#pipeline-baseline) says so). This plan retakes them.

## Steps and ownership

- [ ] **Baseline first.** On the signed bundle, with the maintainer's go-ahead for each round that opens a camera, with the lid closed as 083 had it: the iPhone's open-to-first-frame time (from `camera start` in `prepare`) and from recording start, in the case that reproduced (right after the Studio's live camera closed) and an idle control, each with the countdown Off and at its default; and a clean camera R and S (`measure:cpu -- --camera … --studio --diagnostics`) whose recordings had the camera from their first second. Add a first-frame time to the camera's state line if it is not readable from the existing lines. These figures replace 083's camera rows in the pipeline baseline. Record whether the delay follows the Studio, the device or something else; if the Studio's release of the camera causes it, say so, since that is what a fix would address.
- [ ] **Decide the start's rule (D1) at the decision point, then implement it.** The recommendation, from how comparable recorders behave (OBS and Loom start recording without waiting for a camera): **start at once, never wait; time the camera's first frame from its opening in `prepare`, with its own longer bound** (about 10 s, to be set from the baseline), and tell a camera that delivers nothing within that bound as *not ready* rather than *lost*; once it has delivered, today's 2 s loss rule applies. The alternative, waiting in `prepare` for up to a few seconds, lengthens every camera start and meets plan 065's rule that a start lasting 1 s can be cancelled; it is kept only if the baseline shows a short, bounded delay the countdown does not cover. A third option, keeping today's rule and rewording the notice, stays available. The maintainer chooses.
- [ ] **Say what the recording shows before the first frame.** Today it is the screen alone until the camera arrives, then the bubble appears mid-recording. Keep that (no placeholder bubble is composed) unless the maintainer decides otherwise at D1, and state it in the [recording design](../docs/system-design/recording.md) with the notice the user sees after saving.
- [ ] **Measure after.** The same cases on a fresh signed bundle: no false *lost* for a camera within the bound, the right notice for one beyond it, and the clean camera R and S within the new baseline's spread.

## Gates and completion

A camera whose first frame comes within the bound is neither told lost nor shown as a dropout, and is composed from its first frame; one that never delivers is told *not ready* within the bound; nothing waits without a bound, and a recording without a camera is unchanged (083's R within its spread). The pipeline baseline's camera rows are retaken from recordings that had the camera throughout, before and after.

## Verification

Focused Rust tests with a fake clock for D1's rule (first-frame bound measured from the camera's opening, loss after first delivery, never-delivering camera, no camera); `pnpm check` for the engine change. Desktop rounds as in the steps, on fresh signed bundles after the “好了” handoff, the files verified with `pnpm verify`, the notices observed. The built-in camera with the lid open is one observation in the final round, not a baseline: lid-open CPU figures are not comparable with 083's lid-closed ones and are reported apart. Windows by CI only, as 076's D8 says.

## Execution and closure contract

Follow the [plan index](README.md) for order, decision points, desktop handoff and closure; preserve the camera's optional status (D12: losing it never fails the recording) and capture-process fault isolation. At execution start inspect the current tree and the closure records of 083 and 093; the numbers here are observations of one round, not targets.
