# 081 — What the Recording Studio's page costs while it shows a recording

[English](081-studio-page-cost.md) | [繁體中文](081-studio-page-cost.zh-TW.md)

Status: planned; not started. Created: 2026-10-19, from 080's closure at the maintainer's request. Priority: the maintainer orders it; one plan at a time. Hard dependencies: 075's Recording Studio (closed, [record](../docs/verification/history-2026-10.md#plan-075-closure--2026-10-18)) and 080's measurements (closed, [record](../docs/verification/history-2026-10.md#plan-080-closure--2026-10-19)). Execute the steps in order under [the plan index](README.md).

## Goal and boundaries

Find what the Studio's page itself costs while it shows a recording or a Live preview, and cut it. 080 showed that the preview's transport (the 640-pixel H.264 stream and its decoder) is a small part of the Studio's share; most of it is the page: main working while the Studio is open although the frames never pass through it, the renderer, and Chromium's GPU process compositing a canvas that changes 10 times a second. Success is the Studio's share over a recording at 30 fps within D18's 8 points on the reference Mac with the camera delivering, or a measured account of what remains and why it cannot go.

Out of scope: the preview's transport (080 measured shared textures and kept the stream; [decisions](../docs/system-design/decisions.md)), the recording's own path, and a larger or faster preview.

## Current state

- **The share.** On 2026-10-19, with the camera delivering no frame, a recording at 30 fps cost 10.7% of a core and 24.4% with the Studio showing it, 13.6 points more; 10.0 points at 60 fps (the encoded run). 075 measured 8.9 and 11.3 points with the camera on; D21 accepted the excess over D18's 8.
- **Where it goes (encoded preview, 30 fps).** The capture process about 2 points more (the preview's compositing and encoder), VTEncoder about 0.5, the Settings renderer 6.2, Chromium's GPU process 3.5, and main 2.2 (2.36% against 0.13% without the Studio). The frames go from the capture process to the page on a `MessageChannelMain` port, so main's 2.2 points are something else the Studio asks of it: levels, the settings view, the preview link, or Chromium's work for a visible window.
- **What a changing canvas costs.** 080's benchmark outside the app, a 640×360 canvas in an otherwise empty window receiving shared frames 10 times a second: against the frames received and not drawn (1.0 points in the GPU process, 0.85 in the renderer), repainting the canvas from CPU pixels (`putImageData`) cost about 3.5 and 1.6 more, and drawing the NV12 `VideoFrame` by `drawImage`, WebGL, WebGPU or `bitmaprenderer` about 5–6 and 1.5–1.9 more. The CPU repaint was measured with the shared frames still arriving; a window with no shared texture at all was not measured. A `<video>` element fed by `MediaStreamTrackGenerator`, which Chromium may hand to Core Animation as an overlay, was not measured.

## Steps

### 1. Attribute

- [ ] Hold a Live preview (L) and, apart, a recording with the Studio (S); profile main (`sample`, Electron's `contentTracing`), the renderer (React renders, the meters' and preview's frame clock) and the GPU process, and attribute the points to named work. Repeat with the preview out of sight and the meters out of sight, to separate their shares.
- [ ] Measure the `<video>`-with-`MediaStreamTrackGenerator` display against the canvas in the benchmark, and in the app if it is cheaper.

### 2. Decide

- [ ] **D1 The fixes.** From step 1's figures, the changes to make, each with its expected saving; candidates include work main repeats while the Studio is open, the canvas replaced by a `<video>` overlay, fewer or smaller repaints, and an OBS-style switch that turns the preview off.
- [ ] **D2 The gate.** Recommended: S within 8 points of R at 30 fps on the reference Mac with the camera delivering, L within a recording's figures, and the preview's delay and smoothness unchanged.

### 3. Build, verify and document

- [ ] The changes D1 chose, with the page tests and the background UI suite they touch.
- [ ] `pnpm measure:cpu -- --camera preview=0 --skip-settings --skip-playback --studio --fps 60` on the signed bundle with a delivering camera, against 080's and 075's figures; a native round of the Studio (Live preview, recording, the preview's picture and meters).
- [ ] Record the outcome: [decisions](../docs/system-design/decisions.md) (the camera's CPU budget row), [desktop](../docs/system-design/desktop.md#recording-studio), [tooling](../docs/system-design/tooling.md#cpu-budget), the verification record and the learning article on a camera overlay; each with its translation.

## Completion and verification boundaries

Complete when D2's gate is met, or the remaining share is measured and explained and the maintainer accepts it. Renderer and main changes follow [the testing policy](../docs/testing.md#select-tests-from-behavior), taking the CPU row and the Studio's page tests; desktop rounds follow the [readiness handoff](../docs/testing.md#confirm-desktop-handoff-before-testing). Writing this plan needs only links, English/Chinese parity and `git diff --check`.
