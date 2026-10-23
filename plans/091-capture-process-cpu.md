# 091 — Where the capture process's CPU goes

[English](091-capture-process-cpu.md) | [繁體中文](091-capture-process-cpu.zh-TW.md)

Status: planned; not started. Created: 2026-10-23 at the maintainer's request, from 083's figures ([record](../docs/verification/history-2026-10.md#plan-083-closure--2026-10-23), [pipeline baseline](../docs/system-design/tooling.md#pipeline-baseline)); revised the same day with a stop rule, a worth-it threshold and the duty to retake the baseline. Hard dependencies: 083 (closed). Third in the queue, after 090 and ahead of 092. Execute in order under the [plan index](README.md). This task writes the plan only; nothing below has been measured beyond 083's rounds.

## Goal and current state

083's switch-on round on the reference M1 Pro found the capture process (the `utilityProcess` running the engine) at about 100 ms of CPU a second while recording the moving material at 30 fps and about 146 ms at 60 fps. The stages 083 times inside the engine add up to far less: the core taking each delivered picture (`capture_callback`, which includes its submission to the encoder) about 12–14 ms a second at 30 fps and 25–29 ms at 60, and the writer about 2–3 ms. Those are wall-clock durations, so the CPU spent in them is at most that much: about 80–86% of the process's CPU is outside every stage 083 measures. The still material shows the shape: 3.3% with about one picture a second, so roughly 33 ms a second is spent whatever the screen does (sound, the Node runtime, timers), and each picture delivered costs about 1.1 ms more, of which the core's own handling is about 0.2 ms.

Recording CPU (10.4% / 14.0% of a core at 30 / 60 fps) is already far inside its budget (30% / 40%), so this is an investigation for battery life and understanding, not a fix of a breach. It is worth a change only where a cause is large and its remedy safe.

Two facts point where to look first, without deciding anything:

- Capture is asked for a quarter of the frame interval (`Pacer::capture_interval_ns`, [pacing.rs](../native/capture/src/pacing.rs), plan 076 step 7), so ScreenCaptureKit delivers every display refresh, about 58 pictures a second, even at 30 fps; the pacer keeps half of them. Each delivery crosses from the system's capture service into the process (an IOSurface-backed `CMSampleBuffer`, Objective-C retains and an autorelease pool) whether it is kept or not. The quarter interval is deliberate: with plan 078's filling of skipped refreshes it keeps every slot near a frame, and asking for the frame interval risks the 50 ms gaps 076 and 078 removed.
- Sound is taken all the time while recording: ScreenCaptureKit's audio buffers, the mixer and AAC encoding run in the same process, as do the Node runtime and the native addon's thread-safe calls.

Comparable tools measure lower on newer Macs (single-process figures of about 3–6% for native ScreenCaptureKit recorders on an M4 Pro, 5.9% for rec-rs's recorder process at 1080p60), but no comparison so far used the same machine, material or scope, so this plan measures ours rather than chasing theirs.

## Scope

Out of scope: moving the engine out of Node's `utilityProcess` (a sidecar binary, a different host), which changes supervision, packaging and fault isolation and needs its own plan; changing the recording's encoder or quality; Windows profiling.

## Steps and ownership

- [ ] **Check the profiler can see the frames that matter.** Before the rounds, confirm on one short recording that `pnpm measure:cpu -- --profile` (plan 081, `sample`) resolves ScreenCaptureKit's, CoreMedia's, AudioToolbox's and the engine's frames by thread. If it does not, use Instruments' Time Profiler (`xctrace record --template 'Time Profiler' --attach <pid>`) for the capture process and keep its trace beside the report.
- [ ] **Retake the baseline and attribute by thread.** On the current HEAD's signed bundle (083's bundle predates 089, 090 and 093), run R with `--repeat 3 --diagnostics --profile` on the moving and still material at 30 and 60 fps, and `pnpm matrix -- quick` and `long` for pacing and sync. Split the capture process's samples by thread: ScreenCaptureKit's delivery queue, the refresh thread, the writer, the audio and microphone threads, AudioToolbox's AAC encoder, Node's main thread and libuv. These runs are the before figures for every comparison here.
- [ ] **Isolate with switches, one at a time, against the same bundle.** Sound off (`RECORDSTUFF_CAPTURE_AUDIO=off`, plan 076's development switch, which `measure:cpu` refuses from launchd and so needs a runner option that passes it with `open --env`), the still material, and a development switch that asks capture for the frame interval itself instead of a quarter of it. Each answers how much of the unexplained share one cause carries; none is a product change.
- [ ] **Stop or decide (D1).** Stop here, recording the attribution as the finding, if no single cause is worth at least **2 points of a core at 30 fps** (about a fifth of the process), or if most of the share is the Node runtime's fixed cost (out of scope above). Otherwise the maintainer chooses at the decision point which cost to reduce, by what change and with what risk (frame pacing, A/V sync, a camera's every-slot encoding, Windows), or to defer.
- [ ] **If chosen, implement and measure** against 083's gate and the threshold above: an improvement larger than the baseline's spread, at least 10% of the median and at least 2 points at 30 fps, with `pnpm matrix -- quick` **and `long`** (pacing, drops, A/V offset, drift) and `pnpm verify` unchanged. A change to the capture interval also runs the still material, whose idle-path encoding depends on deliveries.
- [ ] **Retake the pipeline baseline.** If a change is adopted, the tooling guide's pipeline baseline is retaken on the final bundle (R, the still material, and the Studio's S and L, since every Studio figure is a share over R) and the budgets that cite it are updated; later plans measure against it, not 083's.

## Gates and completion

The plan closes with the capture process's CPU attributed by thread and by cause for both materials and rates, its unexplained share named, and either an adopted change that clears the gate with recording integrity unchanged and the baseline retaken, or a written finding that no change was worth its risk. Instrumentation added for the attribution is a development switch or is removed before closure.

## Verification

Profiles and switches are desktop rounds on a fresh signed bundle with the maintainer's handoff; no camera is opened unless the maintainer agrees. A code change runs `pnpm check`, the affected `pnpm measure:cpu` cases, `pnpm matrix -- quick` and `long`, and `pnpm verify` on its files. Windows by CI only, as 076's D8 says; a capture-interval change is macOS-only unless Windows is changed and stated.

## Execution and closure contract

Follow the [plan index](README.md) for order, decision points, desktop handoff and closure; preserve the capture process's fault isolation, the direct-MP4 default and 076's frame pacing. At execution start inspect the current tree and the records of 083, 090 and 093; the figures above are one machine's.
