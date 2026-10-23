# 091 — Where the capture process's CPU goes

[English](091-capture-process-cpu.md) | [繁體中文](091-capture-process-cpu.zh-TW.md)

Status: planned; not started. Created: 2026-10-23 at the maintainer's request, from 083's figures ([record](../docs/verification/history-2026-10.md#plan-083-closure--2026-10-23), [pipeline baseline](../docs/system-design/tooling.md#pipeline-baseline)). Hard dependencies: 083 (closed). Next after 090, ahead of 084. Execute in order under the [plan index](README.md). This task writes the plan only; nothing below has been measured beyond 083's rounds.

## Goal and current state

083's switch-on round on the reference M1 Pro found the capture process (the `utilityProcess` running the engine) at about 100 ms of CPU a second while recording the moving material at 30 fps and about 146 ms at 60 fps. The stages 083 times inside the engine add up to far less: the core taking each delivered picture (`capture_callback`, which includes its submission to the encoder) about 12–14 ms a second at 30 fps and 25–29 ms at 60, and the writer about 2–3 ms. Those are wall-clock durations, so the CPU spent in them is at most that much: about 80–86% of the process's CPU is outside every stage 083 measures. The still material shows the shape: 3.3% with about one picture a second, so roughly 33 ms a second is spent whatever the screen does (sound, the Node runtime, timers), and each picture delivered costs about 1.1 ms more, of which the core's own handling is about 0.2 ms.

Two facts point where to look first, without deciding anything:

- Capture is asked for a quarter of the frame interval (`Pacer::capture_interval_ns`, plan 076 step 7), so ScreenCaptureKit delivers every display refresh, about 58 pictures a second, even at 30 fps; the pacer keeps half of them. Each delivery crosses from the system's capture service into the process (an IOSurface-backed `CMSampleBuffer`, Objective-C retains and an autorelease pool) whether it is kept or not.
- Sound is taken all the time while recording: ScreenCaptureKit's audio buffers, the mixer and AAC encoding run in the same process, as do the Node runtime and the native addon's thread-safe calls.

Comparable tools measure lower on newer Macs (single-process figures of about 3–6% for native ScreenCaptureKit recorders on an M4 Pro, 5.9% for rec-rs's recorder process at 1080p60), but no comparison so far used the same machine, material or scope, so this plan measures ours rather than chasing theirs.

## Steps and ownership

- [ ] **Attribute by thread.** `pnpm measure:cpu -- --profile` (plan 081) samples each process for 10 s inside each recording; run it on the moving and still material at 30 and 60 fps, with `--diagnostics` beside it in the same round, and split the capture process's samples by thread: ScreenCaptureKit's delivery queue, the refresh thread, the writer, the audio and microphone threads, AudioToolbox's AAC encoder, Node's main thread and libuv. Keep the profiles beside the report.
- [ ] **Isolate with existing switches, one at a time, against the same bundle.** Sound off (`RECORDSTUFF_CAPTURE_AUDIO=off`, plan 076's development switch, which `measure:cpu` refuses from launchd and so needs a runner option that passes it with `open --env`), the still material, and if needed a development switch that asks capture for the frame interval itself instead of a quarter of it (whose effect on 076's pacing, the 50 ms gaps it fixed, must be measured with `pnpm matrix -- quick`). Each answers how much of the unexplained share one cause carries; none is a product change.
- [ ] **Decide (D1) at the decision point.** From the attribution: which cost is worth reducing, by what change, and what it risks (frame pacing, A/V sync, a camera's every-slot encoding, Windows). The maintainer chooses whether to implement, defer or record the finding only.
- [ ] **If chosen, implement and measure** against 083's gate: an improvement larger than the baseline's spread and at least 10% of the median, with `pnpm matrix` (pacing, drops, A/V offset) and `pnpm verify` unchanged.

## Gates and completion

The plan closes with the capture process's CPU attributed by thread and by cause for both materials and rates, its unexplained share named, and either an adopted change that clears 083's gate with recording integrity unchanged, or a written finding that no change was worth its risk. Instrumentation added for the attribution is a development switch or is removed before closure.

## Verification

Profiles and switches are desktop rounds on a fresh signed bundle with the maintainer's handoff; no camera is opened unless the maintainer agrees. A code change runs `pnpm check`, the affected `pnpm measure:cpu` and `pnpm matrix` cases (`long` if pacing or sync could drift), and `pnpm verify` on its files. Windows by CI only, as 076's D8 says.

## Execution and closure contract

Follow the [plan index](README.md) for order, decision points, desktop handoff and closure; preserve the capture process's fault isolation, the direct-MP4 default and 076's frame pacing. At execution start inspect the current tree and 083's and 090's records; the figures above are one machine's.
