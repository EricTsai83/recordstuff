# 094 — The Studio's Camera view

[English](094-studio-camera-view.md) | [繁體中文](094-studio-camera-view.zh-TW.md)

Status: planned; not started. Created: 2026-10-23 at the maintainer's request, split from 092 (its former Camera view in D3) because it is that plan's largest part: a new compositor parameter set on both platforms and a page-side path before recording. Hard dependencies: 092 (its `view` message and Studio baseline) and 090 (a camera that reaches its first frame reliably), and 095 (the stage it is drawn on, added on 2026-10-23; closed on 2026-10-24, its stage, toolbar line and 960-pixel preview in the [record](../docs/verification/history-2026-10.md#plan-095-closure--2026-10-24) and the [Recording Studio design](../docs/system-design/desktop.md#recording-studio)). Fifth in the queue, after 092 and ahead of 084, so 084 bounds the port once every message it carries exists. Execute in order under the [plan index](README.md). This task writes the plan only; none of the behavior below has been implemented or verified.

## Goal and current state

After 092 the Studio's preview shows the composed picture or the screen alone. The user cannot check the camera itself (framing, light, focus) at a usable size: in the composed picture the bubble is a small part of a 391 × 220 stage. The Camera view shows the camera alone, enlarged, without changing what is recorded.

## Decision (maintainer, 2026-10-23)

- **D1 — the Camera view** joins 092's view segments: **Composed / Screen / Camera**. The stage keeps its size and the recording's shape. Camera draws the camera alone, enlarged to the largest rectangle that fits in the stage, centred, with the bubble's own width-to-height ratio and rounding as the recording composes it; the outline is hidden. Only the preview changes: the recording is always the composed picture.

## Steps and ownership

- [ ] **The engine side.** `camera` becomes a value of 092's `view` message. A new parameter set in `camera_layout.rs`: the bubble's crop at the largest centred size in the preview's output, the screen not drawn, the surround in the stage's background colour; the recording's `compose` is untouched. The camera is sampled from its full 1280 × 720 frame, not from the composed picture, so the enlarged view is sharp. A change of view forces a key frame, as in 092. Rust tests for the parameters on both platforms' compositors, including that the recording's parameters do not change with the view.
- [ ] **The page side.** The third segment, the outline hidden in Camera, and the cases without a picture: before a session, Camera enlarges the page's own camera (`getUserMedia`, which the Studio opens for the bubble whenever the preview is on) with the same ratio and rounding, so no second capture of the camera is opened; a lost, not-ready (090) or hidden camera shows a placeholder naming why. Production components and CSS only, per the [UI alignment rules](../docs/testing.md#keep-test-ui-aligned-with-the-app).
- [ ] **Measure and document.** `measure:cpu` with the Studio watched at Power saving and Standard, the Composed view and the Camera view back to back in the same round with the same camera and audio inputs (per the [testing policy](../docs/testing.md#keep-recording-rounds-short), since the difference is small; repeated A, B, A if it hinges on it): the Camera view composes less than Composed, so it must not cost more than that control's spread. 092's Studio rows are context only, since they were taken without a camera. A recording with the camera switched into and out of Camera, its file checked to be the composed picture. Update the Studio's sections in [recording](../docs/system-design/recording.md) with translations.

## Gates and completion

The Camera view's ratio and rounding match the composed bubble, before and during a session; switching views never changes the recorded file and never stalls or fails a recording; its CPU is within the spread of the Composed control measured beside it at the same rate.

## Verification

Focused tests (`pnpm test:scope -- studio`, the Rust parameter tests); `pnpm check` for the engine change. A desktop round on a fresh signed bundle after the “好了” handoff, the camera opened at the maintainer's go-ahead: `pnpm acceptance:studio`, the CPU cases, a recording verified with `pnpm verify`, and the Camera view's shape observed by eye against the composed bubble. Windows by CI only.

## Execution and closure contract

Follow the [plan index](README.md) for order, decision points, desktop handoff and closure; preserve capture-process fault isolation and that a preview failure never fails a recording. At execution start inspect the current tree and the closure records of 090 and 092.
