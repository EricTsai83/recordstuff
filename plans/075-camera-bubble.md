# 075 — Camera composited into the recording, arranged in a live preview

[English](075-camera-bubble.md) | [繁體中文](075-camera-bubble.zh-TW.md)

Status: planned; redesigned on 2026-10-17 at the maintainer's request (the camera is composited by the engine, as OBS does, instead of a bubble window on the screen); step 1's new decisions and step 2's prototype gate come first, implementation not started. Created: 2026-10-14. Priority: after [078](078-native-capture-follow-ups.md), whose steps 4 (Windows frames on the GPU) and 6 (macOS devices that come and go) are this plan's base. Hard dependencies: 076's engine, which owns the frames, the clock and the encoder; 078; 074's permission card and failure pattern ([desktop](../docs/system-design/desktop.md), [recording](../docs/system-design/recording.md)). Execute the steps in order under [the plan index](README.md).

## Goal and boundaries

Let the user put their own camera into a recording as a bubble whose width, height, corner rounding, position and mirror they set freely, and change while recording, in a preview in Settings that shows the composed recording. The bubble is drawn into the recorded frames by the engine, not shown as a window on the screen: the user's screen stays clear, nothing covers the app below or catches its clicks, and nothing of the bubble's controls can be recorded.

Success is: with the camera on, the saved MP4 holds the camera at the placement, size, rounding and mirror the preview shows, frame-accurate for changes made while recording; before recording the preview shows the chosen display to scale with the live camera in place; while recording it shows the composed recording itself; the tray can hide and show the camera; RecordStuff's own windows stay out as before; with the camera off nothing changes, recordings included; and the costs stay inside the budgets step 2 sets.

Out of scope: a separate camera track or file and editing afterward (Cap Studio, Screen Studio), background blur or removal, camera-only or full-screen camera modes, several cameras, a camera window on the screen, and Windows hardware (CI only).

## The redesign (2026-10-17)

