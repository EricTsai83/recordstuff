# 099 — Sharing a recording: the right file by default, every version on purpose

[English](099-share-recordings.md) | [繁體中文](099-share-recordings.zh-TW.md)

Status: planned; not started; decisions D1–D8 answered on 2026-10-28. Created: 2026-10-28 at the maintainer's request, rewritten the same day after the maintainer's review to put the experience first. Hard dependencies: none open. It builds on the closed 085 (cutting a recording, export and publication), 087 and 098 (editable recordings and their tracks) and 071 (the Recordings tab). Execute in order under the [plan index](README.md). This task writes the plan only. Nothing below has been implemented, measured or decided yet.

The maintainer's brief (2026-10-28): design the best experience, not the smallest change; people do not know what a track is and just drag what they recorded to someone; some do want the sources, the finished video, or both; work out how the versions of a recording are shared, how they are managed and how sharing looks on screen. Making every recording editable is out of scope (maintainer, 2026-10-28).

## The problem today

Every way a recording leaves RecordStuff hands over the **original file**: dragging its card out of the Recordings tab (`startDrag` in [main](../src/main/index.ts)), Show in Finder, and the saved notification, which opens Finder. For a plain recording never edited, that is right. Otherwise nothing tells the person what they are giving:

| What is shared | What the recipient gets | Risk |
| --- | --- | --- |
| A plain recording that was cut (085) | Every part, including the removed ones: the cut is an edit record in `userData`, never in the file | **High**: privacy, the person believes it is gone |
| An editable recording, edited | The recording as made: removed parts, muted stretches, the hidden camera | **High**: privacy |
| An editable recording, not edited | The screen without the camera's bubble (the camera is a disabled track) | High: not what was meant |
| Any editable recording | The microphone and the full camera picture on tracks VLC or ffmpeg extract | Medium |
| Any editable recording | Twice a plain one's size; the edit does not travel | Low, surprising |

