# 092 — The Studio preview's rate choice and its view

[English](092-studio-preview-rate-and-view.md) | [繁體中文](092-studio-preview-rate-and-view.zh-TW.md)

Status: planned; not started; its place in the order is not decided. Created: 2026-10-23 at the maintainer's request. Hard dependencies: none (it changes the same Studio port 084 audits; which comes first is decided with the order). Execute in order under the [plan index](README.md). This task writes the plan only; none of the behavior below has been implemented or verified.

## Goal and current state

The Recording Studio's preview is one H.264 stream of the composed picture, 640 pixels wide (`PREVIEW_WIDTH`, [camera_layout.rs](../native/capture/src/camera_layout.rs)) at 1 Mbps, shown at 10 fps while someone works in the Studio and 5 while it is only looked at ([studio-pace.ts](../src/renderer/settings/tabs/studio-pace.ts), plan 081's D1). "Works in" is the pointer over the window or a key, click or scroll within 3 s, not window focus. The maintainer finds the 5 fps rate slow and wants the rate to be the user's choice; the user also cannot see the screen or the camera alone, only the composed picture.

The width of 640 is the stream's resolution, not the size on the page: the stage is at most 220 CSS pixels tall at the display's shape (about 391 × 220 at 16:9, [ui.css](../src/renderer/ui.css)), and stays that size whatever is chosen here. Neither the preview's resolution nor the camera's capture size (1280 × 720 on both platforms) becomes a setting: at this stage size a larger preview is not seen, and a different camera size brings no performance gain (maintainer, 2026-10-23).

## Decisions (maintainer, 2026-10-23)

- **D1 — a preview rate choice** in the Studio, above the stage: **Power saving** (5 fps while only looked at, 10 while someone works in it, today's behavior under a name that says what it does), **Standard** (10 fps always, the default), **Smooth** (15 fps always) and **Off** (no preview is composed, encoded or drawn). Each option carries a one-line description; with Power saving chosen, a small label in the stage's corner shows the rate in use and why (for example `10 fps · working` / `5 fps · saving`). Off keeps the stage's frame and shape with "Preview is off" and a button that turns it back on; the bubble's outline still drags and the meters still run (their subscription is separate).
- **D2 — Smooth's cost is accepted over D18.** 083 measured the Studio at 7.3 points over a recording at 5 fps and 11.2 at 10 (30 fps recording, [pipeline baseline](../docs/system-design/tooling.md#pipeline-baseline)); 15 fps is estimated at about 15 and must be measured. Standard as the default also exceeds D18's 8 points while the Studio is only looked at; the closure records the new figures and updates the budget's text in [decisions](../docs/system-design/decisions.md).
- **D3 — a view choice: Composed / Screen / Camera**, as segments beside the rate. The stage keeps its size and the recording's shape in every view. Screen draws the screen without the camera; the outline still drags. Camera draws the camera alone, enlarged to the largest rectangle that fits in the stage, centred, with the bubble's own width-to-height ratio and rounding as the recording composes it; the outline is hidden. Only the preview changes: the recording is always the composed picture.

## Steps and ownership

- [ ] **The rate on the engine side.** The preview thread ticks at 30 a second instead of `PREVIEW_FPS`, so 5, 10 and 15 divide it, and `preview_tick_shows` follows; the encoder's configured rate and the 1 Mbps bit rate are checked at 15 fps. The port's `rate` message (`isStudioRate`, [studio-port.ts](../src/shared/studio-port.ts)) accepts the rates of D1; Off is the page no longer watching the preview (the path used when the stage leaves sight), not a rate of 0. macOS and Windows sessions both.
- [ ] **The rate on the page side.** A setting in main's Studio model ([model/studio.ts](../src/main/settings/model/studio.ts)), persisted, English and Traditional Chinese in i18n. `paceStudio` runs only under Power saving; the other choices send one fixed rate; the corner label reads what `paceStudio` shows. Unit tests for the choice, the persistence and the pacing per option.
- [ ] **The view on the engine side.** A `view` message on the Studio's port; the compositor's preview render takes the view: Screen is today's path with the camera hidden (D13), Camera is a new parameter set in `camera_layout.rs` (the bubble's crop at the largest centred size in the output, the screen not drawn, the surround in the stage's background). A change of view forces a key frame. The recording's `compose` is untouched. Rust tests for the parameters on both platforms' compositors.
- [ ] **The view on the page side.** The segments, the outline hidden in Camera, and the cases without a picture: before recording, Camera enlarges the page's own camera (`getUserMedia`) with the same ratio and rounding, and Screen says it appears with Live preview; a lost or hidden camera shows a placeholder naming why. Production components and CSS only, per the [UI alignment rules](../docs/testing.md#keep-test-ui-aligned-with-the-app).
- [ ] **Measure and document.** `measure:cpu` with the Studio watched at each rate and Off, and with someone working in it under Power saving; a recording with the camera switched between views, its file checked to be the composed picture. Update the Studio's sections in [recording](../docs/system-design/recording.md), [decisions](../docs/system-design/decisions.md) and the [tooling](../docs/system-design/tooling.md) budget, with translations.

## Gates and completion

Each rate shows the chosen number of frames a second, measured from the page's drawn count; Power saving goes to 10 within one tick of work and back to 5 after 3 s; Off composes, encodes and draws nothing while the meters continue. Each view shows what D3 says, the Camera view's ratio and rounding matching the composed bubble, and switching views never changes the recorded file. The measured costs are recorded with D2's acceptance; a rate or view change never fails or stalls a recording.

## Verification

Focused tests per step (`pnpm test:scope` for the Studio and settings scopes, Rust tests for the tick and parameters); `pnpm check` for the port and engine change. A desktop round on a fresh signed bundle after the “好了” handoff: `pnpm acceptance:studio`, the CPU cases of the last step, a recording with the camera verified with `pnpm verify`, and the Camera view's shape observed by eye. Windows by CI only.

## Execution and closure contract

Follow the [plan index](README.md) for order, decision points, desktop handoff and closure; preserve capture-process fault isolation and that a preview failure never fails a recording. At execution start inspect the current tree and the closure records of whatever plans ran before it (084 in particular, if it changed the port).
