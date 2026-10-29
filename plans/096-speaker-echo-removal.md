# 096 — Removing speaker echo from the microphone, optional and non-destructive

[English](096-speaker-echo-removal.md) | [繁體中文](096-speaker-echo-removal.zh-TW.md)

Status: in progress; steps 0, 1 and 2 done on 2026-10-29 (G0 passes; D2 settled by step 2) (the test tools, before any canceller); D3 answered on 2026-10-29 (keep AAC); next, D1 before step 3. Created: 2026-10-26 at the maintainer's request. Hard dependencies: none open. It builds on the closed 087 (editable recordings, their separate sound tracks, scene and rendered export) and the closed 085 (the edit view, its worker and publication). Execute in order under the [plan index](README.md). Only the test tools of step 1 exist so far ([echo-removal bench](../docs/system-design/tooling.md#echo-removal-bench)); no canceller has been built, measured or verified.

The maintainer's condition (2026-10-26): build this only if it measurably helps. If it does not clearly help, do not build it. This plan therefore puts measurement first and has explicit stop points. Testing is automated, with material the tools make themselves; only the final stage hands over to the maintainer to listen and judge (2026-10-26). A stop is a valid outcome. It closes the plan with its evidence, not as a failure to deliver.

## Goal and current state

When sound plays through the Mac's speakers while the microphone records, the microphone hears it too. The recording then holds the system's sound twice: once captured digitally, clean, and once as the copy the room carried back into the microphone, a few tens of milliseconds later and with the room's reverberation. Summed, the two sound like an echo, or hollow and comb-filtered. With headphones the problem does not exist.

Current state:

