# Shared acceptance cases

[English](acceptance.md) | [繁體中文](zh-TW/acceptance.md)

Humans and AI use the same cases and evidence rules. Select the necessary cases using the [testing guide](testing.md); a UI-only change does not automatically require recording. For AI native operation use the [computer-use skill](../.agents/skills/astra-acceptance-with-computer-use/SKILL.md). Scripted, manual and computer-use observations must be labeled separately.

## Prepare a round

Record time, OS/architecture, source SHA and working-tree changes, artifact path, settings and existing app/recording state. During development, you may stop recordings and quit/restart/rebuild RecordStuff as needed without additional confirmation. For normal-bundle acceptance, build and launch with `pnpm start:app`, then verify the running process path. `pnpm open:app` is only for restarting the same artifact within the round. Signing prerequisites and specialized runners are in [tooling](system-design/tooling.md).

For recording smoke, keep the display/audio environment stable and use [test-material.html](../scripts/test-material.html). Record source dimensions, quality/fps, browser, audio output/volume and material version. With manual/native operation, click the page's audio/fullscreen start control; the `pnpm acceptance` runner provides its own autoplay setup. A source-selection test must put the material on the selected source. The shortcut runner's primary-display setup may not cover a different selected source.

## Recording smoke and native cases

One short recording can supply several cases. Required recording smoke covers start/stop/save, media verification and playback. Tray state and Finder actions are additional native cases when affected, or part of an explicitly requested full basic native round. Running a shortcut script does not pass a tray-click case.

| Case | Action and expected observation |
| --- | --- |
| Launch / tray (native) | Open the menu; confirm idle/permission status and relevant actions. Check the intended app, not a duplicate or stale installed copy |
| Start | Start through the selected real user path; confirm recording. Keep the moving material and alternating beeps playing for about 10–15 seconds |
| Recording UI (native) | Check affected recording state, available stop action and locked settings against current requirements |
| Stop / save | Stop once and wait for saved/idle; record the new MP4 path. Preserve Saving if observed; missing the brief transition alone is not failure |
| File reveal (native) | Use the affected notification or Show last recording action. Judge correct Finder selection and foreground separately; retain a failure before trying an alternate route |
| Playback | Open that saved file; play and seek, observe content and advancing progress. Record whether subjective audio listening was actually possible |
| Media verification | Reuse the runner's report for the same file/scope, or run `pnpm verify` as below. Check every judged failure; an audio track alone is not proof of non-silent capture |

Unattended start/stop/save and integrity checks:

```bash
pnpm start:app
pnpm acceptance
```

The second command needs an idle app and normally quits it after saving and verification. Continue playback on the saved file without reopening RecordStuff. For manually recorded fixed material, create a new report directory and use:

```bash
pnpm verify -- /absolute/path/recording.mp4 --test-material --json /absolute/path/report-dir/verify.json
```

Keep output and exit code (1 for fail or incomplete, 2 for blocked). For the current audio contract, the Sample rate/channels check requires 48 kHz / two channels and the separate Channel energy (RMS) check requires RMS above −60 dBFS in both channels. This supports non-silence, not fidelity, channel separation, subjective listening or sync. Missing/n/a evidence is not passing evidence, and neither is a required check that is blocked (a missing tool) or incomplete (too few markers). `--test-material` reports sparse-beep bitrate without judging it; add `--screen` with actual source dimensions, or `--sync` only when that analysis is required and the material supports it. Detailed gates are in [tooling](system-design/tooling.md#measurement-pipeline-and-thresholds).

## Additional cases by impact

| Impact | Observe |
| --- | --- |
| Layout / translations / appearance | Relevant languages, themes, minimum size, clipping and focus state; fixture screenshots suffice for layout within the represented environment |
| Controls / settings persistence | Mouse and keyboard operation of changed controls; close/reopen and restart persistence; restore original preferences |
| Native settings entry | Another app frontmost, open Settings through the affected entry, inspect visibility/focus, close and reopen; script callback alone is insufficient |
| Quality / source / output folder | Choose the affected option through UI, record, and compare actual dimensions/fps/source/destination with the selection |
| Recording locks / allowed changes | While recording, exercise the affected control and verify locking or continued capture as required; stop, save and play |
| Permissions / device recovery / shutdown | Exercise only affected/requested transitions; record refusal, recovery and saved output as applicable. Permission revocation and destructive fault setup need authorization for that specific action |
| Accessibility / OS presentation | Observe affected keyboard/focus behavior; use actual VoiceOver or OS contrast settings when those behaviors are required. DOM assertions cannot establish these outcomes |

Do not routinely reset TCC or claim first-time permissions, hardware removal, long-run stability, install/upgrade or subjective listening from other cases. One narrow exception, authorized by the maintainer on 2026-09-26: when a RecordStuff build under test starts capture, macOS may ask whether RecordStuff may bypass the private window picker and access the screen and audio directly. The round's executor may press Allow on that prompt through native computer use and record whether macOS accepted the input. If macOS ignores synthetic input, leave the prompt open and report it; do not work around it. The exception covers only that prompt for RecordStuff: never answer other permission prompts, change privacy lists in System Settings or edit TCC. Preserve reproduction steps when a case fails. After an authorized fix, rebuild and repeat affected cases, retaining the earlier result.

## Cleanup and evidence

Every complete app round, including failure/cancellation, saves recordings it started, stops material playback, restores preferences, closes owned test UI, normally quits the tested app and confirms process/helper exit. Keep the app closed for the next run. Never use global kill/close-all operations or delete existing user data. Isolated runners clean only their owned processes; the settings-shortcut command is an intermediate entry step, not a full round.

Record pre-existing player windows. Close only the test movie and any Open dialog created by closing it. Quit a player started for the test only if no user documents remain. No app window is not proof of process exit. If save completion or cleanup cannot be confirmed, record cleanup fail/blocked and remaining state; do not rebuild over that process or report full acceptance passed.

Use a unique directory under `docs/verification/measurements/`; do not overwrite prior runs. Save actual screenshots, scoped logs, media paths and runner reports. If tools cannot save a screenshot or hear audio, say so. These raw files are gitignored and unavailable in a fresh clone. Keep a durable conclusion in the [verification index](verification/README.md) and its linked history/release record when worth preserving. For team review, provide sanitized evidence through an agreed accessible attachment/artifact location; do not imply a local link is shared or automatically upload private recordings.

## Report template

Use pass / fail / blocked / not run for selected cases. Keep out-of-scope cases under exclusions as not applicable, with a reason. A waived required case remains not run. Report counts without combining exclusions with passes.

```markdown
# Acceptance — <date / scope>

- Environment: OS/architecture, display, audio output, browser/material version
- Source/artifact: SHA, working-tree changes, build command, bundle/process path
- Execution: manual / computer use / scripted; executor and selected cases
- Original settings and test files:

| Case | Action | Expected | Actual | Status | Evidence |
| --- | --- | --- | --- | --- | --- |

Checks: commands, exit codes, runner report locations; relevant skips
Exclusions: case → not applicable and impact-based reason
Required gaps: not run/blocked case → reason or explicit waiver
Cleanup: saved files, restored preferences, closed UI, final process state
Conclusion: pass/fail/blocked/not-run counts, limited to the observed scope
Evidence availability: local only / accessible artifact location
```

Release acceptance additionally follows the [release guide](system-design/releases.md): record the clean candidate SHA, bind the intended tag to that SHA and write the versioned evidence summary. A later documentation commit is not automatically the tested app source. This guide does not authorize publication.
