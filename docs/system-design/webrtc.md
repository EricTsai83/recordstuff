# Why Recording Left Chromium's WebRTC Capture

[English](webrtc.md) | [繁體中文](../zh-TW/system-design/webrtc.md)

Updated: 2026-10-16.

This is a design record. Until 2026-10-16 RecordStuff recorded through Chromium's media stack in a hidden renderer; plan 076 replaced it with a native capture engine, a Rust module in an Electron `utilityProcess`, and removed the Chromium path (commit `644f94f3`). This document records what that stack gave, what it cost, how each cost was measured or resolved, and what the native engine trades for it. How recording works now is in [architecture](architecture.md) and the [recording pipeline](recording.md); the accepted tradeoffs are in [design decisions](decisions.md).

## What the Chromium path was

A hidden, sandboxed renderer called `getDisplayMedia`; main's display-media handler answered with the chosen screen and `audio: "loopback"`. `MediaRecorder` encoded the tracks as fragmented MP4 (H.264 and AAC at a 256 kbps request) and handed one chunk a second over a `MessagePort` to main, whose `FileWriter` appended, synced every 5 seconds and made the file plain MP4 at save.

None of this was WebRTC communication: there was no `RTCPeerConnection`, signaling, ICE/STUN/TURN or upload, and the `MessagePort` was local IPC. WebRTC mattered because Chromium can apply its native Audio Processing Module (echo cancellation, noise suppression, automatic gain control, built for voice calls) in capture paths, including display capture with no network involved ([Chromium's processing layout](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/mediastream/media_stream_audio_processing_layout.cc)).

## What it gave

- **No native code.** One language, no compiler toolchain beyond Node, and nothing to sign besides the app. This is why the first design chose it: avoid custom audio devices and native sidecars.
- **Platform capture and hardware encoding for free.** Chromium 152 already captured the screen through ScreenCaptureKit on macOS and encoded H.264 in hardware; QuickTime played the result.
- **The same code on both platforms**, as far as Electron's portability goes.

## What it cost, and how each cost was settled

| Limit | What it meant | How it was measured or resolved |
| --- | --- | --- |
| One display or one window | `getDisplayMedia` could leave out only this app's protected windows (an Electron patch to Chromium). It could not hide the menu bar or Dock, record an area or chosen apps, or one app's sound; on macOS each needs ScreenCaptureKit's `SCContentFilter`, which no Electron or Chromium API exposes. These were the maintainer's requests on 2026-10-14 and the measured limitation the decisions required before going native | The engine filters content itself. Hide menu bar and Dock is a switch in Settings → Recording (macOS; the engine reported 35 system windows hidden and the menu bar's place showed the wallpaper). A window, an area and one app's sound pass live tests on macOS and in CI on Windows, and chosen apps' windows on macOS only (Windows.Graphics.Capture cannot record them, so the engine refuses them there); the pickers are a later plan |
| RecordStuff's own windows | With no per-window exclusion, the countdown overlay had to leave 300 ms before capture, and any RecordStuff window on the recorded display was recorded | ScreenCaptureKit's application filter leaves the whole app out, including windows opened after the start; Windows marks them `WDA_EXCLUDEFROMCAPTURE`. On macOS, Settings opened during a recording was on screen and absent from the recording's frame (2026-10-16) |
| Voice processing on system audio | Speech-oriented processing changed the high-frequency balance and collapsed stereo of a mixed system-audio signal; the app had to request `echoCancellation`, `noiseSuppression` and `autoGainControl` false, which are requests a runtime may not honor | Disabling the three restored the probes on 2026-09-14 ([audio quality §15](audio-quality.md#15-system-capture-correction--2026-09-14)). The engine encodes the samples ScreenCaptureKit or WASAPI loopback deliver, with no voice processing in the path ([§16](audio-quality.md#16-the-native-audio-path--why-it-preserves-fidelity)); `pnpm audio:quality` passed every check with both engines, clock −0.07 ppm natively against −1.45 ppm |
| The frame-rate floor | Chromium turned the requested rate into ScreenCaptureKit's minimum frame interval, a floor rather than a period, so asking for 30 or 60 recorded about 29.4 or 57.5 fps. The renderer asked for 30.3 and 62.5 to record the setting | The engine asks ScreenCaptureKit for a quarter of the frame interval and paces frames on a grid by display time. 30 fps dropped no frames and 60 fps 0.06–0.22% in step 2; at the closing rounds 0.22–0.44% of frames were 50 ms apart, against none through Chromium, cause not found (plan 078) |
| Chunk handoff to main | Transferring the `ArrayBuffer` hung main in an Electron 44 probe, so every second's media was copied with no bounded backpressure; a stalled main event loop delayed writing; MP4's index and other containers' cues need to seek back, which a chunk stream cannot do cleanly; low-motion Retina recordings missed the first-chunk deadline until the key-frame interval was aligned with the timeslice | The engine writes the file itself (076's D3): fragmented while recording, plain at save, reporting bytes written and write errors. Stop and file completion are separate messages, so a slow volume's save is no part of the stop |
| Renderer pre-warm and audio service | The display-media handler used the default session at launch, so Electron 44 pre-warmed a renderer (about 65 MB) that the first capture took; the first system-audio capture started Chromium's audio service, kept until quit (about 49 MB, 0.3 wake-ups per second) | Neither exists natively: no renderer before the first window, and after a recording only main, GPU and network service remain. Idle after a recording measured 0.036% of a core against 0.054% through Chromium. The capture process is not started ahead of time either (about 50 ms not worth about 73 MB, maintainer 2026-10-15) |
| Reported values | `getSettings` once reported 1080×606 for a 1080p display, so the renderer measured frames from a muted video; codec and timestamp control was limited to what `MediaRecorder` offered | The engine probes the source size, sets the encoders' properties (a key frame at least every second, bit rates) and stamps audio from sample counts on one monotonic clock |

### Measured against Chromium

On the M1 Pro, 60 Hz 1920×1080 display, signed bundle, 2026-10-14 to 2026-10-16 (plan 076):

| Measure | Native engine | Chromium |
| --- | --- | --- |
| Recording CPU, 30 fps (`pnpm measure:cpu`) | 10.4% of a core | 15.3% |
| Recording CPU, 60 fps | 14.0% | 23.3% |
| Flash-to-beep offset (`pnpm matrix -- quick`) | −25 ms | +68 to +74 ms |
| Audio and picture length difference | 0 ms, including 10 minutes | +13 to +15 ms |
| 10-minute drift | 0 ms, 600 of 600 flash–beep pairs | — |
| Audio fidelity (`pnpm audio:quality`) | every check passed | every check passed |
| Frames 50 ms apart | 0.22–0.44% | 0% |
| Shortcut to `prepared` | 457–535 ms | 347–369 ms |

The maintainer accepted these results, the frame gaps and the slower start included, on 2026-10-16, and the Chromium path was removed. Sleep, display removal, permission denial and the Dock with Hide menu bar and Dock are hands-on cases left to [plan 077](../../plans/077-native-hands-on-acceptance.md); the frame gaps and native cadence diagnostics to [plan 078](../../plans/078-native-capture-follow-ups.md).

## What the native engine trades for it

- **A Rust toolchain.** Contributors who record need rustup's stable toolchain, and on Windows the Visual Studio C++ build tools; both CI runners build the crate and run `cargo test`. Work that never records can build with `RECORDSTUFF_SKIP_NATIVE=1`.
- **Signing a `.node`.** The module is unpacked from the asar archive and signed with the app's certificate and hardened runtime; `start-app.mjs --verify-app` refuses a bundle without it. The development Electron's `utilityProcess` is refused capture (`-3801`), so recordings and measurements need the signed bundle.
- **Platform code twice.** `native/capture/src/mac/` and `src/win/` share the session state machine, pacing, mixer and muxer, but capture and encoding are written for each platform. Windows is verified by CI only: real capture quality, frame timing, own windows absent, system audio content, CPU and the microphone are untested there.
- **Bindings lag.** The `objc2` and `windows` crates may lag a new Apple or Microsoft API; Swift on macOS remains the alternative if one is needed for long.
- **Code that Chromium used to own.** The ISO BMFF muxer, the encoders' settings and the clock are now this project's to keep correct, and Media Foundation's AAC encoder takes at most 192 kbps, below the 256 kbps request.

## What carries over

- **Requests are not results.** What the code asks for, what the runtime reports and what survives into the decoded file remain three kinds of evidence of different strength; [audio quality](audio-quality.md) measures the decoded output for that reason.
- **The microphone is mixed raw** (plan 074, decided 2026-10-16). The optional microphone joins system audio at unity gain with no echo cancellation, noise suppression or automatic gain: macOS's voice-processing I/O can duck other apps' output, so it would lower the system audio the recording exists to keep, and the system-audio track must never inherit speech-oriented processing. On Windows the microphone stream also opts out of the ducking Windows may apply when a microphone opens (`SetDuckingPreference`). Where two loud inputs together pass −1 dBFS a soft limit keeps the sum below full scale; otherwise the sum is exact. Headphones keep loudspeaker sound from being recorded twice; the [measurements](audio-quality.md#18-microphone-results--2026-10-16), taken before the soft limit and the other engine changes that followed the comparison against OBS, Chromium and Cap, found the system part's format and level unchanged and no ducking; fidelity has not been measured again on the changed engine, where the mono microphone and a microphone-on acceptance pass were verified.
- **No transport.** The recording path has no signaling service, peer transport, STUN/TURN dependency or cloud upload. Adding live sharing would be a separate architecture with its own decisions about signaling, connectivity, authentication and media privacy.

## Code map

- [Native capture host](../../src/main/recording/native-capture-host.ts) and [its process](../../src/main/recording/native-host-process.ts): main's supervisor and the `utilityProcess` that loads the engine.
- [Capture engine](../../native/capture/): the Rust crate, with the shared core, the platform modules and the muxer.
- [Shared protocol](../../src/shared/protocol.ts): the messages between main and the capture process.
- [Quality policy](../../src/shared/quality.ts): requested encoding quality.
- [Audio-quality testing](audio-quality.md): measured fidelity, limitations and regression strategy.
