# 098 — Every sound heard when an editable recording is played

[English](098-editable-mixed-sound.md) | [繁體中文](098-editable-mixed-sound.zh-TW.md)

Status: planned; not started. Created: 2026-10-27 at the maintainer's request. Hard dependencies: none open. It changes the file layout of the closed 087 (editable recordings) and the edit view's preview of the closed 085 and 087. Execute in order under the [plan index](README.md). This task writes the plan only. Nothing below has been implemented, measured or verified.

## Goal and current state

The maintainer found (2026-10-27) that an editable recording made with both system sound and the microphone plays without the microphone: from the Recordings tab, in the full-screen viewer, and in QuickTime or any other player. The microphone is heard only in the edit view, and in the export. Right after recording, every sound recorded should be heard.

Current state ([editing: editable recordings](../docs/system-design/editing.md#editable-recordings)):

- **One MP4, a sound track per input.** With both inputs on, the engine writes the system's sound as the first sound track and the microphone as the second ([session.rs](../native/capture/src/mac/session.rs), `Sound::System, Sound::Microphone`). Each input has its own single-input mixer and AAC encoder ([core](../native/capture/src/core/mod.rs), `AudioState::route`).
- **Only the first track of each kind is enabled** ([mp4.rs](../native/capture/src/mux/mp4.rs), `write_trak`). The second sound track is a disabled alternate. Players play one sound track at a time; QuickTime and Chromium do not sum two enabled tracks, so enabling both would not help.
- **The edit view hears both** because it copies the second sound into a preview file, plays it beside the video and sums them in Web Audio ([edited-playback.ts](../src/renderer/player/edited-playback.ts)). The Recordings tab's player plays the MP4 alone ([dialogs.tsx](../src/renderer/settings/tabs/library/dialogs.tsx)).
- 087's design (design decision: "Any player shows the screen with the first sound before an export") chose one file with alternates for recovery and for any player to open. A track holding both inputs mixed, as OBS writes with multi-track recording, was not considered in its record. The muxer's own comment already speaks of "the microphone's track beside the mixed one".

The goal: an editable recording with both inputs plays the system's sound and the microphone together everywhere it is played, at the volumes set while recording, while the edit view keeps each input apart for its own volume.

## Design (proposed)

### The file: a mixed track first, the inputs after it

With two sound inputs, an editable recording gets three sound tracks:

| Track | Holds | Enabled |
| --- | --- | --- |
| Sound 1 | Both inputs mixed, exactly as a plain recording mixes them: summed at unity gain, softly limited past −1 dBFS ([mixer.rs](../native/capture/src/core/mixer.rs)) | Yes: what every player plays |
| Sound 2 | The system's sound alone | No, an alternate |
| Sound 3 | The microphone alone | No, an alternate |

- With one input (only the system or only the microphone) nothing changes: the one track is that input, and there is nothing to mix.
- **The engine.** In `AudioState`, with `separate` and more than one input, each input's samples go to two mixers: the shared mixer of track 0 and its own on track `1 + input`. Each mixer has its own AAC encoder; the tracks start together and are cut together at stop, as today's tracks are. No new thread, queue or timer.
- **The description.** `rsed` version 2 adds that the first sound track is the inputs' mix, and `sounds` keeps naming the separate tracks in order (exact shape fixed in step 1). [editable.ts](../src/shared/editable.ts) and the engine's reader accept versions 1 and 2. Version 1 files (made before this plan) stay editable and play as they do now.
- **Older app versions** read a version 2 file as an ordinary recording (their parser requires version 1). It plays with both sounds; its Edit… is the plain cut (085). Step 1 checks that this does no harm to a file with three sound tracks, or records what it does.

### The edit view and the export

- **The preview.** For a version 2 file, the worker copies both separate sound tracks into preview files (today only the second), and the page plays both beside the video. The video's own sound (now the mix) goes through `EditMix` at gain 0, so the player's volume and mute stay the master control and the mix is never heard twice. The full-screen viewer's edit (`PlaybackEdit`, `PREVIEW_URL`) takes the same. Version 1 files keep today's path.
- **The export.** [render.rs](../native/capture/src/edit/render.rs) takes the sound tracks the description names and never the mix, so the scene's volumes apply to each input as now.
- **The Recordings tab** needs no change: its player plays the enabled track, which now holds both sounds.

### Not in this plan

- **Plain recordings** already have one mixed track and are unchanged.
- **Windows** has no editable recordings.
- **Version 1 recordings in the Recordings tab** still play without the microphone. Playing them with both would need the edit view's preview copies on every play (D2).

### Rejected alternatives

- **Enabling both sound tracks.** Players play one; nothing changes.
- **Putting the microphone first.** Moves the problem to the system's sound.
- **Only the app's player mixes the two tracks.** Fixes the Recordings tab and the full-screen viewer but not QuickTime, Finder's preview or a file sent to someone else, and needs a copy of the second track before each play. Kept as the fallback if the cost gate fails.

## Cost: what is measured and the gates

The mixed track adds one input-summing mixer and one AAC encoder at 256 kbps to a recording. Nothing is added to the picture or the camera, so VideoToolbox's encoder service should not change.

**Expected, from recorded figures** (reference M1 Pro, 30 fps; tooling guide [pipeline baseline](../docs/system-design/tooling.md#pipeline-baseline) and 087's [closure](../docs/verification/history-2026-10.md#plan-087-closure--2026-10-25)):

- AAC encoding alone took 2.4 ms a second (silence) to 5.3 ms (music) in plan 091's benchmark, 0.24–0.53 points of one core. The mixer's summing is far less.
- Expected increase: about 0.3–0.8 points of one core. The editable recording's 19.2% of a core (087, camera and microphone on) would become about 19.5–20.0%, 1.40–1.44 times the direct mode's 13.9%, within 087's 1.5× budget. The reference machine has ten cores, so this is under 0.1% of the whole machine.
- Disk: 256 kbps, about 1.9 MB a minute (087 measured 1.8 MB a minute per sound track), on 087's 125 MB a minute with the camera, about 1.5%.

**Metrics and gates** (proposed, frozen at D1 before step 2):

| Metric | How | Gate |
| --- | --- | --- |
| **M1 — the engine's CPU added by the mixed track** (the primary figure) | `pnpm bench:editable -- --repeat 3` with a new pair of modes, `editable` with and without the mixed track (a development-only engine switch), alternating, 60 s each, synthetic 1080p30 capture with a 720p camera and two inputs; the engine's process, median | ≤ +1.0 point of one core |
| **M2 — the app's recording CPU** | `pnpm measure:cpu -- --camera preview=0 --skip-settings --skip-playback --minutes 1 --repeat 3`, direct and editable back to back, the signed bundle, camera and microphone on, 30 fps | Editable ≤ 1.5× direct (087's budget); compared with 087's 19.2%, reported |
| **M3 — disk** | A minute's file, both modes in M1 | ≤ +2.5 MB a minute |
| **M4 — memory** | The engine's resident memory in M1, the app's in M2 | ≤ +16 MiB |
| **M5 — encoder service** | VTEncoderXPCService in M1 and M2 | Reported; expected unchanged |

M1 is the gate because it isolates the change: both modes run in one benchmark, alternating, on the same synthetic capture and without a desktop. M2's day-to-day drift is about a point at 30 fps (plan 084's record), larger than the change, so M2 confirms the budget and does not measure the change itself.

**Correctness**, judged with the cost:

- The mixed track is as long as the separate tracks (within one AAC frame, 21.3 ms), starts with them, and with the synthetic inputs' two tones holds both at their levels within 0.5 dB.
- `pnpm verify --sync` on a real recording judges the mixed track's A/V offset and drift within the existing thresholds.
- The export of a version 2 file with the microphone at 50% equals, within the AAC tolerance the engine's tests already use, the export of the same inputs without the mixed track.

**Stop rule:** if M1 exceeds its gate, or the mixed track cannot be kept in step with the separate tracks, pause and report to the maintainer with the figures. The options then are to accept the cost, or the app-player-only fallback.

## Decisions

- **D1 — freeze the gates.** Before step 2, the maintainer accepts or adjusts the gates above.
- **D2 — version 1 recordings in the app's player.** Proposal: leave them as they are (their export holds both sounds). The alternative is the app-player-only fallback for version 1 files.

## Steps

- [ ] **0. Start.** Inspect the current tree, 087's closure and the editable design. Confirm where track order is assumed: the engine's `edit::source` and `render`, the worker's extraction, `editing.ts`'s preview tracks, the Recordings tab's reading of `rsed`, `pnpm acceptance:editor`'s track checks and `bench:editable`'s judging. Start `caffeinate -d -i -t 5400` before the first desktop round, per [AGENTS.md](../AGENTS.md).
- [ ] **1. The description and older versions.** Fix version 2's shape; the parsers in TypeScript and Rust accept versions 1 and 2, and their tests cover both and reject a malformed one. Check what 3.0.0 does with a three-sound-track file (plays, cut, export) and record it.
- [ ] **2. The engine.** D1 frozen first. The mixed track in `AudioState`, the mux's alternates (only the mixed sound track enabled), the description, and the development switch that leaves the mixed track out for M1 (removed by `scrubbedEnv`, refused by the runners, as plan 091's switches). Engine tests: three sound tracks with both inputs, one with one input, lengths, the mix's levels, an interrupted recording's tracks. `bench:editable` gets its new pair of modes. Measure M1, M3, M4 and M5. **Stop rule** here.
- [ ] **3. The edit view and the export.** The worker copies both separate tracks; the preview and the full-screen viewer play them with the video's sound at gain 0; `render` reads the named tracks. Version 1 files keep their path. Tests: `editing`'s scope, the engine's `edit::` tests with both versions, the export's null comparison above.
- [ ] **4. The app.** After the "好了" handoff, on a fresh signed bundle: M2; `pnpm acceptance:editor` (updated for three sound tracks and both preview copies); a real editable recording with both inputs played in the Recordings tab and, through `pnpm acceptance:playback`, in QuickTime, the microphone heard in both (measured, not only listened to: the microphone's tone or voice present in the decoded enabled track); `verify --sync`. Restore settings, close the app and confirm its processes exited.
- [ ] **5. Document and close.** [editing](../docs/system-design/editing.md) (the file, the preview), [design decisions](../docs/system-design/decisions.md) (the editable row: the mixed track, its cost), the tooling guide's [`bench:editable`](../docs/system-design/tooling.md#export-benchmark) section and baseline, the verification record with M1–M5, translations, this plan's removal and the index.

## Verification

- Steps 1–3: `pnpm test:scope -- editing engine-file engine-core` while working; `pnpm check` before step 4, because the engine's file, the description contract and the edit view's preview change.
- Step 2: `pnpm bench:editable` needs no desktop.
- Step 4: desktop round after the "好了" handoff, with the [native acceptance skill](../.agents/skills/native-acceptance/SKILL.md); serialize `out/` and `dist/` consumers; one owner for the desktop and audio.
- Report separately: automated results, measured costs against their gates, what was heard or measured in which player, and what stayed unverified (players other than QuickTime and Chromium; 3.0.0 reading a version 2 file if step 1 could not run it).

## Execution and closure contract

Follow the [plan index](README.md) for order, decision points, desktop handoff and closure. D1 must be answered before step 2. The stop rule pauses for the maintainer. No commit, push, PR or release is part of this plan unless requested.