The 2026-10-14 design recorded a bubble window that screen capture picked up (Loom, Cap's Instant mode). Asked why its placement was locked while recording, the maintainer chose OBS's model instead. The window design locked placement because anything drawn on the window is recorded and a movable window must catch the clicks meant for the app below; composing in the engine removes both reasons. It also removes the need to see the bubble on the screen: what it covers is shown in the preview.

None of the products checked records an invisible, fixed bubble: once the camera is composed, OBS shows the result in a preview and Cap Studio and Screen Studio let it be moved afterward. This plan follows OBS, live, because RecordStuff has no editor.

## Is the stack suitable? Performance (assessment)

Yes for the composing; the preview is the one cost specific to Electron and is what step 2 measures first.

Where the work runs today (076, measured on the reference M1 Pro, 2026-10-16): the Rust engine in a `utilityProcess` takes ScreenCaptureKit's frames as `CVImageBuffer`s (GPU memory, IOSurface) straight into VideoToolbox (`native/capture/src/mac/session.rs`, `video.rs`); on Windows frames stay on the GPU through the Direct3D 11 video processor (`win/capture.rs`), except on a device without one (WARP), which converts on the CPU. Recording at 30 / 60 fps costs 10.4% / 14.0% of a core against budgets of 30% / 40% ([CPU budget](../docs/system-design/tooling.md#cpu-budget)), the microphone 3.4 points more (13.3%), the encoder service about 2.7%. Electron draws only the UI.

| Cost the camera adds | Where | Expected size | Why, and the risk |
| --- | --- | --- | --- |
| Camera capture | engine, AVFoundation (`AVCaptureVideoDataOutput`) | small | Frames arrive as IOSurface-backed `CVPixelBuffer`s in the camera's native YUV, no copy; 720p at 30 fps. Device changes are the risk, not cost: AVFoundation's device state needs a main run loop the utility process lacks (074's probe), which 078 step 6 settles for audio and this plan for video (D16) |
| Composing | engine, GPU (Metal or Core Image on macOS, Direct3D 11 on Windows) | small CPU, some GPU | One textured quad with a rounded mask and a flip per frame onto the screen frame, in GPU memory, before the encoder. A 4K frame at 60 fps is well within an integrated GPU; CPU is command encoding only. Risk: a CPU fallback (Windows WARP) would cost a full-frame copy per frame |
| Frames while the screen is still | engine, pacer and encoder | the largest new cost | Today a still screen sends one frame a second; with the camera shown every frame changes, so the encoder runs at the full rate all the time. Hardware encoding keeps it to roughly the moving-screen figures above, not more |
| Preview while recording | engine → Settings renderer | the Electron-specific risk | OBS and Cap draw their previews natively on the GPU (Cap: IOSurface to Metal to wgpu, `apps/desktop/src-tauri/src/camera.rs`); a Chromium page must receive frames. Done naively (raw frames over IPC, a canvas redrawn per frame) this is where CPU goes: plan 072 measured a renderer at 74–77% of a core while its player played a recording, from work around each video frame. Options are D17 |
| Preview before recording | Settings renderer, `getUserMedia` | small | The camera alone at preview size, as a `<video>`; the screen as the existing arrangement outline, so the panel still never captures the screen |
| Memory | engine | tens of MB | Pixel buffer pools for the composed frames and the preview |

The stack itself is not the limit. Tauri would not change the composing (the same native work) and would show a preview through a web view too; Cap avoids that with a native GPU window, which in Electron would mean a native layer hosted by main and fed across processes, the fallback if step 2 shows the web preview too costly. Electron 44's experimental `sharedTexture` module imports an IOSurface or a Direct3D 11 shared handle into a renderer as a `VideoFrame` without a copy, but only from main, so the engine's surfaces would first have to reach main (a Mach port or a shared handle); a low-resolution preview stream decoded with WebCodecs needs no new process plumbing. The prototype gate (step 2) decides between them by measurement, as 076's gate did for the engine.

## Current state

- **076 (closed).** The engine owns capture, the clock, pacing, encoding and writing for the screen, system audio and the microphone. RecordStuff's own windows are left out of every recording (ScreenCaptureKit's application filter; `WDA_EXCLUDEFROMCAPTURE` on Windows), so the Settings preview is never recorded; no exception is needed now, since the bubble is no longer a window. The countdown overlay is the only window RecordStuff shows on the recorded display, and it is gone before capture.
- **074 (closed).** The permission card, the denial notice, refusing a start before the countdown, a device picker with a fallback note, and loss detection by delivery, all reusable. Its follow-up found that AVFoundation in the utility process never sees a device leave or return (no main run loop); 078 step 6 moves the microphone to CoreAudio's HAL.
- **078 (planned).** Step 4 builds Windows hardware H.264 with frames kept on the GPU, which the Windows compositor needs. Step 6 settles device changes on macOS.
- No code captures video from a camera. `electron-builder.yml` lacks `NSCameraUsageDescription`; `resources/entitlements.mac.plist` lacks `com.apple.security.device.camera`.
- Settings → Recording → Screen draws the displays' arrangement without capture (`src/renderer/settings/tabs/display-arrangement.tsx`), which the preview extends.

## How others do it

Read on 2026-10-14 and 2026-10-17: Cap at `3d19c5c` and `d7d36a3` (its AGPL code read for design only), OBS Studio, vendor help pages; they describe the inspected scope, not tested behavior.

| Product | Where the camera is composed | Preview | Change while recording |
| --- | --- | --- | --- |
| OBS Studio | live, in its GPU canvas | the composed canvas, drawn natively | yes, any source |
| Cap Studio, Screen Studio | afterward, in the editor (separate camera track) | a floating camera window, excluded from the screen track | in the editor, after |
| Cap Instant, Loom | not composed: the camera window is on the screen and recorded | the window itself | Cap: anything; Loom: drag |
| Apple Presenter Overlay | by the system, live | the shared screen | drag (small mode) |

The 2026-10-14 table of shapes, sizes and mirroring (Cap's preview 150–600 px, its editor's Corners 0–100 with Squircle or Rounded, Loom's four shapes and "Flip camera", Tella's layouts, Screenity's circle) still grounds D1–D3 and D8 below.

## Steps

### 1. Decide behavior

Kept from 2026-10-14 (the maintainer adopted every recommendation then), as they still apply:

- [x] **D1 Shape.** Width, height and rounding are three independent values; edge and corner handles in the preview plus fields; ratio buttons (1:1, 4:3, 3:4, 16:9); rounding 0–100%, 100% being half the shorter side; default a square at 100%.
- [x] **D3 Size.** Width and height as a fraction of the recorded display's shorter side, 5–60%, default 20% × 20%.
- [x] **D6 When the camera is on.** Only while the preview is visible and from preparation to stop; never while idle.
- [x] **D8 Mirror.** "Mirror in recording", off by default; the preview shows the recording as it will be.
- [x] **D9 Device.** A picker with "System default" first, remembering id and label, falling back to the default with a note.
- [x] **D10 Switch.** A Camera switch in the Recording tab and a checkbox in the tray's idle menu, as 074 did for the microphone.
- [x] **D11 Unavailable at start.** Refuse the start with `camera_unavailable` before any countdown.
- [x] **D13 Hide and show while recording.** A tray item; the camera stays open while hidden. No global shortcut.
- [x] **D14 Own windows.** RecordStuff's windows are left out of every recording (076); the composed camera is not a window, so no exception remains.

Changed or new, to be decided by the maintainer (recommendations given):

- [ ] **D2 Corner style.** Was: CSS `border-radius`, squircle if Chromium supports it. Now the engine draws the mask. Recommended: a circular-arc rounded rectangle in the compositor's shader, the same formula in the preview; a squircle only as a later option. Basis: one formula drawn in two places must match exactly.
- [ ] **D4 Where it is arranged.** Was: in the preview before recording, plus "Show on screen". Recommended: in the Settings preview, before and during recording; "Show on screen" is dropped, since nothing is shown on the screen. Basis: the maintainer's choice of OBS's model.
- [ ] **D5 What the preview shows.** Recommended: before recording, the display's outline to scale with the menu bar's band and the live camera (no screen capture, as today's panel rule requires); while recording, the composed frames from the engine at preview size and rate (D17). Alternative: a live screen preview before recording too, which would capture while idle, need screen permission in the panel and cost CPU whenever Settings is open.
- [ ] **D7 During recording.** Was: locked. Recommended: placement, size, rounding and mirror change from the preview while recording, taking effect on the next frame, each change logged with the session; the tray's hide and show (D13) remain. Basis: the maintainer's request; composing removes the reasons for the lock.
- [ ] **D12 Camera lost while recording.** Recommended: no frames for 2 s is a loss, as for the microphone: the recording goes on without the camera, the notice is told at the end, the saved record marks it; it is taken back if the same session delivers again. Reconnecting a camera that leaves and returns follows whatever 078 step 6 establishes for devices on macOS. Basis: 074's rule and its finding.
- [ ] **D15 Where the camera is composed (new).** Recommended: in the engine, on the GPU, before encoding: Metal (or Core Image) on macOS; Direct3D 11 on Windows on 078 step 4's GPU frames. Alternatives: composing in a Chromium page and capturing that page (round trips through the renderer every frame); a CPU compositor (a full-frame copy each frame). Basis: the frames are already in GPU memory in the engine; OBS composes on the GPU too.
- [ ] **D16 How the engine captures the camera (new).** Recommended: AVFoundation's `AVCaptureVideoDataOutput` in the engine on macOS (it delivers in the utility process, as the microphone did; device changes as D12 says) and Media Foundation's source reader on Windows; 720p at 30 fps by default, the camera's own rate when lower. Alternative: `getUserMedia` in a renderer with frames sent to the engine (Chromium handles devices, at the cost of copying every frame across processes). Basis: frames should stay in GPU memory from camera to encoder.
- [ ] **D17 How the preview reaches Settings (new).** Recommended for the gate: the engine encodes a small preview (for example 640 px wide, 15 fps) with the hardware encoder it already has and sends it over a message port straight to the Settings renderer, which decodes it with WebCodecs into a canvas, only while Settings shows the preview. Alternatives: Electron's experimental `sharedTexture` (no copy, but needs the engine's surfaces passed to main first); still images (JPEG) at a few per second (simplest, coarse); a native GPU layer hosted by main (as Cap and OBS draw, most work). Basis: measure first the option that needs no new process plumbing, and keep the others as fallbacks.
- [ ] **D18 Budgets (new).** Recommended, against the reference Mac's 2026-10-16 figures: recording at 30 fps with the camera shown at most 20% of a core (10.4% without), at 60 fps at most 25% (14.0%); the Settings preview open during a recording at most 8 points more across RecordStuff's processes; idle unchanged (camera closed). Beyond a budget, step 2 picks another D17 option or the maintainer accepts the figure.

### 2. Prototype gate (macOS)

- [ ] In the engine behind a development switch: open the camera (D16), compose it onto every frame with a rounded mask (D15), encode, and send a preview to a test page (D17). Measure on the reference Mac with `pnpm measure:cpu` (camera shown, preview closed and open, still and moving screen), the composed frames' timing with `pnpm matrix`, and the camera-to-picture offset (a flash shown to the camera against the screen). Compare D17's options until one meets D18 or the maintainer accepts the figures. Record the results before step 3.

### 3. Layout model and settings (shared, pure)

- [ ] `src/shared/camera-layout.ts` (proposed): the stored settings (width, height, rounding, mirror, device, per-display position as a fraction), defaults, validation, and the pure functions both the preview and the engine's parameters come from: the bubble's rectangle in display and in output pixels, the radius, snapping, clamping after a display or resolution change.
- [ ] Unit tests: shapes at rounding 0, 50 and 100; ratio buttons; bounds on small and large displays and scale factors; the preview's and the engine's rectangles agree for every resolution cap; invalid stored values fall back.
- [ ] `src/main/settings/settings.ts`: the camera fields, with the existing `field` pattern.

### 4. Permission and packaging

- [ ] `NSCameraUsageDescription` and `com.apple.security.device.camera`; confirm with `codesign -d --entitlements`.
- [ ] Turning the camera on asks `systemPreferences.askForMediaAccess("camera")`; a denial shows on the card with an action opening System Settings → Privacy & Security → Camera; Windows guidance for its privacy setting. As 074.

### 5. Camera capture in the engine

- [ ] macOS and Windows capture per D16, stamped on the host clock the screen uses, at most one frame queued (the latest wins); `camera_unavailable` when it cannot open; loss and return per D12; the camera closes at stop, cancel, failure, sleep and quit, so the camera light turns off.
- [ ] Core tests with a fake camera: the latest frame at each output frame's time, a camera slower or faster than the output rate, loss after 2 s and return, closing on every exit.

### 6. Composing in the engine

- [ ] macOS: compose per D15 onto each frame before VideoToolbox, from the layout parameters main sends; a parameter change applies from the next frame; hidden (D13) composes nothing.
- [ ] Windows: the same on Direct3D 11 frames from 078 step 4's path; without a video processor (WARP) on the CPU path, checked in CI.
- [ ] The pacer encodes at the chosen rate while the camera is shown, and keeps today's still-screen behavior while it is hidden or off.
- [ ] Protocol: a layout message from main to the host, guarded like the others; logged with the session.
- [ ] Tests: the composed rectangle and radius at each resolution cap (pixel checks on synthetic frames), mirror, hide and show, a change during recording landing on the next frame, the camera off leaving frames bit-identical to today's.

### 7. Preview in Settings

- [ ] A Camera group in Settings → Recording: switch and picker (D9, D10), permission status, the preview, Width, Height and Rounding with ratio buttons, Mirror in recording; usable during recording (D7) while the other recording settings stay locked. New strings in `ZH_TW`.
- [ ] Before recording: the display to scale with the live camera (`getUserMedia`, only while visible, D6). While recording: the engine's preview (D17), only while visible; dragging and the controls send layout messages.
- [ ] Page tests: controls and values, drag and keyboard placement saved, editable during recording, denied status, zh-TW, the camera and the preview stopped when the tab is left; accessible names and value text.

### 8. Measurement

- [ ] Recording smoke with the camera on: the saved frames hold the camera at the logged rectangle and radius, matching the preview; a change during recording lands where logged.
- [ ] Hide and show; a cancelled countdown turning the camera light off; own windows absent with Settings and its preview open.
- [ ] CPU per D18 with `pnpm measure:cpu` (camera shown, preview open and closed); frame timing with a `pnpm matrix` subset; the camera-to-picture offset.

### 9. Documentation

- [ ] [Recording](../docs/system-design/recording.md): camera capture, the compositor and its place before the encoder, the pacer with the camera, the layout message, failures; [desktop](../docs/system-design/desktop.md): the preview and permission; [decisions](../docs/system-design/decisions.md): composed in the engine (OBS's model) rather than a recorded window or a separate track; [tooling](../docs/system-design/tooling.md): the measured costs. Mirror each in `docs/zh-TW/`.
- [ ] README, README.zh-TW and the website's help page: mention the camera.
- [ ] Learning articles: write those in [the index's list](README.md#learning-articles-from-074076) whose sources have all closed with this plan.

## Completion and verification boundaries

Complete when step 1's decisions are recorded and step 2's gate passed; the camera is composed, arranged and changed as decided; recordings match the preview; hiding, showing and losing the camera behave as decided; RecordStuff's windows stay out; step 8's results are recorded within D18 or accepted by the maintainer; tests and documentation are updated.

Checks follow [the testing policy](../docs/testing.md#select-tests-from-behavior). This changes the engine's frame path, the protocol, permissions and packaging, so it takes the recording row (`pnpm check`, a recording smoke round with the camera off and on, a cancelled countdown that must turn the camera light off), the CPU row (`pnpm measure:cpu`) and the frame-timing row (a `pnpm matrix` subset); the Settings group takes `pnpm test:scope -- recording-settings`; a tray item takes `pnpm acceptance:tray`. Camera permission prompt and denial need a native round after `tccutil reset Camera com.ericts.record`, following the [desktop handoff](../docs/testing.md#confirm-desktop-handoff-before-testing) and the [native acceptance skill](../.agents/skills/native-acceptance/SKILL.md). Losing the camera needs a removable one (an external webcam or Continuity Camera); without one it is reported as untested. Windows is checked by CI only.

Writing this plan needs only: links and anchors, existing and proposed commands, English/Chinese parity and `git diff --check`; no tests, build or app launch.

At closure, record the design in the system-design documents and the results with their translation in the verification record, update both indexes and remove the plan files under the project's completion rules. Do not commit, push or publish unless the user asks.