- **Two inputs, captured apart.** System audio comes from ScreenCaptureKit (48 kHz stereo float, `excludesCurrentProcessAudio`) and the microphone from CoreAudio's HAL, one channel, read as it is and never through voice processing ([microphone.rs](../native/capture/src/mac/microphone.rs), [recording](../docs/system-design/recording.md#audio)).
- **A plain recording mixes them into one track.** The [mixer](../native/capture/src/core/mixer.rs) sums them at unity gain into a single AAC track (256 kbps). After that the two cannot be separated, and an echo cannot be removed.
- **An editable recording keeps them apart** (087, macOS, off by default): one MP4 with the system's sound and the microphone on tracks of their own, a scene with per-input volumes and volume stretches, and a rendered export that mixes them through the engine's limiter ([editing](../docs/system-design/editing.md#editable-recordings)). The volumes set while recording are already in each track.
- Nothing in RecordStuff removes echo. That is deliberate: the closed Chromium path once let system audio pass through voice processing, and a 16 kHz probe lost 44–47 dB ([learning article](../docs/learning/audio-clocks-mixing-and-av-sync.html), [audio quality](../docs/system-design/audio-quality.md)).

The goal: give a user who recorded on speakers an **optional** way to remove the speaker's sound from the microphone while keeping the voice as it was recorded, proven by automated measurement and the maintainer's listening, with the system's sound never touched.

## Reference evidence

Static and documentary evidence gathered on 2026-10-26. It is not evidence that any of these products behaves this way on our machines.

| Product | What it does about speaker echo | Source |
| --- | --- | --- |
| OBS Studio | No echo cancellation in its core. Its filters (Speex, RNNoise and NVIDIA noise suppression, gates, compressors) treat the microphone's own noise; NVIDIA's "Room Echo Removal" removes room reverberation, not the speaker's sound, and takes no reference. Forum guidance: headphones, or capture only specific apps. A third-party "Microphone DSP" plugin uses Windows' voice-capture DMO with desktop audio as the reference, Windows only. Separate tracks per source for post-production. | [forum](https://obsproject.com/forum/threads/mic-is-picking-up-desktop-audio-echo.80453/latest), [plugin](https://obsproject.com/forum/resources/microphone-dsp-plugin.127/update/296/), [NVIDIA filter commit](https://git.tjdev.de/mirror/obs-studio/commit/00c495b203a28c24402fa8d03031062d73f2d108) |
| Cap, revision `af9a65a91808739dc4386c29eea569fbe08c2d4e` (re-pinned at step 0 on 2026-10-29 from `7c3bd99c`; the same files say the same) | Desktop (Rust): no echo cancellation found (no AEC, voice processing or WebRTC APM in the recording code). Each segment keeps `mic.aac` and `system.ogg` apart (`crates/rendering/src/segment_timing.rs`), and the editor mixes them. "Studio Sound" (`crates/audio/src/voice.rs`, RNNoise plus a leveler, wet 0.9 by default) runs at playback and export, never changing the recorded file. Web and extension: the microphone asks for `echoCancellation`, `noiseSuppression` and `autoGainControl`; display audio asks for all three off (`packages/recorder-core/src/capture-streams.ts`). | [GitHub](https://github.com/CapSoftware/Cap/tree/af9a65a91808739dc4386c29eea569fbe08c2d4e) |
| Camtasia | Says recording system audio and a microphone together causes echo; recommends wired headphones. Per-source toggles. | [TechSmith](https://support.techsmith.com/hc/en-us/articles/203728878-Echo-and-Reverberation-in-Audio-When-Playing-in-the-Timeline-or-Produced-File) |
| Loom | System audio and its noise filter cannot be used together. No echo-cancellation setting was found. | [Loom](https://support.loom.com/hc/en-us/articles/360002449178) |
| Granola (meeting notes) | Says it built more elaborate echo cancellation because it records on the device rather than joining as a bot. Vendor claim, unverified. | [Granola](https://granola.ai/blog/granola-google-meet-integration-recording-transcription) |
| Recall.ai (recording SDK) | Mic and meeting audio as separate streams, meeting audio as the reference, AEC on the microphone only, the original meeting audio kept. On macOS: VoiceProcessingIO is part of the live I/O and is not a post-processor; WebRTC APM (AEC3) takes separate streams but leaves synchronization to the app; a device change breaks alignment. | [Recall.ai](https://www.recall.ai/blog/acoustic-echo-cancellation) |
| RecordKit (macOS recording SDK) | An optional `echoCancellation` on the microphone, using system audio as the reference and WebRTC AEC3. `balanced` keeps speech natural during double-talk at 48 kHz; `aggressive` removes more at 16 kHz with a residual-echo gate. Mono output, macOS 14.2+. | [RecordKit](https://nonstrict.eu/recordkit/guides/echo-cancellation.html) |

What this means for us: screen recorders leave echo to headphones and give separate tracks. Meeting recorders and SDKs cancel echo on the microphone only, with the system's sound as the reference, and keep the original. Cap applies its voice processing at playback and export, not to the file. None of the screen recorders inspected offers echo removal, so if it works this would be a real addition, not parity.

Candidate implementation: [`webrtc-audio-processing`](https://github.com/tonarino/webrtc-audio-processing) 2.1.0 (still the latest on crates.io at step 0, 2026-10-29), Rust bindings for PulseAudio's packaging of WebRTC's audio processing module, BSD-3-Clause. Its `bundled` feature builds the C++ from source, and `experimental-aec3-config` exposes AEC3's detailed configuration (its suppressor). It has not been built or tried here.

## Product position and design principles

RecordStuff is "screen, sound and camera, nothing else", to a plain MP4, preserving what was recorded: unity gain, no processing, a tested audio path. Echo removal must fit that:

- **P1 — off by default, the user's choice.** Never automatic.
- **P2 — non-destructive.** The recording is never changed. Echo removal is a property of an edit, applied at preview and export, and can be turned off again, as Cap's Studio Sound and 087's volumes are.
- **P3 — the microphone only.** The system's sound is never processed. It is only used as the reference.
- **P4 — echo only.** No noise suppression, no automatic gain, nothing else that changes the voice. Those are separate questions and are not part of this plan.
- **P5 — the voice comes first.** When removing more echo would audibly change the voice, the voice wins. Some residual echo is acceptable; a damaged voice is not.
- **P6 — proven or not shipped.** Every claim is a measured number on this machine, against thresholds fixed before the candidates are tried, and the maintainer's own listening confirms it at the end.

## Requirements (maintainer, 2026-10-26)

- **R1 — an optional switch.** Not on by default; the user turns it on when they want it.
- **R2 — the best achievable sound.** Remove as much of the speaker's sound as possible while keeping the recorded voice as close to the original as possible.
- **R3 — proof that it works**, and a rule to drop the feature if it does not.
- **R4 — automated until the end.** The tests run without the maintainer: the tools make their own material (voices, music, the echo itself) and measure the results. Only the last stage hands over to the maintainer, who listens to labelled clips (not blind) and decides whether the feature really works.

## Design (proposed, to be confirmed by measurement)

### Where it runs: editing and export of editable recordings

Echo removal needs the microphone and the system's sound apart. Only editable recordings keep them apart, so this is an editing feature of editable recordings (macOS):

- The edit view of an editable recording that holds both a microphone track and a system track offers **Remove speaker echo** for the microphone. Otherwise the control is absent, or shown unavailable with the reason (no microphone, no system sound, not editable, Windows).
- Turning it on is saved in the edit's scene (for example `echoRemoval: { enabled }`; the shape is fixed in step 4), validated field by field in [shared/editing.ts](../src/shared/editing.ts) and undone with the other edits.
- **Preview.** The export worker processes the microphone track into the preview file the view already plays (`userData/edits/preview`), with progress and cancel, so the user hears the result before exporting. The processed preview is kept only while the view is open, as the copied tracks are now.
- **Export.** [render.rs](../native/capture/src/edit/render.rs) passes the decoded microphone through the canceller, with the decoded system track as the reference, before the mix. The system's samples reach the mix unchanged.
- **Plain recordings are not covered.** Their single mixed track cannot be separated. Live, destructive echo removal while recording conflicts with P2 and is out of scope; it can be reconsidered later with this plan's measurements.

Why offline rather than live: an offline pass can go over the track twice (converge first, then process the whole track with a converged filter, so the first seconds are not left echoing), estimate the delay and the speaker's path from the whole recording, and needs no real-time budget. The cost is waiting for processing, measured as G5. Whether a two-pass scheme is used depends on step 3's results.

### The reference

The reference is what the speakers played. The system track of an editable recording is that sound with two caveats, measured in step 2:

- **The recorded volume.** The system track holds the volume set while recording. A volume that is not 0% only scales it, which a canceller follows. A stretch where the system was muted or at 0% leaves no reference, and the speaker's sound in the microphone cannot be removed there; the edit view says so.
- **The system's output volume.** If ScreenCaptureKit captures before the system's output volume, changing the Mac's volume during a recording changes the speaker's level but not the reference's. The canceller has to re-adapt. Step 2 measures which way it is, and step 3 how quickly the candidates recover.

RecordStuff's own sound is excluded from capture. It only plays the countdown before the recording starts, so it is not an issue in the recording.

### The canceller: candidates, cheapest first

- **C1 — WebRTC AEC3, echo cancellation only.** Through `webrtc-audio-processing` with noise suppression, gain control and every other stage off, at 48 kHz on the microphone's single channel, fed the system track (summed to mono) as the reverse stream.
- **C2 — AEC3 with a gentler suppressor.** The same, with the suppressor tuned through `experimental-aec3-config` toward keeping the voice during double-talk (P5).
- **C3 — our own offline canceller, only if C1 and C2 fail.** Two passes, a full-band linear adaptive filter (a frequency-domain block filter), delay and drift estimated over the whole recording, residual suppression only where the far end is active and the near end is not. AEC3's linear filter may cover only the lower band (about 0–8 kHz), with higher frequencies handled by suppression gains only. This is not yet verified and is measured in step 3 by band. If it holds, echo above 8 kHz can only be suppressed, not subtracted, and that is where C3 could do better.

The smallest candidate that passes the gates is adopted (shared requirement: small ownership). C3 is written only if C1 and C2 fail for a reason C3 addresses.

### Rejected alternatives

- **macOS voice processing (VoiceProcessingIO, `setVoiceProcessingEnabled`).** It lives in live I/O and cannot process recorded tracks. It ducks other apps, and it brings its own noise suppression and gain control. That breaks P2 and P4.
- **Windows communications streams or voice-capture DMO.** Same objections, and editable recordings are macOS only.
- **Machine-learning echo removal.** Unpredictable on music, larger, with less clear licensing and harder to bound. Reconsider only if C1–C3 all fail and the maintainer asks.
- **Noise suppression as an echo fix.** It does not remove speaker echo (OBS forum consensus) and breaks P4.

## Measurement: automated, then the maintainer's ear

Three stages. The first two run without anyone at the Mac; the third is the maintainer's review.

| Stage | Where | What makes the echo | Who |
| --- | --- | --- | --- |
| **A. Simulated** | Any machine, CI included | A simulated room: the far end convolved with a room impulse response, plus a little clipping as a small speaker's distortion | Automated |
| **B. Real speakers** | The Mac, a desktop round | The Mac's own speakers and microphone | Automated (the desktop is only needed for the speakers and microphone) |
| **C. Listening review** | The Mac | Stage B's recordings | The maintainer |

### The material, made by the tools

Nothing is downloaded or recorded by a person. Each run generates its material, deterministically from a seed:

- **Voices** from macOS's speech synthesis (`say`, writing to a file): Mandarin (Taiwan) and English voices, several speakers, short scripted sentences. They stand in for the user's voice and for a voice in a video or call.
- **Music** synthesized by the tool: chords with harmonics up to 16 kHz, percussive transients and a bass line, so low, high and sudden sounds are all present.
- **Tones** from the existing fixture v2 for per-band figures.
- **A script** of segments with known boundaries: silence, far end only (sound playing, nobody talking), near end only (talking, nothing playing) and double-talk (both).

### How the answer is known in advance

Echo removal is judged by comparing its output with what it should have produced. To know that, the echo and the voice are made apart and summed:

- **Stage A.** The voice is the generated speech; the echo is the far end through the simulated room; the microphone is their sum. The ideal output is exactly the voice.
- **Stage B.** Two automatic recordings through RecordStuff's engine, as editable recordings with the microphone on:
  1. **Echo take:** the far-end material plays through the Mac's speakers. The microphone records only the echo; the system track records the reference.
  2. **Voice take:** the maintainer reads sentences a guided page shows, at their normal level and distance, while nothing plays (the maintainer's choice of 2026-10-29, replacing the voice material on the speakers: played by them, the voice's level would be the material's, and G0 would only compare two levels the harness set). Its microphone track is used as "the voice as this microphone hears it in this room"; it holds no far end, so it cannot cancel the voice. One reading serves every echo take of the round.

  Double-talk is the sum of the two microphone tracks, aligned on the session clock, with the echo take's system track as the reference. The voice take's microphone track is the ideal output.

This needs no second device, and the person talks once, about 20 seconds, guided by the page; everything else is automated. The echo and the voice are recorded apart and summed, which is not a real conversation, but the question being measured (whether the canceller removes the far end and keeps everything else) is the same.

### Metrics

Computed per segment, per band (125 Hz–1 kHz, 1–4 kHz, 4–8 kHz, 8–12 kHz, 12–16 kHz), as medians and 95th percentiles over 20 ms frames:

- **Echo removed** (ERLE): in far-end-only segments, the microphone's energy before processing over its energy after, in dB. Also how fast: from the first far-end sound, or a volume change, until ERLE stays above 15 dB.
- **Nothing changed without echo:** in near-end-only segments, the energy of (output − input) relative to the input.
- **The voice kept during double-talk:** compared with the ideal output, the voice's level loss per frame where it is active, and dropouts (frames attenuated by more than 10 dB).
- **Cost:** real-time factor on one thread of the reference M1 Pro, memory added, size added to the app, export and cancel time.

### Testing the test

Before measuring any canceller, the analyzer must recover known answers, as unit tests in CI: a simulated echo with a known fraction removed must read within 0.5 dB of the known ERLE; a pass-through "canceller" must read 0 dB ERLE and no change to the voice; one that outputs silence must fail every voice metric; a deliberately damaged voice (frames attenuated by 12 dB, a 4 kHz low-pass) must be caught.

### Conditions

| Condition | Stage | Role |
| --- | --- | --- |
| Simulated rooms: small, medium, reverberant; clean and slightly distorted speaker | A | Gates G1–G3 |
| **Primary:** built-in speakers and microphone, output volume 50% and 100% | B | Gates G0–G4 |
| Output volume changed during the take; the system muted for a stretch | B | Re-convergence (G1c); the muted stretch is reported |
| Headphones, or speakers off (no echo) | B | G4, do no harm |
| A USB microphone or external speakers, if connected | B | Reported only |

The harness sets the output volume itself (and restores it afterwards). Each stage B condition runs three times; the median run is reported, with the worst.

### Gates (proposed, frozen at D1 before step 3)

| Gate | Threshold (proposed) |
| --- | --- |
| **G0** problem real | In stage B's primary condition, the raw echo in the microphone is no more than 30 dB below the voice's level. Otherwise the problem is too small: stop. |
| **G1a** echo removed | Median ERLE ≥ 25 dB in far-end-only segments after convergence, for speech and for music, in stage A and stage B's primary condition |
| **G1b** by band | ERLE ≥ 15 dB in every band from 125 Hz to 12 kHz |
| **G1c** quickly | ERLE above 15 dB within 2 s of the first far-end sound and within 2 s of a volume change |
| **G2** nothing changed without echo | With nothing playing, (output − input) at least 40 dB below the input, level within ±0.5 dB |
| **G3** voice kept | In double-talk, median voice level loss ≤ 1 dB and 95th percentile ≤ 3 dB; no more than 1% of voice-active frames attenuated by more than 10 dB |
| **G4** no harm | Takes without echo meet G2. In the export, the system's samples entering the mix are identical with the feature on and off (a null test in the engine's tests). |
| **G5** cost | At least 20 times real time on one thread (an hour of microphone in at most 3 min), at most 64 MB peak memory added, at most 5 MB added to the packaged app, export cancel still within 2 s at p95, macOS and Windows CI builds pass |
| **G6** the maintainer's review | In stage C, the maintainer judges that the echo is clearly reduced and the voice is not made worse |

Stop rules:

- **Stop 1, after step 2:** G0 fails. The problem is too small; record the evidence and close.
- **Stop 2, after step 3:** no candidate passes G1–G3 and G5. Close with the evidence.
- **Stop 3, after step 6:** the maintainer judges in stage C that it does not really help. Remove the switch and close with the evidence.

### Stage C: the listening review

Only when stages A and B pass. The tool builds a listening set from stage B's recordings, for each condition and material:

| Clip | What it is |
| --- | --- |
| 1. Voice alone | The ideal: the voice with no echo |
| 2. Raw microphone | The voice with the speaker's echo, as recorded today |
| 3. Echo removed | The same microphone after echo removal |
| 4. The mix without removal | What an export sounds like today: system plus raw microphone |
| 5. The mix with removal | What an export sounds like with the switch on |
| 6. Echo alone, before and after | Far end only, so what remains of the echo can be heard on its own |

The clips are labelled, not blind. A short guide (a page of the listening set, a README or a printed list) says what each clip is, what to listen for (the echo in pauses, the voice's clarity and loudness during double-talk, artefacts such as warbling or words cut off) and each clip's measured figures, so what is heard can be checked against the numbers. The maintainer can also record a short editable recording of their own and compare the edit view's switch on and off. The maintainer's verdict is G6.

## Decisions

- **D1 — freeze the gates.** Before step 3, the maintainer accepts or adjusts the thresholds above. After that they do not change for this plan.
- **D2 — the reference when the system was muted.** Proposal: use the recorded system track, with no removal over stretches recorded muted or at 0%, as the edit view says. The alternative is to record a separate full-level reference track, which changes the editable format (`rsed`) and disk use. Decided from step 2's data.
- **D3 — AAC or lossless. Answered 2026-10-29: keep AAC.** The tracks are AAC at 256 kbps, and coding noise may limit how much echo can be subtracted. The maintainer chose to keep them so: no lossless microphone or reference is added to the editable format, whatever step 3 finds. Step 3 runs the candidates on AAC versions of the takes, as the app's files hold them; the lossless comparison is dropped. If AAC is what keeps a candidate from a gate, that is recorded as the reason, not a new option.

## Steps

- [x] **0. Start.** Inspect the current tree and 087's closure record. Pin the reference revisions again if they changed. Start `caffeinate -d -i -t 5400` before the first desktop round, per [AGENTS.md](../AGENTS.md). *Done 2026-10-29:* Cap's head had moved to `af9a65a9`; its desktop crates still have no echo cancellation, `mic.aac` and `system.ogg` stay apart, Studio Sound is RNNoise at wet 0.9, and the web recorder's constraints are as described, so the table is re-pinned. `webrtc-audio-processing` is still 2.1.0. `caffeinate` was started.
- [x] **1. The test tools, before any canceller.** The material generator (voices from `say`, synthesized music, fixture v2 tones, the segment script); the room simulator; the double-talk builder with its ideal output; the analyzer and its JSON report; the "testing the test" cases as unit tests. Document the commands under [tooling](../docs/system-design/tooling.md). *Done 2026-10-29:* `pnpm echo:bench` (`material`, `analyze`, `baseline`), documented as the [echo-removal bench](../docs/system-design/tooling.md#echo-removal-bench). The voice's G3 is judged per band as well as over the whole band, since a 4 kHz low-pass barely moves the full band; ERLE takes the input's noise floor off both sides. On the 15 stage A conditions generated with `say` voices, no canceller fails G1 everywhere (ERLE 0.0 dB) and a perfect one passes every gate (ERLE 59–66 dB); the echo sits 5.7–8.9 dB below the voice.
- [x] **2. Real speakers, raw, and G0.** *Runner written on 2026-10-29: `pnpm echo:record` ([real-speaker echo round](../docs/system-design/tooling.md#real-speaker-echo-round)). First round 2026-10-29 17:27–17:50, after the maintainer's “好了”, on the maintainer's choice of devices (external speakers on the headphone jack, the BenQ monitor's USB microphone; not the plan's built-in pair), three runs, PASS, cleanup complete: G0 passes (echo against the read voice, medians: speech −16.2 dB at 50%, +3.0 dB at 100%; music −33.6 and −11.8 dB); the system's sound is captured before the output volume (reference −27.0/−20.0 dB at both volumes) and before the mute (−20.3 dB muted against −19.6 dB); muted throughout, no echo above the floor. Caveats: the maintainer read as loudly as possible (optimistic for G3), changed the output volume during run 1's speech at 50% (+1.0 dB, discarded by the median), and the BenQ microphone appears to gate its own noise (floor about −85 dBFS) and to attenuate music more than speech. Second round, the plan's primary condition, 2026-10-29 17:52–18:15, after a new “好了”: the MacBook Pro's speakers and microphone, the lid open, the reading at the maintainer's normal level (22.4 dB over the room's quiet), three runs, PASS, cleanup complete. **G0 passes clearly**: echo against the voice, medians (worst run): speech −6.8 (−6.8) dB at 50% and +5.8 (+5.5) dB at 100%; music −11.4 (−11.4) and +3.0 (+2.6) dB; the step to 100% −1.9 dB; muted throughout, no echo above the floor in two runs, and in run 1 a room sound about 5 dB over the floor between 4 and 14 s (per-second levels; not the speakers, which stayed muted). Again captured before the output volume and before the mute (reference −20.3 dB muted against −19.6 dB; the microphone's echo 13–15 dB lower while muted). **D2 is settled by this**: the system track holds the reference whatever the output volume or mute, and editable recordings record every input at 100% (plan 097), so the recorded system track is the reference. This round's takes (`/tmp/echo-096-c/conditions`, local only) are step 3's stage B material; the first round's are kept as a second device pair.* After the "好了" handoff (the harness plays sound and takes the speakers and microphone), stage B records the conditions without any canceller: the echo level (G0), whether system audio is captured before or after the output volume, and data for D2. The harness restores the volume. **Stop 1** if G0 fails.
- [ ] **3. Offline bench of candidates.** D1 is frozen first. C1 and C2 through `webrtc-audio-processing` (licenses, macOS and Windows CI builds, size) in a bench under [native/capture](../native/capture), run on stage A and on step 2's recordings, as AAC (D3). Every metric per condition and per band, including AEC3 above 8 kHz. C3 only if C1 and C2 fail for a reason it addresses. Adopt the smallest candidate that passes G1–G3 and G5. **Stop 2** if none does.
- [ ] **4. Integration into editing.** The scene field, its validation and undo; the worker's processed preview with progress, cancel and finite buffers; the canceller before the mix in [render.rs](../native/capture/src/edit/render.rs), the system path untouched; the switch in the edit view, absent or unavailable with its reason where it cannot apply, Windows included. Tests: the wrapper's pure tests (determinism, bounds, silence, a missing reference), the engine's null test (G4), the scene's validation, and UI behaviour tests of the switch and its states (no design values).
- [ ] **5. Stage B through the app.** After the "好了" handoff, on a fresh signed bundle: the harness makes editable recordings through the app in the conditions, exports them with the switch off and on, and measures the exports (G1–G4) and the export and preview time (G5). Restore settings, close the app and confirm its processes exited.
- [ ] **6. Stage C, the maintainer's review.** Build the listening set and its guide from step 5's recordings and hand it over. The maintainer listens, optionally tries an editable recording of their own, and gives the verdict (G6). **Stop 3** if it does not really help.
- [ ] **7. Document and close.** [editing](../docs/system-design/editing.md), a new section in [audio quality](../docs/system-design/audio-quality.md) with the method, results and limits, [design decisions](../docs/system-design/decisions.md) (the adopted dependency, the rejected alternatives and why), [third-party notices](../website/THIRD_PARTY.md), help and README text if the switch ships, translations, the verification record and the plan index. If a stop rule ended the plan, record the evidence and the reason instead, so the question is not reopened without changed conditions.

## Gates and completion

The plan completes in one of two ways:

- **Shipped:** G1–G5 pass with the chosen candidate through the app on a fresh signed bundle, and the maintainer's review (G6) confirms it. The switch is off by default, applies only to the microphone of editable recordings, and never changes the recording or the system's sound. The limits are documented: muted stretches, plain recordings and Windows.
- **Not shipped:** a stop rule applies. The evidence, the thresholds and the reason are recorded in verification and design decisions. No partial feature is left in the app.

## Verification

- Step 1: the test tools' unit tests (`pnpm test:scope` on the new scope, or its Node tests if it lives in `scripts/`).
- Steps 3–4: `cargo test` in `native/capture` (the wrapper's tests, the null test, and the bench as an ignored test), `pnpm test:scope -- editing`; `pnpm check`, because the engine, export and edit contract change; macOS and Windows CI for the build.
- Steps 2, 5 and 6: desktop rounds after the "好了" handoff, with the [native acceptance skill](../.agents/skills/native-acceptance/SKILL.md) for app operations. Serialize `out/` and `dist/` consumers; one owner for the desktop and audio. Restore the output volume and settings and clean up after each round.
- Report separately: automated results (stages A and B), the maintainer's verdict (stage C), and what remained unverified (Windows is not covered by this feature; USB microphones and external speakers only if they were connected).

## Execution and closure contract

Follow the [plan index](README.md) for order, decision points, desktop handoff and closure. D1 must be answered before step 3. A stop rule pauses for the maintainer's confirmation, then the plan closes with its evidence. No commit, push, PR or release is part of this plan unless requested.