The export, `<name> (edited).mp4`, is the right file there, but it is "a recording of its own, with no link back to its source" ([editing](../docs/system-design/editing.md#edited-recordings)): a second card the person must know to pick, possibly older than the latest edit.

## What a recording is (the model this plan adopts)

A recording has exactly three things, and only two are files:

| | Is | Files |
| --- | --- | --- |
| **Original** | The recording as made, never written (085's rule) | One |
| **Edit** | A state: the edit record (cuts, the bubble's place, volumes, stretches). What the app shows as "edited" is played live from it | None |
| **Saved copies** | Files rendered from original + edit when the person asks, in the form they chose | Zero or more |

What a person drags or shares is a **version**: something produced from original + edit at that moment. A version is not a file the app keeps and manages; it is made into a file when it leaves, in a cache the app owns. So nothing derived has to stay linked to the original, nothing goes stale, and the person never manages derived files.

For reference, the two kinds of recording store their inputs differently, which is why the versions differ:

| | Plain recording | Editable recording |
| --- | --- | --- |
| Camera | Composed into the screen picture while recording; cannot be taken out | A track of its own; the screen picture has no bubble |
| Microphone | Mixed with the system's sound into one track while recording | A mix of both (since 098, the track players play), plus each input on its own track |
| An ordinary player shows | Screen with bubble, both sounds | Screen without bubble, both sounds |

## What the industry does

There is no single standard, but the apps people already know converge on five patterns. This plan follows them.

1. **Non-destructive editing: an original plus a recipe, outputs rendered on demand.** Photos keeps the original and stores edits as modifications; what you see is the modified version, and Export Unmodified Original gives the file as imported ([Macworld](https://www.macworld.com/article/232763/how-to-get-the-best-image-export-from-photos-in-macos.html)). Screen Studio, Camtasia and Final Cut likewise keep a recording or project and render an export from it ([Screen Studio, exporting](https://www.screen.studio/guide/exporting-the-video)).
2. **Sharing defaults to what you see; the original is a deliberate secondary choice.** Photos: Export N Photos renders the edits; the unmodified original is a separate command.
3. **A quick-action surface right after capture**, from which the result is dragged, copied or saved without opening anything: macOS's screenshot thumbnail, CleanShot X's Quick Access Overlay, which saves, copies or drags captures into other apps ([CleanShot](https://cleanshot.com/features)), and Screen Studio's Quick Share widget after a recording, with Share, Save, Copy and Edit ([Screen Studio, Quick Share](https://www.screen.studio/guide/quick-share-widget-)).
4. **Outputs named by purpose, not by technical options.** Screen Studio's Export to File and Copy to Clipboard, its presets; Final Cut's share destinations. Technical settings sit one level below.
5. **The source is told apart from the deliverable.** Project-based apps give the source its own document type (a Screen Studio project, a Camtasia `.tscproj`) so it is not mistaken for something to send. RecordStuff's editable original stays an MP4 that any player opens, a strength none of them has, so here the tell is its name (D3).

## Design principles

1. **What leaves by default is what the person sees in the app.** Edits applied, camera composed, sounds mixed.
2. **Nothing edited away leaves unless asked for.** Privacy is the default.
3. **Versions are named by purpose.** No "track", "alternate" or "stem" in the interface; those words are for the documentation.
4. **Originals and sources are one deliberate step away**, never blocked.
5. **A plain recording never edited behaves exactly as today.**
6. **Every drag has a click and keyboard equivalent**, with VoiceOver names.
7. **The person manages recordings, not derived files.** Derived files are made when they leave and cleaned by the app.

## The versions

| Version | What it is | Offered for | File name when it leaves |
| --- | --- | --- | --- |
| **Video** (default, marked recommended) | What the app shows: edit applied, camera composed where shown, one picture and one sound | Every recording | `Meeting.mp4` (for an unedited plain recording, the original itself) |
| **Sound only** | The Video's sound, mixed | Every recording | `Meeting.m4a` |
| **Video without the camera** | The Video with the camera left out | Editable recordings with a camera | `Meeting (screen only).mp4` |
| **Original** | The file as made, every track | Edited or editable recordings | Editable: `Meeting.recordstuff.mp4` (D3). Plain: `Meeting (original).mp4` |
| **Sources** (under More) | Each track as its own file, copied without re-encoding, for Premiere, Final Cut or DaVinci | Editable recordings | A folder `Meeting sources/` with `Meeting - Screen.mp4`, `- Camera.mp4`, `- System sound.m4a`, `- Microphone.m4a` (those it has) |

**Only the original is marked; everything that leaves is named as a finished file.** This is how project-based recorders and editors name things: Screen Studio and Camtasia give the source a document type of its own and name an export after the project, and open-source editors such as Shotcut export under the project's name ([Shotcut forum](https://forum.shotcut.org/t/batch-export-multiple-projects-automatically/11740)); Photos exports an edited picture under its own name and makes the unmodified original a separate command. A recipient cares what a file holds, not whether it was edited, and "edited" invites the question of what was changed. So:

- A version is named after the recording, localized with the app's language (`會議.mp4`), with a content tag only when it differs from the default form: `(screen only)`, or `.m4a` for sound.
- The editable original is `Meeting.recordstuff.mp4`, on disk from the moment it is saved and when it leaves (D3). A plain recording's original, given deliberately after it was edited, leaves as `Meeting (original).mp4`; on disk it keeps its name.
- **Beside its own source** a saved copy would take the source's name. Only there is the edit named, as an iPhone transferring an edited picture beside its original names it `IMG_E…` ([MacRumors](https://forums.macrumors.com/threads/question-on-iphone-16-pro-max-camera-image-files.2478196/)): a copy saved into the folder of a plain recording named `Meeting.mp4` is `Meeting (edited).mp4`, and its card also says "Saved from Meeting" from the provenance in the file (D8). An editable recording never meets this: its source is `Meeting.recordstuff.mp4`.
- Any other name already taken where the file lands gets a number (`Meeting 2.mp4`). Version numbers such as V1 and V2 are not used: a recipient seeing V2 asks where V1 is and what changed. In the app, a recording lists its saved copies by time and form instead (D4).

The rule a person has to remember is one: **what is marked is the original; everything else can be given.**

"Video without the camera" is shown only for editable recordings, where the camera can be left out; a plain recording's camera is part of its picture.

## Sharing on screen

### 1. Dragging the card (the path most people take)

**The drag gives the Video: what the card plays is what leaves.** ⌥-drag gives the Original. For an unedited plain recording, the Video is the original file, so nothing changes.

A drag must have its file the moment the pointer goes down (macOS), and an edited or editable recording's Video must be rendered (about 6.3 times real time on the reference Mac: a 10-minute recording in about 1.5 minutes). So the Video is **prepared ahead** into the cache (D2): when the edit view closes, and when an editable recording is saved. While it is not ready, the card shows "Preparing video… 40%" over its picture, a drag does not start, and the card says why and that ⌥-drag gives the original (D1). A native file promise (the drag starts, the file is written as it lands) would remove the wait but needs a native module and is not accepted by web apps such as Slack or Gmail in a browser; it is a later option, not this plan.

### 2. Share… (every version, chosen)

**Share…** sits in the card's menu, on the card's hover actions and in the edit view's toolbar. It covers the card's picture with an overlay of tiles, one per version above (the maintainer's direction):

- Each tile shows the version's name and the file name it will produce, and is **dragged** to give that file, or **clicked** for Copy, Save to…, and Share (the macOS share sheet: AirDrop, Messages, Mail).
- The first tile, Video, is marked recommended. Sources sits under **More**.
- Tiles not ready show progress; opening Share starts preparing every version that is not ready, since it is a clear intent.
- Several tiles dragged together give several files at once (`startDrag` takes `files`), which covers sending the finished video with the original or the sources.
- Esc, ✕ or a click outside closes it. Tab moves between tiles, Return opens a tile's actions.
- In the grid a card is at least 272 px wide (picture about 272 × 153): room for three tiles and More. The list layout's picture is too small, so there the same tiles open in a popover anchored to the card.

### 3. Right after recording: a quick-access thumbnail (D6)

When a recording is saved, a thumbnail appears in a corner of the screen for a few seconds, as macOS's screenshot thumbnail and CleanShot's overlay do: drag it to give the Video, click it to open the recording in the Recordings tab, hover for Share…, Edit and Show in Finder. A plain recording is already one composed picture and one mixed sound, so its thumbnail drags at once. An editable recording's Video starts rendering the moment it is saved (D2), at about 6.3 times real time on the reference Mac (a 1-minute recording in about 10 s, 10 minutes in about 1.5 minutes): its thumbnail shows that progress, stays while it renders and for a few seconds after it is ready, and can be dismissed; a drag before then waits as the card's does (D1). It replaces the saved notification's role of leading to the file; the notification remains for people who turn the thumbnail off and when the screen is shared or recording.

### 4. The edit view

The toolbar's **Export** becomes **Share…** (the same tiles, for the edit as it stands) and **Save a copy…**, which asks where and in which form: picture (screen and camera, screen only, none) and sound (mixed), named as above. What is chosen affects only the new file: leaving the camera out of a copy removes nothing from the original, whose camera track stays for the next copy.

### 5. The card says what it holds

- **Editable** keeps its mark, with a tooltip in plain words: "Keeps the picture, camera and sounds apart so you can change them later. To send it, drag it or use Share."
- **Edited** keeps its mark.
- While a Video is prepared: the progress over the picture. No warning appears on a drag that gives the right file.

## Managing what leaves

- **Versions are not managed.** They are made into the cache, keyed by recording, edit revision and version, and reused while the edit is unchanged; an edit makes the next one. The cache has a size limit (D5), removes the oldest first, and is cleared of files whose recording is gone. Dragged files are hard links to the cache under their outgoing names where the volume allows, so a name costs no copy.
- **Saved copies are ordinary files** the person placed. RecordStuff writes into each one where it came from (the source's name and the edit revision, in its `udta`, as `rsed` describes an editable file), so the Recordings tab can say "Saved from Meeting" on a copy saved into the recordings folder even after it is renamed in Finder. No link is stored outside the file, so there is nothing to keep in step.
- **A recording lists the saved copies it has in the recordings folder** (D4): the Recordings tab finds them by the provenance in each file, and the recording's menu lists them by time and form with Show in Finder. A copy moved out of the folder RecordStuff watches, or deleted, is simply not listed; there is no separate log to keep.
- **The editable original is told apart by its name**, `Meeting.recordstuff.mp4` (D3): still an MP4 any player opens, but not taken for the video to send.

## Rejected alternatives

- **A warning dialog on every drag of an edited recording:** people learn to click it away, and it breaks the drag.
- **Grouping saved copies under their recording's card with a stored link:** every rename, move and deletion must be kept in step, and a copy renamed in Finder breaks it. Provenance in the file itself gives the same "Saved from" without that.
- **A `.recordstuff` package for editable originals:** gives up 087's "any player opens it".
- **Version numbers (V1, V2) in file names:** say nothing about content to the recipient.
- **"(edited)" on every version that leaves:** marks the deliverable instead of the source; recipients do not need it and it invites questions. It stays only where a copy sits beside its own source.
- **Making the editable file's enabled picture the composed one:** a second encoder while recording, and still without the edit.
- **Writing the edit into the original:** 085's rule that the source is never written.

## Decisions (answered by the maintainer, 2026-10-28)

- **D1 — dragging a card whose Video is not ready: wait.** The drag gives the Video, what the card plays: an unedited plain recording's original at once; an edited plain recording's cut, and any editable recording's composed picture with the edit and volumes applied, once rendered. Until then the drag does not start, the card shows the progress and says ⌥-drag gives the original.
- **D2 — prepare the Video when the edit view closes and when an editable recording is saved.**
- **D3 — the editable original is named `<name>.recordstuff.mp4` when it is saved.** The full name, not `rs`: `.rs` reads as nothing to most people and as a Rust source file to developers, while `recordstuff` says which app reopens it; the extension stays `.mp4`, so every player still opens it.
- **D4 — a recording lists the saved copies it has in the recordings folder**, found by the provenance in each file. A copy moved out of the watched folder or deleted is not listed; there is no separate log. A saved copy is a file made by Save a copy… (today's Export); edits themselves make no file.
- **D5 — the cache holds at most 10 GB or 10% of the free space, whichever is smaller.**
- **D6 — the quick-access thumbnail is built and on by default**, with a setting to turn it off; a plain recording's drags at once, an editable recording's shows its Video rendering from the moment it is saved.
- **D7 — Sources is one folder, the tracks copied without re-encoding** (sound as AAC in `.m4a`).
- **D8 — a copy saved beside its plain source is `<name> (edited).mp4`**, the naming rule above.

## Steps

- [ ] **0. Start.** Inspect the current tree, 085's publication and naming, 087's and 098's tracks, the Recordings tab's cards, drag, menus and notification, and the edit records. D1–D8 were answered on 2026-10-28. Start `caffeinate -d -i -t 5400` before the first desktop round, per [AGENTS.md](../AGENTS.md).
- [ ] **1. Versions and the cache.** The versions as a model in shared code (what each recording offers, each name in both languages, collisions); the cache keyed by recording, edit revision and version, its limit and cleaning; rendering a version through the export worker without publishing it beside the recording; the outgoing names as hard links. Provenance written into saved copies. Unit tests for every recording kind and edit state, the names, the cache's reuse, staleness and limit.
- [ ] **2. The card.** The drag gives the Video, ⌥-drag the Original, the preparing state (D1, D2), the tooltip; D3's naming for new editable recordings. Background UI cases for each state, both languages and themes, asserting behaviour and accessibility only.
- [ ] **3. Share….** The overlay (grid) and popover (list), the tiles with their names and file names, Copy, Save to… and the share sheet, More, several files at once, preparation and cancel, keyboard and VoiceOver. The edit view's Share… and Save a copy… with its form; the recording's list of its saved copies (D4).
- [ ] **4. The quick-access thumbnail** (D6), its timing, and how it and the saved notification divide their work.
- [ ] **5. Desktop round.** After the "好了" handoff, on a fresh signed bundle: each version dragged into a Finder window and into a mail draft or chat, its file checked (the Video one picture and one sound with the edit applied and the camera where shown; Sound only decodes; Original byte for byte; Sources match the recording's tracks); the card's drag in each state and ⌥-drag; the share sheet; the thumbnail; how long preparing takes for 1, 10 and 30 minutes; the cache's limit. Restore settings, close the app and confirm its processes exited.
- [ ] **6. Usability check.** The [edit view usability skill](../.agents/skills/edit-view-usability/SKILL.md)'s method, applied to sharing: a first-time person asked to send a recording to a colleague, then to send the sources to an editor, observed by Computer Use; findings fixed or recorded.
- [ ] **7. Document and close.** [editing](../docs/system-design/editing.md) (versions, the cache, provenance), [desktop](../docs/system-design/desktop.md) (the card, Share…, the thumbnail), [design decisions](../docs/system-design/decisions.md) (the model, the drag rule, naming, the rejected alternatives), the README's description of sharing, the verification record, translations, this plan's removal and the index.

## Verification

- Steps 1–4: `pnpm test:scope` on the library and editing scopes while working; `pnpm check` before step 5, because the export worker, the Recordings tab and main's publication change.
- Steps 5–6: desktop rounds with the [native acceptance skill](../.agents/skills/native-acceptance/SKILL.md); drags move the real pointer, so each needs the handoff. Serialize `out/` and `dist/` consumers.
- Report separately: automated results, what was dragged where and which file arrived, what the usability round saw, and what stayed unverified (Windows, where editable recordings do not exist and plain recordings' sharing is CI-checked only; services the round did not drop into).

## Execution and closure contract

Follow the [plan index](README.md) for order, decision points, desktop handoff and closure. D1–D8 were answered on 2026-10-28; a change to one pauses the plan for the maintainer. No commit, push, PR or release is part of this plan unless requested.
