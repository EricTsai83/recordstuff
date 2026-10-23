# 095 — The Studio's stage as large as the window allows

[English](095-studio-stage-size.md) | [繁體中文](095-studio-stage-size.zh-TW.md)

Status: planned; not started. Created: 2026-10-23 at the maintainer's request, during 092's after-round. Hard dependencies: 092 (its Preview panel and the Studio rows every Studio figure is measured against). After 092 and ahead of 094, so 094's Camera view is drawn on the final stage. Execute in order under the [plan index](README.md). This task writes the plan only; none of the behavior below has been implemented or verified.

## Goal and current state

The Recording Studio's stage, the preview of the display the recording captures, is drawn at the recorded display's shape inside a grey box (`.camera-preview`, padding 14 × 16 px on `--muted`) at most `max(200px, 100dvh − 420px)` tall (`.studio-stage .camera-preview-stage`, [ui.css](../src/renderer/ui.css)). On a 1043 × 758 window it is about 391 × 220 CSS pixels on a landscape display, with grey on both sides and above and below it: most of the window's width is not used, while the panels under it (Preview, Camera, Audio) take a fixed share of the height. The maintainer wants the picture as large as it can be at its own shape.

## Requirements (maintainer, 2026-10-23)

- **R1 — the largest picture at its shape (contain).** At every window size and zoom the stage is as large as it can be at the recorded display's aspect ratio without exceeding its container in either dimension: its width is the container's width unless that would make it taller than the container, in which case its height is the container's height and its width follows from the ratio. This holds for a landscape and a portrait display alike; which side meets the container depends on the container's shape and the display's, not on the display's orientation alone (the maintainer, 2026-10-23). The grey box stays only in the space the ratio leaves on the other axis; it is never padding around a picture that could be larger.
- **R2 — nothing over the picture**, as decided on 2026-10-23 for Live preview, the camera's status and 092's Off overlay: the stage holds only the picture and the bubble's outline to drag.
- **R3 — the bubble stays exact.** Dragging and the arrow keys still place the bubble where the recording composes it at any stage size (the same `bubbleRect` and `positionFromRect`), and the 24 px drag target and the readability floors of plan 067 hold.

## Decisions to take before implementation

- **D1 — how the height is shared.** The stage takes what the window's height leaves after the line of controls and the panels, with a floor below which the page scrolls; or the panels move beside the stage on a wide window. Options are drawn in the background gallery (`pnpm preview:ui`) at the default, narrow, minimum and large sizes, and the maintainer chooses one.
- **D2 — the Studio's layout by use**, proposed on 2026-10-23 and not yet chosen: what must stay in sight while recording (Start or Stop with the elapsed time, the recording's and the camera's state, a small sign that sound comes in), what is pressed often (the mutes, hiding the camera, Live preview, the view), what is adjusted now and then (the faders, the camera's switch) and what is set once (the bubble's size, rounding and mirror, the preview's rate). If adopted, the line of controls carries the frequent actions and a small level per input, and the panels under the stage hold what is set once or adjusted now and then. The maintainer decides whether it is part of this plan or a later one.
- **D3 — the preview's resolution.** 092 kept the stream at 640 pixels wide because the stage was about 391 pixels. A stage two or three times as wide on a Retina display shows 640 pixels upscaled. Measure, before deciding, the Studio's S at Power saving and Standard with `PREVIEW_WIDTH` at 640 and at a larger width (for example 960), and look at both on the signed bundle; a larger stream is adopted only if the maintainer sees the gain and accepts its measured cost over the 092 rows. Otherwise the width stays and this is recorded.

## Steps

- [ ] **Baseline before.** On the current HEAD's signed bundle, `pnpm measure:cpu -- --skip-settings --skip-playback --studio --studio-rate power --fps 60 --repeat 3 --diagnostics` (and Standard), with R in the same round: a larger canvas can cost the page more to draw, so the stage's size is a CPU question as well as a layout one.
- [ ] **Options in the gallery** for D1 (and D2 if it is part of this plan), production pages and CSS only, per the [UI alignment rules](../docs/testing.md#keep-test-ui-aligned-with-the-app); the maintainer chooses.
- [ ] **The stage.** The chosen layout in [studio.tsx](../src/renderer/settings/tabs/studio.tsx), [camera-preview.tsx](../src/renderer/settings/tabs/camera-preview.tsx) and [ui.css](../src/renderer/ui.css): the stage sized by the space it is given and the display's ratio (container queries or a measured size), the grey only as the shape's letterbox. Background UI cases assert behaviour and design-agnostic invariants: at each size and zoom the stage keeps the display's ratio, meets its container on one axis without exceeding it on the other, overflows nothing, and the bubble drags to the same place.
- [ ] **D3** as above, with its measurements and the maintainer's look.
- [ ] **Measure after and document.** The baseline's cases on the fresh signed bundle, back to back; the Studio sections of [desktop](../docs/system-design/desktop.md#recording-studio) and the tooling guide's [pipeline baseline](../docs/system-design/tooling.md#pipeline-baseline) with translations.

## Gates and completion

At every gallery size the stage is the largest rectangle at the display's ratio that fits its container (it meets the container on one axis and does not exceed it on the other), landscape and portrait alike, with nothing laid over it; the bubble is placed where the recording composes it at each size. The Studio's CPU at Power saving and Standard stays within the 092 rows' spread, or a larger cost is the maintainer's measured choice under D3. No recording behavior changes.

## Verification

`pnpm test:scope -- studio layout` (the Studio's cases and the visual matrix) with the gallery's pictures looked at; `pnpm check` if D3 changes the engine's width. A desktop round on a fresh signed bundle after the “好了” handoff: `pnpm acceptance:studio` and the CPU cases above, observed in screenshots on a landscape and a portrait display. Windows by CI only.

## Execution and closure contract

Follow the [plan index](README.md) for order, decision points, desktop handoff and closure. At execution start inspect the current tree and 092's closure record.
