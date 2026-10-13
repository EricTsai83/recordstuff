# 072 — Renderer CPU during in-app playback

[English](072-playback-cpu.md) | [繁體中文](072-playback-cpu.zh-TW.md)

Status: planned; investigation not started. Created: 2026-10-13. Priority: next. Hard dependencies: none. Execute the steps in order under [the plan index](README.md).

## Goal and boundaries

Find out why one renderer uses about 75% of a core while RecordStuff's own player plays a recording, and bring playback to a level comparable to hardware-decoded playback elsewhere, or record why it cannot. Success is a named cause backed by evidence, a fix or a written limitation, and a playback figure measured on the same file before and after.

This plan covers the in-app players (the Recordings tab's player in Settings and the full-screen video window). It does not change recording, encoding or the output format unless step 3 shows that the file format is the cause; in that case the recording change becomes a decision point for the maintainer, not part of this plan. It does not loosen the existing [CPU budget](../docs/system-design/tooling.md#cpu-budget).

## Current evidence

Observed on 2026-10-13 on the maintainer's Mac with the installed packaged app (version from `/Applications/RecordStuff.app`, not a development build):

- While a recording played in the app, Activity Monitor and `top` showed renderer PID 40051 at 74–77% CPU. The GPU process (29546) was at 1.5% CPU and 3.0% GPU, the audio service at 0.5% and main at 0.2%. Nothing was recording: main held the file open read-only and its size had not changed since 13:26.
- After pausing, the same renderer dropped to 0.0% and everything else stayed at or near 0. So the load comes from playback, not from a timer or a leftover idle renderer.
- The renderer had run 3 h 48 min with 19 min 14 s of CPU time (about 8% on average), so the high load started recently, consistent with playback.
- File: `~/Movies/RecordStuff/2026-10-13 11-05-02.mp4`, 3.14 GB, 8467.5 s; H.264 **Baseline** profile, level 4.0, yuv420p, BT.709 TV range, 1920×1080, no B-frames, about 3.46 Mbps, time base 1/62500, average frame rate about 19.8 fps (variable); AAC about 63 kbps.
- A `sample` of the packaged renderer had no usable symbols, and its main-thread sample counts include waiting, so it does not show which thread or code is busy.
- With hardware decoding, Chromium decodes in the GPU process. A busy renderer next to an almost idle GPU process suggests software decoding in the renderer, but this has not been confirmed. Other candidates: per-frame compositing or repainting caused by effects over the video (for example `backdrop-filter` at `src/renderer/ui.css:1289` and the dialog overlay's `backdrop-blur`), page work driven by playback (`timeupdate` in `src/renderer/player/player.tsx`, the Recordings card preview's `requestAnimationFrame` loop in `src/renderer/settings/tabs/clip-preview.tsx`), or the media protocol serving ranges.
- It is not known which player window PID 40051 was (Settings, or the full-screen page waiting beside it), or whether the full-screen window behaves the same way.
- No playback scenario exists in `pnpm measure:cpu` or its budget, so this cost could not have been caught.

### Long recordings saved fragmented (added 2026-10-13)

The maintainer then reported that a long recording made that day plays with more CPU than shorter ones. The two recordings of 2026-10-13 differ in structure, not just length:

| File | Length | Top-level boxes | `finalize timing` in `~/Library/Logs/recordstuff/recordstuff.log` |
| --- | --- | --- | --- |
| `2026-10-13 09-45-57.mp4` | 16 min 53 s, 211 MB | `ftyp`, `mdat`, `moov` (plain) | `finalize 32 ms to plain MP4` |
| `2026-10-13 11-05-02.mp4` | 2 h 21 min, 3.14 GB | `ftyp`, `moov`, then 8,057 `moof`/`mdat` pairs (fragmented) | `finalize 0 ms kept fragmented (track 1 goes back to 0, before its last sample)` |

- The long file's last fragment (at byte 3,140,040,590) has an audio `traf` (track 1, timescale 48000) with **0 samples and `tfdt` 0**, beside a video `traf` with 8 samples. The fragment before it had audio at `tfdt` 406,388,735 (8,466 s). This looks like the capture host's final flush at stop writing an empty audio run.
- `FragmentIndex.readFragment` in `src/main/recording/mp4-finalize.ts` calls `align` with every `traf`'s `tfdt` before it looks at the sample count. `align` throws `goes back to 0`, so the whole save falls back to fragmented. An empty `traf` adds no sample, so its decode time should not be checked.
- [Plain MP4 at save](../docs/system-design/recording.md#plain-mp4-at-save) already records why a fragmented file is expensive in Chromium: a player reads every fragment's header (1,722 range requests and 358 MB for 2,106 fragments on 2026-10-10, repeated by every open, the seek bar's frame preview and the full-screen window), and AVFoundation cannot open it at all. This file has almost four times as many fragments. That explains the slower opens; whether it also explains the CPU **during** playback still has to be measured.
- Whether the empty audio run appears only on long recordings or at random at stop is not known. Only these two recordings of the day were inspected; earlier ones were not.
- Files already saved fragmented stay that way: nothing rewrites them.
- The maintainer also reported two symptoms on the long file: the picture stays black noticeably longer before the first frame, and the seek bar's hover thumbnail does not appear. Both match the fragmented-file cost above: the frame preview is a second video element that must read every fragment's header before it can seek. Step 1 measures first-frame time and thumbnail time on the fragmented file and its plain copy.
- Same day, a plain copy made with `ffmpeg -c copy` (`2026-10-13 11-05-02 plain.mp4`, same media) played in the app with the renderer at **6.1%** instead of 74–77%, the GPU process at 9.3% CPU and 5.6% GPU instead of 1.5% and 3.0%; the maintainer reported that it opened and responded very fast. The work moved from the renderer to the GPU process, which suggests the fragmented file was decoded or demuxed in the renderer and the plain file uses the hardware path. So the container is the main cause; step 2 still confirms the decoder names. Read from Activity Monitor screenshots, not with the CPU sampler.

## Investigation sequence

### 0. Save the empty final fragment as a plain MP4

- [ ] In `FragmentIndex.readFragment`, skip the `tfdt` check for a `traf` whose `trun`s hold no samples, so an empty run neither aligns nor fails its track. Add a case to `mp4-finalize.test.ts` with a final fragment whose audio `traf` is empty with `tfdt` 0, and keep the existing packet comparison passing.
- [ ] Run the finalization over a copy of `2026-10-13 11-05-02.mp4` (the indexing works on a file already written; do not modify the original) and confirm the result is plain, its packets match the original with ffmpeg `framemd5` apart from corrected durations, ffprobe's length is unchanged, and AVFoundation opens it.
- [ ] Count how many saved recordings in the output folder are fragmented and how many of their `finalize timing` lines give this reason, to tell whether it depends on length. Report the count; do not rewrite the user's files. Whether to offer a repair for already saved fragmented files is a decision for the maintainer.

Deliverable: new recordings no longer stay fragmented because of an empty final audio run, and the plain copy of the long file is ready for step 1.

### 1. Reproduce and measure the baseline

- [ ] With a development build, play the same file (or a copy) in the Settings player and in the full-screen window, each for at least 60 s after a 10 s warm-up. Measure each process by Chromium role with the [CPU sampler](../docs/system-design/tooling.md#cpu-budget), not `ps`. Record pause and playback separately.
- [ ] Note which renderer holds the player and whether the full-screen page waiting hidden beside Settings also uses CPU.
- [ ] Reference: play the same file in QuickTime Player and in Chrome (one tab, `file://` or a local server), and measure each one's CPU.
- [ ] Compare the long file fragmented with its plain copy from step 0: same media, so any CPU difference comes from the container. Repeat with the short plain recording `2026-10-13 09-45-57.mp4`, and with a file re-encoded to H.264 High profile at a constant frame rate (`ffmpeg … -profile:v high -r 30`), to separate file properties from the player.

Deliverable: a table of player × file × process CPU, with the reference players.

### 2. Determine the decoder path

- [ ] In the development build's DevTools Media panel (or `chrome://media-internals` in Chrome), record `kVideoDecoderName`, `kIsPlatformVideoDecoder` and any fallback messages for each file from step 1.
- [ ] If the decoder is a software decoder (`FFmpegVideoDecoder` or another non-platform decoder), find out why the hardware path is refused: profile, level, frame-rate or time-base properties, the app's command-line switches and feature flags (`--enable-features` / `--disable-features` set by main), or the sandbox. Compare against Chrome on the same Electron Chromium version.
- [ ] If the decoder is a platform decoder (VideoToolbox), continue with step 3's rendering branch.

Deliverable: the decoder used for each file and, for software decoding, the reason.

### 3. Locate the cost

- [ ] Software-decoding branch: test the cheapest corrections in order and measure each: a Chromium switch or feature that permits the hardware path, if one exists and is safe; serving the file differently (if the protocol response affects the decoder choice); and only as a last resort, a change to the recording output so new files decode in hardware. The last option changes recording and stops this plan at a decision point for the maintainer.
- [ ] Rendering branch: record a DevTools Performance trace of 10 s of playback. Check the frame-rendering stats (paint flashing, layer borders) for repaints over the video. Turn off one at a time, in the development build only, the blur effects over the player, the control overlay, the card preview's animation loop and playback-driven React state, and measure each change.
- [ ] Do not leave diagnostic flags, logging or style overrides in the product once the cause is known.

Deliverable: the cause, with the measurement that shows it.

### 4. Fix and prevent regressions

- [ ] Make the smallest change that removes the cost, keeping the player's look and behavior. A visual change, such as dropping a blur, needs the maintainer's agreement.
- [ ] Add a playback scenario to `pnpm measure:cpu` (proposed, not yet available): one saved file played in the player for 60 s, judged per role, with a threshold set from the measured fix and the step 1 reference players. Update the budget table and its translation.
- [ ] Add unit or background UI tests only where they check real behavior (for example, that an animation loop stops when the player is hidden). CPU itself is checked by the measurement, not by UI tests.

## Completion criteria and verification limits

Complete when the cause is named with evidence, the fix (or the written limitation) is in place, and the same file's playback CPU before and after is recorded for both players together with the reference players' figures. Missing tools or permissions mean blocked.

Step 0 changes how recordings are saved, so its checks follow the recording rows of the testing policy: the finalization unit tests plus a real recording saved as plain MP4, with a desktop round. Steps 1–3 need desktop rounds with the development app (playback in a visible window, DevTools). Before each one, follow the [readiness handoff](../docs/testing.md#confirm-desktop-handoff-before-testing) and keep a `caffeinate` assertion, as `AGENTS.md` requires. Checks for the fix follow [the testing policy](../docs/testing.md#select-tests-from-behavior): the CPU row (`pnpm check` and `pnpm measure:cpu` including the new scenario) plus the player's background UI scope; a recording-output change, if the maintainer approves one, also needs the recording rows. Audio quality during playback is not judged.

For this plan-writing task only: check links and anchors, existing versus proposed commands, bilingual consistency and `git diff --check`; no tests, build, app launch or recording.

At closure, write the cause and the playback budget into the tooling documentation, record the measurements in verification with translations, update both indexes and remove the plan files under the repository's completion rules. Do not commit, push or publish without a user request.
