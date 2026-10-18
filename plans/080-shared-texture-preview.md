# 080 — The Studio's preview as a shared GPU texture on macOS

[English](080-shared-texture-preview.md) | [繁體中文](080-shared-texture-preview.zh-TW.md)

Status: planned; not started. Created: 2026-10-18, from 075's step 8 measurements; the design below was accepted by the maintainer on 2026-10-18 ("接受這個設計"), to be executed later. Priority: the maintainer orders it; after 075, one plan at a time. Hard dependencies: 075's preview and Recording Studio (in progress), and 076's D2, which this plan amends ([decisions](../docs/system-design/decisions.md)). Execute the steps in order under [the plan index](README.md).

## Goal and boundaries

Show the Recording Studio's preview on macOS without encoding and decoding it. Today the engine composes a 640-pixel preview, encodes it with VideoToolbox, sends it over a `MessagePort` and the Studio decodes it with WebCodecs and draws it. Instead, the compositor's preview texture, an IOSurface, would reach main as a Mach port. A small native module in main would turn the port back into an IOSurface, and Electron's experimental `sharedTexture` module would hand it to the Studio as a `VideoFrame` without a copy. Success is: the Studio's share over a recording without it falls measurably (step 2's gate), main's event loop is never held by the module, and any failure falls back to today's encoded preview without touching the recording.

Out of scope: Windows, which keeps the encoded preview (a Direct3D 11 shared handle can be duplicated into main without a native module, a later option); the recording's path, which is unchanged; the camera's picture before a Live preview (`getUserMedia`, unchanged); a larger or faster preview, to be decided only after step 2's measurement.

## Current state

- **The preview's cost.** On the reference M1 Pro with D21's 10 fps, a recording with the Studio showing it (S) used 24.5% at 30 fps against 15.5% without (R), 8.9 points over, and 30.7% against 19.4% at 60 fps, 11.3 points over; D18 allowed 8, and D21 accepted the excess ([075 step 8](075-camera-bubble.md#8-measurement)). The share covers the preview's encoder, its messages, WebCodecs' decoder and the Studio's drawing; how it divides is not measured.
- **Where native code runs.** Only in the capture `utilityProcess` (076's D2): a native crash ends that child, and main keeps the partial file and reports the failure. Electron's `sharedTexture.importSharedTexture` exists only in main and takes an IOSurface pointer of main's own, so on macOS main must call native code to obtain it. This is the exception D2 has to make.
- **Two paths to the screen.** The recording is composed natively and the preview goes through Chromium's codecs; the second path is what this plan removes on macOS.

## How others do it

- [ghostty-xterm-bench](https://github.com/mxschmitt/ghostty-xterm-bench) (MIT, research-grade, unpublished): a terminal renders in a `utilityProcess`, sends each IOSurface as a Mach send right (`IOSurfaceCreateMachPort`) through a channel its N-API module builds in main (`bootstrap_register`), and main calls `IOSurfaceLookupFromMachPort`, `importSharedTexture` and sends the `VideoFrame` to a sandboxed page. The engine sends the Mach message before its JavaScript "frame" message, one frame in flight, so main's receive finds it queued (`packages/electron-ghostty/src/addon.c`). Read for its shape; any code taken keeps its MIT notice.
- Chromium's [Mach port rendezvous](https://chromium.googlesource.com/chromium/src.git/+/main/base/apple/mach_port_rendezvous_mac.cc): the browser process checks in a name built from the bundle id and its process id (`bootstrap_check_in`) and, in newer versions, validates the peer process before handing it ports.
- Electron's [shared texture design notes](https://github.com/electron/electron/blob/v44.7.0/shell/common/api/shared_texture/README.md) and `spec/api-shared-texture.spec.ts`: on macOS an IOSurface reaches another process as a Mach port over an IPC made beforehand; the imported texture is kept until all its references are released.
- OBS and Cap draw the composed texture into a native view, which Electron cannot host in a web page; `sharedTexture` is Electron's way to the same zero-copy display.

## Design (accepted on 2026-10-18)

- **A1 Loaded only when needed.** Main loads the module the first time the Studio watches a preview on macOS, never at launch or on Windows. A loaded module cannot be unloaded, so it stays in memory afterwards, but none of its code runs unless a preview is watched.
- **A2 Minimal.** The module does three things: make the channel, receive one surface, release a surface. No capture or drawing logic; everything else stays in the engine and in TypeScript.
- **A3 Never waits.** The engine sends the Mach message before it posts the frame's message over the existing port, and sends the next one only after the Studio has let the last go (one frame in flight). Main's receive uses a zero timeout: if nothing is queued, that frame is skipped. No thread of the module's own is needed.
- **A4 The channel.** Main checks in a name of the bundle id, its process id and a random part (`bootstrap_check_in`, as Chromium does), confirmed on the signed bundle in step 2; `bootstrap_register`, deprecated but used by ghostty, only if check-in is refused, with the reason recorded. Each received message's audit trailer must name the capture process of the watched session; anything else is dropped and logged.
- **A5 Lifetimes.** Each received surface has one owner in main, released only after Electron reports all its references released; the engine's preview textures are not reused while their port or an import holds them.
- **A6 Falls back.** If the module fails to load, the channel cannot be made, or receiving fails, that session's preview falls back to today's encoded stream, logged once; the recording is never affected.
- **A7 Format.** The compositor's preview is NV12, which `importSharedTexture` accepts (`nv12`); BGRA from the same kernel only if Chromium shows NV12 wrongly.

## Steps

### 1. Decide the remaining points

- [ ] **D1 The module's language.** Recommended: Rust with napi-rs in a crate of its own (`native/preview-receiver`), the toolchain the engine already uses, as a separate `.node` so main never loads the capture module. Alternative: C as ghostty, built with node-gyp, a second toolchain.
- [ ] **D2 The gate.** Recommended: keep the work only if S's share over R falls by at least 2 points at 30 fps on the reference Mac, with main's event-loop delay p99 during a preview no more than 2 ms above today's; otherwise record the result and close the plan with the encoded preview kept.
- [ ] **D3 076's D2.** The amended wording: capture stays in a `utilityProcess`; main may load one module that only receives preview surfaces, while the Studio watches, with a fallback.

### 2. Prototype gate (macOS, behind a development switch)

- [ ] The engine exports each preview texture as a Mach port and sends it before the frame's message; the module (D1) makes the channel and receives; main imports and sends the frame to the Studio; the Studio draws the `VideoFrame` and closes it; the release flows back to the engine.
- [ ] Confirm on the signed bundle: `bootstrap_check_in` with a dynamic name (A4), the audit trailer's process id, and NV12 shown correctly (A7).
- [ ] Measure with `pnpm measure:cpu` (S and L at 30 and 60 fps, against today's figures) and main's event-loop delay during a preview. The maintainer decides by D2.

### 3. Build

- [ ] Fallback (A6), lazy loading (A1), the peer check (A4) and lifetimes (A5) as designed; the development switch removed.
- [ ] Packaging: the module built for arm64 and x64, unpacked from the archive, signed with the app; `codesign` and a launch of the packaged app checked.
- [ ] Tests: Rust tests for the zero-timeout receive and a rejected peer (a port sent to the test's own process); TypeScript tests for falling back and for the module never loaded on Windows or without a watched preview; the Studio's page tests unchanged.

### 4. Verify and document

- [ ] `pnpm check`. A native round on the signed bundle: Live preview and a recording with the Studio open; the capture process killed during a preview, with main and the menu bar still running and the preview falling back or ending; the Studio opened and closed 50 times with no growth in main's memory or IOSurface count; sleep and a display change during a preview. CPU with `pnpm measure:cpu`. Windows by CI.
- [ ] Record the outcome: [decisions](../docs/system-design/decisions.md) (D2's exception, D3), [desktop](../docs/system-design/desktop.md) (the preview's path), [recording](../docs/system-design/recording.md) (the exported textures), [tooling](../docs/system-design/tooling.md) (the module's build and signing), the verification record, and the learning article on a camera overlay if it is written by then; each with its translation.

## Completion and verification boundaries

Complete when step 2's gate has been decided and, if kept, steps 3 and 4 are done, or the result is recorded and the plan closed with the encoded preview kept. Engine, main and packaging changes follow [the testing policy](../docs/testing.md#select-tests-from-behavior), taking the recording row, the CPU row and the packaging checks; desktop rounds follow the [readiness handoff](../docs/testing.md#confirm-desktop-handoff-before-testing). Writing this plan needs only links, English/Chinese parity and `git diff --check`.
