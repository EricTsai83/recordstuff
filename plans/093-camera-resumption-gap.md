# 093 — The camera's resumption names the real gap

[English](093-camera-resumption-gap.md) | [繁體中文](093-camera-resumption-gap.zh-TW.md)

Status: planned; not started. Created: 2026-10-23 at the maintainer's request, split from 090 (its former D2) so that a logic fix does not wait for 090's camera rounds. Hard dependencies: none; first in the queue, ahead of 090. Execute in order under the [plan index](README.md). This task writes the plan only; nothing below has been implemented or verified.

## Goal and current state

When the camera resumes, `CameraFeed` measures the gap from `heard_ns` ([camera.rs](../native/capture/src/core/camera.rs)). A camera that has delivered nothing yet has `heard_ns` 0, so 083's camera round logged "the camera delivered frames again after 2478244.7 s", the host's uptime, instead of about 2.5 s ([record](../docs/verification/history-2026-10.md#plan-083-closure--2026-10-23)). The defect has existed since plan 075. `judge` already counts silence from `heard_ns.max(since_ns)`, and the microphone's `microphone_resumed` already measures from the recording's start; only the camera's resumption does not.

## Steps and ownership

- [ ] Measure the resumption's gap from `heard_ns.max(since_ns)`, the same reference `judge` uses, so a camera that had delivered nothing measures from the recording's start. Keep the message's wording and the event's shape; only the number changes.
- [ ] Unit tests with a fake clock in core/camera.rs and core/tests.rs: a camera silent from the start that resumes after 2.5 s reports 2.5 s; a camera that delivered, went silent and resumed reports the silence; the loss rule (`CAMERA_SILENT_NS`) is unchanged.

## Gates and completion

The resumption names the real gap in both cases; no other camera behavior changes, and 090's start rule is not touched.

## Verification

Focused Rust tests under `core::` (`pnpm test:scope -- pipeline-diagnostics` runs them); `pnpm check` for the engine change. No desktop round: the change is a pure calculation covered by the fake clock, and 090's camera round observes the message on hardware. Windows by CI only, as 076's D8 says.

## Execution and closure contract

Follow the [plan index](README.md) for order and closure; preserve the camera's optional status (D12) and capture-process fault isolation. At execution start inspect the current tree and 083's closure record.
