# Design Decisions

[English](decisions.md) | [繁體中文](../zh-TW/system-design/decisions.md)

These are adopted decisions, not a future-work checklist. Current code and measured results supersede assumptions from old execution plans.

| Decision | Rationale | Tradeoff or reconsideration trigger |
| --- | --- | --- |
| Electron and TypeScript | Implement desktop lifecycle, native UI, and Chromium capture with one language | Electron resource cost; consider native capture only after measuring a concrete limitation |
| Bundle identifier is the reverse of a domain the maintainer controls (`com.ericts.record`; [why](signing.md#bundle-identifier)) | Identifiers have no registry, so an owned domain is the only uniqueness guarantee; the identifier is the app's identity for TCC grants, notifications and the signature | Chosen once and kept: changing it makes macOS treat the app as new and users must re-allow screen recording |
| Built-in getDisplayMedia and MediaRecorder | Avoid custom audio devices and native sidecars | Limited codec/timestamp control; explicit EC/NS/AGC false restored local spectral fidelity and stereo, so remeasure on engine/platform changes |
| Hidden capture renderer | DOM media APIs belong in a renderer; visible UI can remain native | Requires port readiness, session IDs, ordering, and heartbeat |
| Main owns state and media writer | UI and capture must not independently claim success | Main coordinates cleanup and file completion |
| H.264/AAC MP4 | Verified QuickTime playback and hardware encoding | Fragmented MP4; no universal repair guarantee or format fallback |
| Native Tray/Menu/Notification | A one-button recorder does not need a UI framework | OS controls notifications and foreground ordering |
| Global shortcuts register by physical key (`LayoutAwareGlobalHotkeys` disabled on macOS; [why](desktop.md#recording-shortcut)) | The editor records physical keys and refuses the keypad; Chromium's layout-aware lookup moved the default ⌘⇧1 to the keypad under Zhuyin | On non-QWERTY Latin layouts a letter shortcut is the US position, not the keycap letter. On every Electron upgrade, confirm its Chromium still has the feature, or registration silently returns to layout lookup |
| Handwritten guards and one repository | Small protocol/state surface stays readable and testable | No protocol negotiation; independently shipped peers would need a stronger contract |
| Copy media buffers | An Electron 44 ArrayBuffer-transfer probe hung main | Extra copy and no bounded backpressure |
| Measure actual frame size | getSettings once caused an incorrect 1080×606 output from a 1080p display | Additional startup measurement and explicit fallback warnings |
| Align timeslice and keyframe interval | Low-motion Retina recordings exceeded the first-chunk deadline with timeslice alone | Nominal 1-second settings are not delivery guarantees |
| Retain quality coefficients | 30 fps outputs were near target; 60 fps remained useful despite excess bitrate | Larger 60 fps files; distinguish requests, track reports, and measured output |
| Remove audio-quality selector | Different requests produced about 160 kbps AAC on this setup | Fixed 256 kbps request does not promise that bitrate or stereo separation |
| Do not compensate inherent A/V latency | Measured latency/drift met the project's accepted limits | Remeasure after capture-engine changes |
| Fixed self-signing identity and DMG | Recipients can install without developer tools or certificates | No Apple notarization; first-launch exception may be needed; TCC behavior is not universally guaranteed |
| DMG holds only the App and Applications link | The drag-to-Applications window is the installer convention users already know; bundled documents added clutter and ambiguity | Help, update and removal guidance must stay reachable online and linked from every release; the release gate fails on any extra visible file |
| Tag is the release and the version; verification precedes tagging | One maintainer and one Mac cannot support nightly channels, an in-pipeline manual acceptance gate only repeated checks already done during development, and a version stored in the repository before tagging was one more thing to get wrong | CI proves build, signature, layout and byte identity but not capture; a bad release is fixed by a new version, never by overwriting; the record job commits to main as a bot |
| Manual update and Trash removal, no updater or uninstaller | Same identity and path keep settings and permissions across replacements; a one-button recorder gains little from background update machinery | Users must download new versions themselves; user data is never deleted automatically; revisit only through the deferred update assessment |
| macOS-only verification and packaging | Available hardware is Mac; other platforms are not release blockers, and an unverified installer should not be offered | Keep portability code (Windows tray branch, platform checks) without claiming untested behavior works; no `win`/`nsis` build target or `dist:win` script until a maintainer can verify on hardware |
| English source and optional Traditional Chinese | GitHub documentation and diagnostics use a common source language; users may choose Chinese UI | Catalog and paired documentation must be maintained together |
| Separate design from plans | Execution logs are poor long-term specifications | Keep behavior/evidence in docs and unfinished work in plans |
| Raw measurement runs stay local | Per-run reports, logs and probes are machine-specific and would multiply with every contributor; only the interpreted conclusion is durable | `docs/verification/measurements/` is gitignored; the verification record and release records must carry enough numbers to stand without the raw files; history before `acc6342` still holds the early raw runs |
| [Known-fixture audio diagnostics](audio-quality.md) | Simultaneous pilot, frequency fitting, and continuity windows distinguish spectral loss, gain, and clock error | Invalid measurements cannot support quality claims; retain repeated failures, never learn a bad baseline automatically; not a substitute for listening or long-duration verification |

## Evolution boundaries

Builds use electron-vite and electron-builder. Follow stable dependency releases and rerun relevant checks and media verification when upgrading; an old measurement is not proof about a new engine.

There is no speculative Effect, schema framework, monorepo, React, Rust, or full PlatformRecorder layer. A future UI renderer should remain outside the media byte path. If Chromium proves inadequate, evaluate a replacement host while preserving Recorder's contract. Recording libraries, editing, shortcuts, automatic updating, and additional platform support are not prerequisites for the current downloadable build.

Third-party comparisons and native-engine candidates from historical planning are not current dependencies or commitments. Reevaluate their APIs and suitability if an actual need arises.
