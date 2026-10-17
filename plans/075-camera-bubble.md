# 075 — Camera composited into the recording, arranged in a live preview

[English](075-camera-bubble.md) | [繁體中文](075-camera-bubble.zh-TW.md)

Status: in progress; redesigned on 2026-10-17 at the maintainer's request (the camera is composited by the engine, as OBS does, instead of a bubble window on the screen); step 1's decisions recorded on 2026-10-17; step 2's prototype is built behind a development switch and was measured on 2026-10-17 over D18's budgets; at the maintainer's choice the shared shader in Metal and D17's second option were built and measured the same day: inside D18 but for the preview's own share (10.5 and 8.7 points against 8), which the maintainer accepted; the gate is passed, with the device-change check deferred until a removable camera is at hand. Created: 2026-10-14. Priority: after 078 (closed 2026-10-17, [record](../docs/verification/history-2026-10.md#plan-078-closure--2026-10-17)), whose steps 4 (Windows frames on the GPU) and 6 (macOS devices that come and go) are this plan's base. Hard dependencies: 076's engine, which owns the frames, the clock and the encoder; 078's GPU frames and device findings; 074's permission card and failure pattern ([desktop](../docs/system-design/desktop.md), [recording](../docs/system-design/recording.md)). Execute the steps in order under [the plan index](README.md).

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
- **078 (closed 2026-10-17, [record](../docs/verification/history-2026-10.md#plan-078-closure--2026-10-17)).** Step 4 built Windows hardware H.264 with frames kept on the GPU, which the Windows compositor needs (CI only, no GPU tested). Step 6 moved the microphone to CoreAudio's HAL and found that a device that leaves does not stop its unit: the HAL moves it to another input, so delivery alone cannot tell a loss and the device itself must be checked ([recording](../docs/system-design/recording.md#audio)). For cameras its probe (`probe_cameras_coming_and_going` in `native/capture/src/mac/live_test.rs`, CoreMediaIO's and AVFoundation's lists read once a second without a run loop) saw an iPhone's Continuity Camera listed by both, CoreMediaIO also listing its Desk View camera, but no change in 180 s while the camera was disconnected from the iPhone and chosen again: either a disconnection from the iPhone does not remove it from the lists, or the lists do not update without a run loop. It is settled in this plan's step 2 with a camera that really leaves (a USB camera unplugged), before D12's reconnection is designed.
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

Changed or new, decided by the maintainer on 2026-10-17:

- [x] **D2 Corner style.** A circular-arc rounded rectangle drawn by the compositor, the same formula in the preview; a squircle only as a later option. Basis: one formula drawn in two places must match exactly.
- [x] **D4 Where it is arranged.** In the Settings preview, before and during recording; "Show on screen" is dropped, since nothing is shown on the screen.
- [x] **D5 What the preview shows.** Changed from the recommendation at the maintainer's request, who wants to confirm before recording that the picture and the sound are right, as OBS's preview allows: a **Live preview** button starts a preview session that runs the recording's own pipeline (the chosen display through the same filter, RecordStuff's windows and the hidden menu bar and Dock left out as in the recording, system audio, the microphone and the camera, composed) without writing a file, shown in the preview at preview size and rate (D17), with level meters for system audio and the microphone instead of playing the sound back (no feedback or echo). It stops when the window closes, the tab is left or a recording starts, not when another app is brought forward, so the app to be recorded can be used while watching. Without it the preview shows the display's outline to scale with the menu bar's band and the live camera (no screen capture). While recording it shows the recording session's composed frames. Basis: a preview that is the recording's pipeline checks what the recording will hold; starting it on demand keeps Settings from capturing whenever it is open, which OBS does.
- [x] **D7 During recording.** Placement, size, rounding and mirror change from the preview while recording, taking effect on the next frame, each change logged with the session; the tray's hide and show (D13) remain.
- [x] **D12 Camera lost while recording.** No frames for 2 s is a loss, as for the microphone: the recording goes on without the camera, the notice is told at the end, the saved record marks it; it is taken back if the same session delivers again. Reconnecting a camera that leaves and returns: check the device itself as the microphone does (alive and still the device the session runs on), never delivery alone, and reopen the same unique ID once listed; step 2 settles first whether the lists follow a camera without a run loop.
- [x] **D15 Where the camera is composed.** In the engine, on the GPU, before encoding, by one compute shader for every platform (decided on 2026-10-17 after step 2's first measurement): `native/capture/shaders/compose.wgsl` is the only source of the rounding, the crop and the mirror, and build.rs translates it with naga to Metal's MSL for macOS and Direct3D 11's HLSL for Windows; each platform binds its own textures to it (IOSurface planes through `CVMetalTextureCache` on macOS, 078 step 4's Direct3D 11 frames on Windows) and hands the result to its own encoder. Not wgpu: it would share only the shader, which naga already does, while the textures still cross from each platform's capture and to its encoder, and on Windows wgpu has no Direct3D 11 back end, so every frame would be shared between Direct3D 11 and 12 with fences. Cap uses wgpu because its editor draws a dozen layers (backgrounds, blur, cursor, captions, transitions) in many passes; a scene of that size here, an editor or effects of several passes, is when to move to wgpu, with the shaders already in WGSL. The shader samples by hand instead of with a sampler, which naga's HLSL writes as a Direct3D 12 sampler heap.
- [x] **D16 How the engine captures the camera.** AVFoundation's `AVCaptureVideoDataOutput` in the engine on macOS and Media Foundation's source reader on Windows; 720p at 30 fps by default, the camera's own rate when lower.
- [x] **D17 How the preview reaches Settings.** Changed from the recommendation after comparing how others do it. OBS draws the composed GPU texture into a native view (`obs_display`), with no copy or codec; Cap draws its recording-time camera preview in a native wgpu window (`apps/desktop/src-tauri/src/camera.rs`) and sends its editor's frames to the web view uncompressed, NV12 or RGBA over a local WebSocket (`frame_ws.rs`, read at `f2e13fb`). The gate measures, in this order, stopping at the first that meets D18: (1) frames scaled down on the GPU to NV12 about 640 px wide at 15 fps, read back and sent over a message port straight to the Settings renderer, drawn with WebGL (Cap's editor; no second encoder); (2) a small H.264 stream from the hardware encoder decoded with WebCodecs; (3) a native GPU layer hosted by main (OBS's), last because the engine's surfaces would have to cross into main (Electron's `utilityProcess` passes no Mach ports, so a private `CAContext`/`CALayerHost` or a rendezvous of its own), main would load native code, which 076's D2 keeps out of it, HTML could not be drawn over the preview (handles, tooltips, menus), and Windows needs its own; estimated at four to six times the first option's work. The maintainer chose the most efficient option that fits the budget over the most efficient outright. The first option measured over D18 on 2026-10-17 (12.7 points, 9 of them the renderer and Chromium's GPU process uploading textures), so the second is the one built now.
- [x] **D18 Budgets.** (Step 2's second prototype met them except the preview's own share, 10.5 points at 30 fps and 8.7 at 60 against 8, which the maintainer accepted on 2026-10-17.) Against the reference Mac's 2026-10-16 figures: recording at 30 fps with the camera shown at most 20% of a core (10.4% without), at 60 fps at most 25% (14.0%); the Settings preview open during a recording at most 8 points more across RecordStuff's processes; the live preview before recording (D5) within the same figures as a recording, since it is one without the file; idle unchanged (camera closed). Beyond a budget, step 2 takes the next D17 option or the maintainer accepts the figure.

### 2. Prototype gate (macOS)

- [x] In the engine behind a development switch: open the camera (D16), compose it onto every frame with a rounded mask (D15), encode, and send a preview to a test page (D17). Measure on the reference Mac with `pnpm measure:cpu` (camera shown, preview closed and open, still and moving screen), the composed frames' timing with `pnpm matrix`, and the camera-to-picture offset (a flash shown to the camera against the screen). Compare D17's options until one meets D18 or the maintainer accepts the figures. Record the results before step 3.
- Built on 2026-10-17 and measured the same day (below). The switch `RECORDSTUFF_CAMERA_PROTOTYPE` (`1`, or `width=…,height=…,rounding=…,x=…,y=…,mirror=…,device=…,preview=0`; `native/capture/src/camera_layout.rs`) opens the camera in the engine (`mac/camera.rs`, 1280×720 in 420v, the newest frame kept), composes it before VideoToolbox (`mac/compositor.rs`: at first with Core Image, since the second measurement with the shared shader in Metal, D15), encodes every slot of the frame rate while it is on (`Core::encode_every_slot`), and makes a 640-pixel preview 15 times a second, which the capture host sends over a `MessageChannelMain` port straight to a development page (at first NV12 frames drawn with WebGL; since the second measurement a 1 Mbps H.264 stream from VideoToolbox, decoded with WebCodecs' `VideoDecoder` and drawn into a canvas) (`src/main/recording/camera-preview.ts`, `src/renderer/camera-preview/`). The bundle carries `NSCameraUsageDescription` and `com.apple.security.device.camera`, and main asks for camera access at launch while the switch is on. `pnpm measure:cpu -- --camera <value> --skip-settings --skip-playback` measures A and R with it; `cargo test --lib -- --ignored --nocapture camera_delivers_without_a_run_loop` checks that the camera delivers without a run loop. The live preview before recording (D5) is not built: a prepared session already makes preview frames during the countdown, and its cost is bounded by R's.
- **Measured on 2026-10-17** (reference M1 Pro, lid closed with an external 1920×1080 display as the main one, `pnpm measure:cpu -- --minutes 1 --camera …`, one run each, reports under `docs/verification/measurements/2026-10-17T16*-camera-cpu-*`, gitignored). The camera was the iPhone's Continuity Camera: the built-in FaceTime HD camera opens and reports running with the lid closed but delivers nothing (its sensor powers off after 4 s), which first looked like a run-loop problem and was not (the same code delivered from the iPhone in the capture process and in plain Node, with no run loop or main-queue pumping). The camera delivered about 1,780 frames in each 60-second take (29.7 a second) and dropped none; the files were 30.02 and 60.01 fps with audio and video starting together, and the bubble lands where the layout says (a frame read back at 30 s).
  | Recording | CPU, app and helpers | Capture process | GPU process | Preview renderer | Encoder service | Budget (D18) |
  | --- | --- | --- | --- | --- | --- | --- |
  | 30 fps, camera, no preview | 20.9% | 20.8% | — | — | 2.1% | 20% |
  | 30 fps, camera and preview page | 33.6% / 33.3% | 24.2% | 5.5% | 3.6% | 1.9% | 28% |
  | 60 fps, camera and preview page | 43.2% | 34.0% | 5.6% | 3.4% | 3.1% | 33% |

  Against 10.4% / 14.0% without the camera, composing with Core Image and encoding every slot adds about 10 points at 30 fps, and the preview (D17's first option: NV12 read back, sent over the port, drawn with WebGL) about 12.7 points, of which the renderer and Chromium's GPU process are 9. Both are over D18: the composing by about a point at 30 fps, the preview by about 5 points. Under D18's rule the maintainer chose on 2026-10-17 the shared shader in Metal in place of the graph Core Image builds per frame (D15), and D17's second option for the preview (a small H.264 stream decoded with WebCodecs, a hardware decode in place of the texture uploads); both were built and measured the same day (below). Not yet measured: the frame timing with `pnpm matrix`, the camera-to-picture offset, 60 fps without the preview, the built-in camera with the lid open, and a camera that really leaves: no removable camera was at hand, so the maintainer deferred the device-change check below on 2026-10-17 until one is.
- **Measured again on 2026-10-17** with the second prototype (the shared shader in Metal, D15; the preview as a 1 Mbps Constrained Baseline H.264 stream decoded with WebCodecs, D17's second option), same Mac, camera and runner, reports under `docs/verification/measurements/2026-10-17T18*-metal-cpu-*`:
  | Recording | CPU, app and helpers | Capture process | GPU process | Preview renderer | Encoder service | Budget (D18) |
  | --- | --- | --- | --- | --- | --- | --- |
  | 30 fps, camera, no preview | 14.7% / 13.8% | 14.6% | — | — | 2.6% | 20% |
  | 60 fps, camera, no preview | 21.2% | — | — | — | 3.9% | 25% |
  | 30 fps, camera and preview, hardware decoding | 24.8% | 15.7% | 5.4% | 3.2% | 2.9% | 28% |
  | 30 fps, camera and preview, software decoding | 24.3% | 13.6% | 3.7% | 5.4% | 2.5% | 28% |
  | 60 fps, camera and preview, hardware decoding | 29.4% | — | — | — | 4.3% | 33% |
  | 60 fps, camera and preview, software decoding | 29.9% | 19.9% | 4.0% | 5.5% | 4.1% | 33% |

  Composing in Metal costs about 4 points at 30 fps and 7 at 60 against no camera (Core Image: 10), inside D18 at both rates. The recording with the preview is inside its budget at both rates, but the preview's own share is 10.5 points at 30 fps and 8.7 at 60, against D18's 8: over by 2.5 and 0.7 points, nearly all of it Chromium's GPU process and the page's renderer (9 points), whichever decodes. Chromium's hardware decoder held about six frames back (397 ms behind the capture process at 15 fps, with `optimizeForLatency` and a Constrained Baseline stream); software decoding shows each frame about 2.5 ms after the capture process sent it, for the same processor time, so the page decodes in software. The files were 30.00–30.03 and 59.97–60.03 fps with audio and video starting together, the camera delivered 1,766–1,795 frames a minute and dropped none, the bubble and its colours look right in a frame read back, and the page drew every chunk it got (238 of 238 in 15 s). D18's rule left the preview's 0.7–2.5 points to the maintainer, who accepted them on 2026-10-17: the recording with the preview stays inside its budget at both rates, and the preview runs only while Settings shows it. D17's third option, a native layer, is not pursued.
- [ ] Device changes (from 078): run `probe_cameras_coming_and_going` while a USB camera is unplugged and plugged back, to learn whether CoreMediaIO's and AVFoundation's lists follow it without a run loop; then check that an open session's device is still the one it runs on, as the microphone does, and record how D12 reopens it.

### 3. Layout model and settings (shared, pure)

- [x] `src/shared/camera-layout.ts`: the stored settings (width, height, rounding, mirror, device, per-display position as a fraction), defaults, validation, and the pure functions both the preview and the engine's parameters come from: the bubble's rectangle in display and in output pixels, the radius, snapping, clamping after a display or resolution change. Built on 2026-10-17: the device is a separate setting (`cameraDevice`, as the microphone's); the position is a fraction of the free space, kept per display (by display id, `primary` for the primary display, at most 16), so a display or resolution change needs no clamping; `positionFromRect` turns a drag back into a position, `snapPosition` snaps near the edges and the centre, `applyRatio` keeps the width and matches the height unless the range forbids it.
- [x] Unit tests: shapes at rounding 0, 50 and 100; ratio buttons; bounds on small and large displays and scale factors; the preview's and the engine's rectangles agree for every resolution cap; invalid stored values fall back. The engine's formula is checked by the same 180 cases (`src/shared/camera-layout.cases.json`, read by `camera-layout.test.ts` and `camera_layout.rs`), a position on half a pixel included.
- [x] `src/main/settings/settings.ts`: the camera fields, with the existing `field` pattern: `cameraLayout` (`setCameraLayout` for the shape, `setCameraPosition` per display) and `cameraDevice`; a file without them reads as the defaults, silently.

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
- [ ] Before recording: the display to scale with the live camera (`getUserMedia`, only while visible, D6), and the Live preview button (D5) starting a preview session in the engine with the level meters, stopped when the window closes, the tab is left or a recording starts. While recording: the engine's preview (D17), only while visible; dragging and the controls send layout messages.
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
