# Audio Quality: What We Measure and Why

[English](audio-quality.md) | [繁體中文](../zh-TW/system-design/audio-quality.md)

This chapter explains the development-only audio diagnostic system, fixture/report version 2. It is a guide to reasoning about audio failures, not a claim that every recording now sounds correct. Commands are in [tooling](tooling.md#audio-fidelity-regression); actual outcomes belong in the [verification record](../verification/README.md). The production recording path is described in [recording](recording.md); the audio part of it, and why it preserves what this suite measures, is in [§16](#16-the-native-audio-path--why-it-preserves-fidelity). Since 2026-10-16 (plan 076) recording runs only through the native capture engine, and every measurement this tool makes now goes through it. Findings from the earlier Chromium capture path (§15) are kept as history because they explain why the suite measures what it does.

For the roles Electron, Chromium, browser media APIs and internal WebRTC audio processing played in that earlier path, see [Why recording left Chromium's WebRTC capture](webrtc.md).

## 1. The question behind the test

A user reported that recordings sounded muffled. "The MP4 has an audio track" cannot answer that complaint. We need to ask whether the recording preserves the parts of the source that matter: frequency balance, independent left/right information, level, waveform shape, and continuity over time.

The test is an experiment with a known input. We generate a reproducible signal, play it through the system, record with the real app, decode the saved file, and compare measurements with the signal's known properties. A controlled input makes an unexpected output falsifiable. Listening remains useful: synthetic signals expose specific mechanisms, while speech and music reveal whether those mechanisms matter in context.

```mermaid
flowchart LR
    A[Known PCM fixture] --> B[afplay / OS output path]
    B --> C[System audio capture]
    C --> D[Native engine: sample-count timing, mixer, AAC]
    D --> E[Saved MP4]
    E --> F[FFmpeg decode without remixing]
    F --> G{Can we identify the fixture?}
    G -->|No| H[Invalid measurement]
    G -->|Yes| I[Frequency, channels, level, residual, continuity]
    I --> J[Pass or measured failure]
```

This experiment measures the complete playback → capture → encode path. A failure does not by itself identify the responsible stage. To isolate a cause, retain this test and change one stage at a time, or add a PCM observation point before encoding. A passing FFmpeg AAC control only proves that the control encoder preserves this fixture; it does not prove the platform AAC encoder the app uses (AudioToolbox on macOS, Media Foundation on Windows) behaves identically.

## 2. Why metadata and bitrate are insufficient

| Observation | What it establishes | What it cannot establish |
| --- | --- | --- |
| 48 kHz sample rate | The sample time grid in the file | That 12 or 16 kHz survived capture/filtering |
| Two channels | Two sample values per frame | That left and right contain independent information |
| High AAC bitrate | Encoded storage budget/output rate | Original signal quality, absence of earlier low-pass filtering |
| Nonzero RMS | There is energy | Whether that energy is the intended sound, noise, or distortion |
| Decoder exits successfully | The stream is decodable | Whether samples were lost or modified before encoding |

At 48 kHz, the Nyquist limit is 24 kHz, but this is a theoretical representable upper limit. A filter earlier in the pipeline can still remove everything above 10 kHz. Similarly, duplicating mono into two channels creates a file labelled stereo without recovering stereo information. Increasing bitrate cannot recreate information lost before the encoder.

## 3. Three different claims of success

1. **Detector correctness:** clean controls pass and deliberately damaged controls fail for the intended reason. This belongs in automated tests.
2. **Local path quality:** the actual app/OS/device combination meets the gates for this fixture. This requires real capture, not mocked media APIs.
3. **Product-wide confidence:** repeated, representative environments and content behave well. This requires a wider evidence set and listening; one machine or one pass is insufficient.

`pnpm check` establishes the first claim for covered cases. `audio:quality record` investigates the second. Neither alone establishes the third. A large repository-wide test count is not an audio-quality coverage measure.

## 4. How fixture v2 is constructed

The file is 48 kHz, stereo, PCM16 WAV, 12.1 seconds long. Synthesis uses floating-point samples before WAV quantization. Normal probe peaks have headroom; the tool does not change system volume.

| Source time | Content | Purpose |
| --- | --- | --- |
| 0–0.5 s | Silence | Allow capture/playback startup |
| 0.5–1.0 s | 1 kHz marker in both channels | Find the signal and estimate its frequency scale |
| 1.0–1.5 s | Silence | Reject unrelated continuous tones and validate alignment |
| From 1.5 s, twelve 0.8 s slots | 0.6 s sound + 0.2 s gap in each slot | Six frequencies in left only, then six in right only |
| 11.1–11.6 s | 2 kHz marker in both channels | Confirm the terminal signal and check end timing |
| 11.6–12.1 s | Silence | Preserve a trailing margin |

Probe frequencies are 250 Hz and 1, 4, 8, 12, 16 kHz. These sample bass, midrange, and increasingly high frequencies. They are diagnostic points, not a full spectrum; a narrow notch between them can escape detection.

Every probe includes a simultaneous 1 kHz pilot in the active channel. Pilot and target each have peak amplitude 0.125. For the 1 kHz slot there is only one sinusoid, not two copies. The start/end markers have amplitude 0.25. All tones have 10 ms linear fades to avoid an artificial click at their boundaries.

### Why a simultaneous pilot matters

Suppose a 1 kHz tone is played first, then 12 kHz later. If automatic gain drops between them, a sequential comparison could call that drop "high-frequency loss" even when the path is spectrally flat.

V2 compares the target with a 1 kHz pilot present at the **same time**. A common gain applied to both cancels in their ratio. We still measure pilot gain separately, so normalization does not hide a recording that became very quiet. This helps with gain changes between probes; it does not eliminate frequency-selective processing or gain that varies within a probe. Two-tone stimulation may itself interact with nonlinear/adaptive processing. The result describes this controlled stimulus.

## 5. Alignment, clocks, and the original false positive

Capture latency shifts a waveform in time. Clock mismatch also changes the apparent frequency and accumulated duration. These are different effects.

V1 projected samples onto an exactly nominal sinusoid. A clean 16 kHz tone shifted by 10 ppm is at 16000.16 Hz. Its phase gradually departs from the nominal reference. V1 classified the resulting mismatch as residual distortion, despite the input being a clean sinusoid. This false positive was reproduced, not merely hypothesized.

V2 does the following:

1. Search for at least 300 ms of coherent 1 kHz in 10 ms blocks, ignoring unrelated startup sounds.
2. Estimate the marker frequency in a bounded interval by coarse search and local refinement. The objective minimizes fitted residual.
3. Compute `speed = measured_marker_frequency / 1000` and `clock_ppm = (speed - 1) × 1,000,000`.
4. Map source time to decoded samples using `observed_onset + (source_time - 0.5) / speed`.
5. Require the expected duration, quiet marker gap, and distinct 2 kHz terminal marker. Compare observed end time with predicted end time.
6. Estimate the local 1 kHz pilot for each probe and fit the target with the same local frequency scale. Report the estimated offset separately.

Frequency search is bounded to ±0.1% of the nominal frequency, with a minimum half-width of 0.5 Hz. The 1 kHz pilot searches ±1 Hz. The acceptance gate is tighter: ±200 ppm. Searching beyond the gate lets us report excessive clock error without labelling it distortion. This is not unrestricted time warping or an attempt to make damaged audio pass.

The onset grid is 10 ms. The end-timing tolerance is 20 ms and edge guards accommodate this grid. V2 checks short-recording timing; it does not establish long-duration drift stability. The separate [recording verification tools](tooling.md#measurement-pipeline-and-thresholds) handle A/V timing; container timestamp gaps are not measured by this PCM-only analyzer.

## 6. Sinusoid fitting and residual energy

A finite analysis window need not contain an integer number of cycles after clock correction. Simply reading one FFT bin or assuming sine/cosine orthogonality can leak real signal energy into the residual.

We fit this model by least squares:

`sample[n] ≈ DC + Σ(a[k] × sin(2πf[k]n/Fs) + b[k] × cos(2πf[k]n/Fs))`

The Gram matrix accounts for overlap among the basis functions. The sine/cosine coefficients support arbitrary phase. Each component's power is `(a² + b²) / 2`. The fitted DC component is included in reported residual energy rather than silently ignored. Tiny negative round-off in residual subtraction is clamped to zero.

For a normal probe the model contains the pilot and target; the 1 kHz-only slot has one component. Spectral measurements use the central 300 ms to avoid fades and codec boundary effects. The residual contains energy the fitted model cannot explain: noise, harmonics, gain modulation, or nonuniform timing. It is an engineering residual metric, **not a standardized THD+N instrument reading or a perceptual score**.

Power ratios use `10 × log10(Pout / Pref)`. Amplitude ratios would use `20 × log10(Aout / Aref)`. Mixing the two would report an incorrect dB value. A −3 dB power ratio is about half the power; a −20 dB ratio is one hundredth. Internal floors keep JSON values finite, so near-floor values should be interpreted as "very little detected energy", not exact acoustic sensitivity.

## 7. What each gate protects

All thresholds below are initial project engineering gates, not industry certification limits. They are serialized with every report.

| Gate | Initial threshold | Why it exists / failure interpretation |
| --- | --- | --- |
| Format | 48 kHz, exactly 2 channels | Reject wrong format before processing can hide it |
| Fixture validity | Start marker + quiet gap + distinct end marker | Prevent measurement of the wrong sound or wrong time interval |
| Marker/local pilot clock offset | ±200 ppm | Distinguish clock error from waveform damage |
| End timing | ±20 ms after frequency-scale compensation | Detect larger insertions, deletions, or incorrect alignment |
| Target/pilot response | ±3 dB | Detect spectral imbalance, including the high-frequency loss associated with muffled sound |
| Pilot gain | ±6 dB relative to the generated pilot | Detect broad attenuation/amplification that response normalization intentionally cancels |
| Channel separation | ≥30 dB | Detect cross-channel leakage and duplicated mono; uses combined fitted signal power versus the inactive channel's total power |
| Residual/signal | ≤−25 dB | Detect unexplained noise/distortion in the central window after frequency fitting |
| Minimum component level | ≥−15 dB relative to that component's central-window power | Detect short missing/attenuated pieces across most of the audible probe |
| Maximum clipped block fraction | ≤0.1% at absolute decoded amplitude ≥0.999 | Catch short digital full-scale clipping without diluting it in a long file |
| Following gap | ≤−35 dB relative to the preceding probe's total power | Detect contamination or signal spilling into expected silence |

The separation gate cannot reconstruct stereo; it only detects its loss. The clipping gate does not prove absence of upstream analog clipping or limiting below full scale; the residual may catch some of those effects. Gap failure may be another application's sound, so investigate the environment before blaming the recorder.

## 8. Fixing the original dropout blind spot

V1 examined only the central 300 ms of each 600 ms tone. Removing the first and last 100 ms of every tone still passed. That deleted one third of the audible probe while leaving the measured center intact.

V2 uses overlapping 10 ms blocks, advanced by 5 ms, across **20–580 ms** of each probe. The outer 20 ms guards accommodate fades, onset quantization, and codec boundaries. Every block fits pilot and target separately and compares each component with its corresponding central-window power. A surviving pilot therefore cannot hide a missing high-frequency target. Using fitted component powers also avoids treating the normal two-tone beat envelope as a dropout.

The same blocks detect short clipping. Silence is checked in the central 80 ms of each following gap. These are explicit coverage choices:

- Very short damage below the window's sensitivity may escape detection.
- The guarded first/last 20 ms are not covered by the dropout gate.
- Frequency response, residual, and channel separation remain central-window measurements.
- The suite is not a claim that every sample in arbitrary content was verified.

## 9. Pass, fail, invalid, and execution error

| Outcome | Meaning | CLI status |
| --- | --- | --- |
| `pass` | All available required checks passed for a recognized fixture | 0 |
| `fail` | A measured requirement failed, including format or recognizable truncated duration | 1 |
| `invalid` | The PCM/markers/gap do not support trustworthy analysis; spectral rows are suppressed | 2 |
| Execution error | Tool, input, permission, playback, timeout, or filesystem failure | 2 |

Missing markers can themselves result from a broken capture path. `invalid` means "cannot support the frequency measurements", not "the app is innocent". Both invalid and fail must prevent a claimed passing verification. A raw report preserves the preceding checks; a process/input error uses `error.json`.

## 10. Testing the test

The analyzer's tests must establish both sensitivity and tolerance. Only testing damaged examples encourages an analyzer that fails everything. Only testing clean examples encourages one that always passes.

| Control family | Required behavior | Reason |
| --- | --- | --- |
| Clean PCM, independently synthesized phase/clock controls | Pass, including ±10/20/100 ppm | Correct for harmless measurement mismatch |
| Excessive clock offset | Fail clock gate, not residual on otherwise clean tones | Preserve diagnostic separation |
| Real FFmpeg AAC control | Pass | Include real quantization/codec behavior beyond ideal arithmetic |
| Real low-pass, mono, 44.1 kHz files | Fail appropriate gates | Exercise decoding and avoid automatic "repair" of invalid format |
| Selective target attenuation | Fail response | A pilot must not conceal spectral loss |
| Different constant gains between probes | Pass response when still within gain limits | Demonstrate the simultaneous reference rationale |
| Whole-probe and target-only edge dropouts | Fail component continuity | Reproduce and close the earlier blind spot |
| Dual-mono, swapped/missing channels | Non-pass | Channel count alone is insufficient |
| Harmonics, short clipping, gap contamination | Fail corresponding gates | Cover different failure mechanisms |
| Missing end marker, malformed/empty PCM | Non-pass; suppress unsupported spectral claims | Duration alone can be padded with silence |
| Repeat summaries | Keep any failure; count missing/invalid measurements | A median must not hide failed runs |
| CLI errors and existing paths | Correct exit code; preserve existing evidence | Automation must not report success or overwrite earlier results |

FFmpeg/ffprobe integration tests are explicitly skipped when the tools are absent. A release verification environment should install them and check the skip count. The remaining unit tests do not replace that integration coverage.

## 11. Repeatability and evidence

`record <new-directory> --repeat 3` runs three independent captures. Each gets its own reference, log, report, and retained MP4 path. `summary.json` records pass/fail/invalid counts and per-metric minimum, median, maximum, measured count, and missing count. Invalid runs are excluded from metric statistics and explicitly counted. Any valid failure keeps the batch failed; any invalid measurement makes the batch invalid. While recording or finalizing environment evidence, the summary stays `incomplete`. If execution stops early, its requested/completed counts and `error.json` expose incompleteness; a partial batch cannot claim pass.

The runner saves before/after environment snapshots: OS/architecture, Node/Electron/FFmpeg versions, source/fixture hashes, macOS audio-device inventory and volume settings when available. Read failures are recorded as unknown. An observed device/volume change makes the final batch invalid. Identical endpoint snapshots do not prove the setting stayed fixed between them, and they do not describe every driver/processing option.

Three runs are a repeatability check, not statistical calibration. To promote a dataset to a baseline:

1. Fix and record the device, volume, application/OS versions, and processing options. Pause other system audio.
2. Verify the reference and decoder controls pass.
3. Collect several runs; inspect both the worst case and spread. Keep failures.
4. Confirm subjective playback with representative speech/music on the same route.
5. Review any threshold change independently of the failing run. Version it and retain old results unchanged.

We do not automatically learn thresholds from the current app: doing so would normalize its existing defects into "good" audio. Per-metric ranges are observations, not confidence intervals or an automatic regression-to-baseline comparison. A known-bad dataset is evidence for a fix, never a passing baseline.

## 12. How to investigate a failure

- **Invalid fixture:** inspect playback completion, other audio, format, start/end markers, and duration first. Do not interpret missing response rows as success.
- **Response failure with stable pilot gain:** investigate frequency-dependent loss along the path. Repeat to distinguish adaptive processing from a stable filter.
- **Gain failure with flat response:** inspect level controls and gain processing. Increasing bitrate is not an evidence-based response.
- **Separation near 0 dB:** inspect channel mixing before and during capture. Raising a channel-count constraint alone may still yield duplicated mono.
- **Residual with small frequency error:** inspect noise, modulation, distortion, and codec behavior. The metric does not identify one cause by itself.
- **Continuity/end timing failure:** inspect sample loss, delivery gaps, and the existing container/A/V verification output.

Change one variable, retain both reports, and require the clean and damaged detector controls to keep behaving correctly. Do not add equalization merely to make probe numbers look better: it may amplify noise and does not restore information that disappeared.

## 13. What we learned from Cap

We inspected Cap commit `17e17902691ca499de9e44b0dd7a19d8c4b630a8`; we did not run its test suite. Its [intelligibility benchmark](https://github.com/CapSoftware/Cap/blob/17e17902691ca499de9e44b0dd7a19d8c4b630a8/scripts/benchmark-audio-intelligibility.py) aligns signals before STOI/SI-SDR evaluation. Its [alignment tests](https://github.com/CapSoftware/Cap/blob/17e17902691ca499de9e44b0dd7a19d8c4b630a8/scripts/test-audio-intelligibility.py) check that delay/advance does not unfairly change the overlapping-speech score. This reinforces the need to test the measurement itself.

Cap's [audio integration tests](https://github.com/CapSoftware/Cap/blob/17e17902691ca499de9e44b0dd7a19d8c4b630a8/apps/media-server/src/__tests__/lib/audio-quality.integration.test.ts) check level/peak behavior, timing and boundary preservation. Its [sync workflow](https://github.com/CapSoftware/Cap/blob/17e17902691ca499de9e44b0dd7a19d8c4b630a8/.github/workflows/sync-tests.yml) defines cross-platform synthetic timing scenarios. We adopt the principles of layered controls, alignment validation, and explicit evidence, rather than treating another project's test count as proof of quality.

Their speech benchmark decodes to mono at 16 kHz, so it cannot replace our stereo/high-frequency checks. STOI/SI-SDR, speech/music corpora, full-band sweeps, long-duration clock tracking, and broader device coverage are possible extensions, **not implemented or claimed by v2**. They should be added for a concrete question and validated with independent good/bad controls.

## 14. Implementation map and invariants

| Module | Responsibility |
| --- | --- |
| [audio-quality.mts](../../scripts/lib/audio/audio-quality.mts) | Pure fixture generation, WAV serialization, bounded frequency estimation, fitting, gates |
| [audio-quality-tools.mts](../../scripts/lib/audio/audio-quality-tools.mts) | Bounded FFprobe/FFmpeg calls; run the actual development app and owned audio player |
| [audio-quality-summary.mts](../../scripts/lib/audio/audio-quality-summary.mts) | Aggregate repeated measurements without hiding failures or missing values |
| [CLI](../../scripts/audio-quality.mts) | Validate arguments, new output directory, environment snapshots, repeat loop, JSON and exit status |
| [Tests](../../scripts/lib/audio/audio-quality.test.ts) | Clean/damaged controls, real codecs, CLI contracts, summary behavior |

Invariants: no upmixing/resampling to hide format faults; decode only the first 60 seconds with bounded buffers/timeouts; do not change production audio processing or user settings; do not overwrite an existing evidence directory; terminate only owned child processes; preserve prior raw measurements. Fixture v1 recordings must not be evaluated as v2. Generate and record v2 material, and keep the original v1 report as historical evidence.

## 15. System capture correction — 2026-09-14

> **History.** This section describes the Chromium capture path, which plan 076 removed on 2026-10-16. Its constraints no longer exist in the app; the finding is kept because it shows what speech-oriented processing does to a system mix and why the native path in §16 applies none. Read "now" below as "from 2026-09-14 until 2026-10-16".

The production capture request then explicitly set `echoCancellation: false`, `noiseSuppression: false`, and `autoGainControl: false`. It retained `restrictOwnAudio: true`, ideal two channels, and the 256 kbps AAC target. No equalizer, post-recording transcode, or new capture engine was introduced at that time.

Why these settings matter: echo cancellation, noise suppression, and automatic gain are useful for interactive voice capture, but a recorder should preserve the digital system mix, including music's spectral detail and dynamics. Processing designed for speech can change that signal. Chromium's [audio processing layout](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/mediastream/media_stream_audio_processing_layout.cc) has a processed-display-capture path conditional on echo cancellation. This supports a plausible mechanism; our experiment establishes the effect of disabling the three constraints **together**, not the isolated contribution of each effect or every Chromium revision.

| Effect | Useful voice-call goal | Why a system recorder disables it |
| --- | --- | --- |
| Echo cancellation | Remove loudspeaker playback recaptured by a microphone, preventing the remote speaker from hearing themselves | This recorder captures a digital mix, not microphone feedback; extra cancellation is unnecessary for that goal |
| Noise suppression | Make speech easier to hear in noisy microphone input | Music detail, ambience, or reverberation can be treated as unwanted content; preservation is the recorder's goal |
| Automatic gain | Keep changing speech levels intelligible | Changes intended loud/quiet dynamics; existing source processing should not be applied again by the recorder |

These features optimize a different objective: intelligible conversation rather than faithful reproduction. If a meeting application already processes its microphone, its resulting playback is what RecordStuff records; disabling processing here does not disable processing inside that application. The [WebRTC Audio Processing API](https://webrtc.googlesource.com/src/+/refs/heads/main/api/audio/audio_processing.h) describes its voice enhancement role and capture/reverse-stream model.

The same v2 fixture and analyzer thresholds were used for the comparison. The earlier valid baseline runs had approximately 0 dB separation and 16 kHz response around −44 to −47 dB. After the change, two valid repeated runs passed every diagnostic gate: 16 kHz response was within 0.004 dB of the simultaneous pilot, and separation exceeded the 30 dB gate. Very large separation numbers approach the analyzer's numerical floor and should not be interpreted as calibrated analog dynamic range.

The final three-run batch contains **2 pass, 0 fail, 1 invalid**; it remains invalid overall. The first run's marker gap was contaminated (−18.81 dB versus the −30 dB identity gate), so its spectral measurements were suppressed. An earlier single trial also retained some early noise/gap failures despite restored high frequencies. All are preserved in the [evidence](../verification/README.md). We did not relax thresholds, filter the reference, delete failed trials, or turn the invalid batch into a passing claim.

The capture host warned when `getSettings()` explicitly reported one of the disabled effects as true. An absent property is unknown, not proof that processing is off. Regression tests asserted the explicit constraints and the warning behavior until the path was removed. Real probes remain necessary because a mocked constraint assertion cannot establish what an OS actually captured. Own-audio exclusion stayed enabled because the experiment restored fidelity without removing it.

This correction applied to **new recordings made with the rebuilt app**. It does not restore information missing from old files. The local spectral/stereo result is improved; subjective comparisons using the user's original content and broader device/platform coverage remain separate evidence.

## 16. The native audio path — why it preserves fidelity

Since plan 076 the app records through a native engine (Rust, `native/capture`) running in an Electron `utilityProcess`. The audio path has no speech processing, no resampling by RecordStuff, and no level control except a soft limit where two inputs together approach full scale:

| Stage | macOS | Windows |
| --- | --- | --- |
| System audio | ScreenCaptureKit, configured for 48 kHz, 2 channels, 32-bit float, excluding RecordStuff's own process audio | WASAPI process loopback: everything the system plays except RecordStuff's process tree, opened at 48 kHz stereo float |
| One app's audio (engine and tests only; no picker yet) | ScreenCaptureKit app-filtered audio, same format | WASAPI process loopback of the chosen process tree |
| Microphone (plan 074; on by default since 2026-10-26) | AVFoundation (`AVCaptureSession`), converted by the OS to one channel of 48 kHz float and heard in both of the track's channels; no voice processing | WASAPI capture of the chosen or default endpoint, opened as 48 kHz mono float with `AUTOCONVERTPCM` and heard in both channels; not the communications pipeline, and the stream opts out of ducking |
| Timing | Each input is placed on the session clock by counting its samples ([timing.rs](../../native/capture/src/timing.rs) `AudioAligner`) | Same |
| Mixing | [mixer.rs](../../native/capture/src/core/mixer.rs): the inputs' sum at unity gain (system audio, plus the microphone when it is on), softly limited only where two or more inputs sum past −1 dBFS | Same |
| Encoding | AAC-LC through AudioToolbox at the quality's audio bitrate (256 kbps), float input | AAC-LC through Media Foundation, which takes 16-bit PCM and at most 192 kbps: the float samples are converted and a higher setting is lowered to 192 kbps with a session warning |
| Container | The engine's MP4 muxer; the encoder's priming is skipped by an edit list | Same; Media Foundation does not publish its priming, so it is measured when the encoder is made |

Why each choice matters for the gates in §7:

- **Format.** The OS delivers 48 kHz float, stereo for system audio and one channel for the microphone, so the engine never converts sample rate. Where the device differs, conversion happens in the OS before the engine sees the samples (on Windows the audio engine converts; on macOS ScreenCaptureKit and AVFoundation deliver the configured format). The engine hears the microphone's one channel in both of the track's channels, as Cap does, so an audio interface's microphone on its input 1 is not left-only; a stereo microphone is therefore recorded as mono. A mono source stays mono information duplicated in two channels, which the separation gate would detect; system audio keeps its two channels.
- **No processing.** Nothing equivalent to Chromium's echo cancellation, noise suppression or automatic gain sits in the path, so the §15 failure mechanism cannot recur unless such processing is added deliberately.
- **Sample-count timestamps.** Audio is not stamped with each buffer's own time. A buffer continues where the previous one ended as long as its time agrees within 10 ms (480 frames). A disagreement just past that, by at most 2 ms more, is a device clock drifting (a microphone's runs 20–100 ppm off) and is corrected by one frame of silence inserted or dropped per buffer, so drift never cuts or holes the sound by a whole tolerance at once; a larger gap is filled with silence at once, and a larger overlap dropped at once. Audio therefore cannot drift against video by much more than that tolerance however long the recording lasts, and samples are never stretched or resampled to correct the clock; the stop log reports, per input, the frames of silence inserted and dropped to keep it on the clock. On Windows a microphone's packet times follow Chromium's rule ([recording](recording.md#audio)): a device whose first packet time is more than 500 ms from its arrival, and any packet flagged with a timestamp error, are timed by arrival. On stop, capture keeps running until the sound up to the stop has arrived, so the audio track is as long as the video's.
- **Mixer.** The track is the sum of the inputs, stereo, at unity gain: nothing is levelled or collapsed, and with a single input the track is exactly that input's samples. The track advances to where every input has delivered, and also with the clock 500 ms behind it, so an input that sends nothing (WASAPI loopback while nothing plays, a stalled device) counts as silence rather than holding the track back; sound that arrives after that point is dropped and counted as late (`late_audio_frames` in the engine's stop report). With the microphone on there are two inputs, system audio and the microphone. Where two or more inputs with nonzero samples sum past −1 dBFS (loud media under a voice), a tanh soft limit takes the sum towards full scale without reaching it, continuous at the threshold; there is no compressor, and below −1 dBFS, or with one input sounding (the other silent, or the microphone off), the track is the sum exactly, bit for bit. The stop log counts the limited samples. A single input past full scale is left as it is: it is not the limiter's to change.
- **Microphone processing.** The microphone is mixed raw: no echo cancellation, noise suppression or automatic gain on either platform (plan 074's decision, 2026-10-16). macOS's voice-processing I/O and Windows' communications capture pipeline are not used, because on macOS voice processing can duck other apps' output, which would lower the very system audio the recording keeps, and §15 showed what speech processing does to a system mix. On Windows opening a microphone can also make Windows duck other apps as for a call, so the microphone stream calls `IAudioSessionControl2::SetDuckingPreference(TRUE)` to opt out (best effort; an older Windows may not offer it). The cost is that a microphone near loudspeakers records the system audio a second time, slightly later, and the room with it; the switch's ⓘ advises headphones. Meeting apps that process their own microphone still do so inside those apps.
- **Encoding.** The encoder receives float samples on macOS, so AAC quantization is the only lossy step. The priming edit list keeps the first audible sample at its time instead of shifting the track by the encoder's delay.

This explains why the native path should pass the suite; it is not a measurement. The results are in §17, and with the microphone in §18. Windows audio content and fidelity are untested on hardware (plan 076, D8); CI only checks that each stream opens, delivers and stops.

## 17. Native engine results — 2026-10-15

Plan 076 step 7, round 1, on the reference M1 Pro (macOS 26.6, Electron 44.3.0), with the same fixture v2, analyzer and thresholds: `pnpm audio:quality -- record` passed every check through both the native engine and, for comparison, the Chromium path that was still present that day.

| Measurement | Native | Chromium (history) | Gate |
| --- | --- | --- | --- |
| Clock offset | −0.07 ppm | −1.45 ppm | ±200 ppm |
| Target/pilot response, worst probe | within 0.002 dB | within 0.002 dB | ±3 dB |
| Pilot gain, worst probe | within 0.002 dB | within 0.002 dB | ±6 dB |
| Channel separation, worst probe | 116.7 dB | 115.7 dB | ≥30 dB |
| Residual/signal, worst probe | −51.6 dB | −58.6 dB | ≤−25 dB |
| Minimum 10 ms level, worst probe | −0.008 dB | −0.007 dB | ≥−15 dB |

Each engine had one valid run; this is a single-run comparison on one machine and route, not a repeated baseline. Separation figures this large sit near the analyzer's numerical floor and are not a calibrated dynamic range. Gains and residuals are alike within what one run can distinguish; the native clock offset is smaller. Raw reports are local (`docs/verification/measurements/`); the conclusion is recorded in [plan 076](../verification/history-2026-10.md#plan-076-closure--2026-10-16) step 7.

## 18. Microphone results — 2026-10-16

These runs were made before the engine changes that followed plan 074's comparison against OBS, Chromium and Cap: the soft limit, the mono microphone, one-frame drift correction, a stalled microphone taken back when the same session delivers sound again, and Windows' packet times and ducking opt-out ([§16](#16-the-native-audio-path--why-it-preserves-fidelity)). They describe the engine as it was then. A desktop round on the changed engine the same day covered the points listed at the end of this section; fidelity, sync and CPU were measured again on the HAL microphone in [§19](#19-microphone-results-on-coreaudios-hal--2026-10-17).

Plan 074 step 6, on a MacBook Pro (arm64, macOS 26) with the packaged bundle from `pnpm start:app`, fixture v2 and the same analyzer and thresholds. `record` drives the development Electron, which macOS refuses the microphone without a prompt (it has no usage description), so these runs started the packaged app with its shortcut, played the fixture with `afplay` and measured the file with `pnpm audio:quality -- verify`. Output went to wired headphones at volume 100; the input was the system default, a BenQ monitor's USB microphone.

| Condition (3 runs each) | Result | Gain, worst | Residual, worst | Separation, minimum | Clock |
| --- | --- | --- | --- | --- | --- |
| Microphone off | 3 pass | within 0.001 dB | −49.8 to −54.0 dB | 116.6 to 123.3 dB | 0.03 to 0.41 ppm |
| Microphone on, output muted | 3 pass | change 0.019 to 0.035 dB | −34.9 to −35.9 dB | 36.1 to 41.0 dB | −0.3 to +0.22 ppm |
| Microphone on, output audible | fail, fail, invalid | — | — | — | — |

- **Fidelity of the system part.** ScreenCaptureKit takes app audio before the output volume, so muting the output still records the system part while the microphone hears only the quiet room. In those runs 48 kHz stereo was kept and the gain moved by at most 0.035 dB; the residual rose and separation fell by the amount the room adds (the microphone alone, nothing playing: RMS −59.9 dBFS, peak −36.9 dBFS). The mixer did not resample, collapse stereo or change the system level. Limits: this machine has no silent virtual input, so "muted" was emulated by muting the output, and the residual and separation gates measure the mix, not the system part alone.
- **Audible output.** The microphone picked up the headphones' leakage and the room (one run's marker gap was −3.6 dB), so the mix held real microphone sound and the suite, which expects the fixture alone, failed or was invalid. That is the sound the microphone is for, not a mixer defect.
- **Ducking.** None: with the microphone on, the system 1 kHz gain measured +0.16 to +1.24 dB even with the leakage added, never a drop.
- **Sync.** A black page that turns white on a key press, recorded with the microphone on, and five hard space-bar taps: the sound's onset minus the white frame's time was −30, −40, −30, −30 and −20 ms (10 ms resolution; median −30 ms, the sound earlier). The picture also passes through Chrome's drawing, compositing and capture, one or two frames at 60 Hz, so the microphone shows no lag. Limit: key-to-photon latency is not separated out.
- **CPU.** `pnpm measure:cpu -- --minutes 2 --skip-settings --skip-playback`: recording at 30 fps averaged 13.3% of a core (14.2% p95, encoder 2.7%) with the microphone, 9.9% (10.6%, 2.8%) without it the same day; idle 0.048% and 0.041% before and after, and the capture process was gone afterwards. About 3.4 points, all in the capture process, likely AVCaptureSession's threads and AVFoundation's format conversion: inside the 30% budget, above the recorded baseline's +25% warning line (13.0%), and a follow-up candidate.

Listening by ear was not part of these runs, and the Windows microphone is untested beyond CI. Raw reports are local (`docs/verification/measurements/`); the conclusion is recorded in the [plan 074 closure](../verification/history-2026-10.md#plan-074-closure--2026-10-16).

On the changed engine (2026-10-16, later the same day, macOS):

- **Mono.** An iPhone Continuity microphone's recording had left minus right at −inf dB over 35 s: the one channel is heard identically in both.
- **End to end.** `pnpm acceptance` with the microphone on passed: 10 flashes and 9 beeps (the first beep fell at the file's start, before any silence, so the detector cannot count it), the integrity check and the cancel check.
- **Loss.** An iPhone Continuity microphone (twice) and a HUAWEI FreeClip 2 Bluetooth headset (twice), disconnected while recording, were each told lost by the core's 2 s without sound; the recording went on, the saved record carried `microphoneLost` and the notice appeared at the end. None was taken back after reconnecting ([recording](recording.md#audio)).

## 19. Microphone results on CoreAudio's HAL — 2026-10-17

Plan 078 step 6 replaced the macOS microphone's `AVCaptureSession` with an AUHAL input unit ([recording](recording.md#audio)) and measured again what §18 measured before the soft limit, the drift correction and the mono microphone, on the same MacBook Pro with the packaged bundle, fixture v2, the same analyzer and thresholds, the output muted and the system default input (the BenQ monitor's USB microphone).

| Run (output muted) | Result | Gain, worst | Residual, worst | Separation, minimum | Clock |
| --- | --- | --- | --- | --- | --- |
| 1 | pass | within 0.007 dB | −42.8 dB | 47.2 dB | −0.83 ppm |
| 2 | fail: R 250 Hz following gap −33.6 dB against −35 dB | within 0.005 dB | −40.0 dB | 43.2 dB | −0.16 ppm |
| 3 | pass | within 0.006 dB | −42.3 dB | 46.3 dB | −0.58 ppm |

- **Fidelity.** Every run kept 48 kHz stereo, a clock within 0.83 ppm and the gain within 0.007 dB; residual and separation, which measure the mix with the room in it, were 5 to 7 dB better than §18's. The one failed check is a quiet gap that the room's sound filled 1.4 dB above the limit. Four more takes are not in the table, each with a cause outside the mixer: two with the output audible (fail and invalid, the microphone hearing the fixture, as in §18), two in which the maintainer spoke during the start marker's gap (invalid, the gap −7.7 and −6.8 dB), and one muted take, before these three, that failed on the right channel's high-frequency gaps and separation (15.2 to 28.9 dB) while the left passed every check, the microphone being the same in both channels: sound in the room during the right channel's part.
- **Sync.** The key-press page of §18, eight hard space-bar taps: the sound came 10 to 74 ms before the white frame, median −44 ms (§18: −20 to −40, median −30). The picture still passes through Chrome's drawing, compositing and capture, so the microphone shows no lag; key-to-photon latency is not separated out.
- **CPU.** `pnpm measure:cpu -- --minutes 1 --skip-settings --skip-playback`: recording at 30 fps averaged 10.0% of a core (10.7% p95, encoder 2.6%) with the microphone on and 10.1% (10.8%, 2.9%) with it off the same day; idle 0.040 to 0.050% around both. §18's 3.4-point cost of the microphone, 13.3% against 9.9% on AVFoundation, is gone, which places it in `AVCaptureSession` and its format conversion; the microphone now costs nothing measurable.
- **Reconnection.** A FreeClip 2 headset put in its case and taken out again was closed at once, told lost, reopened and resumed, with silence and no other microphone's sound in between ([recording](recording.md#audio)).

Listening by ear was not part of these runs; the Windows microphone is checked by CI only. Raw reports are local (`docs/verification/measurements/2026-10-17-078-microphone/`); the conclusion is recorded in the [plan 078 closure](../verification/history-2026-10.md#plan-078-closure--2026-10-17).
