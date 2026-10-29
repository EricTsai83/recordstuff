# 100 — Sharing a recording: the right file by default, every version on purpose

[English](100-share-recordings.md) | [繁體中文](100-share-recordings.zh-TW.md)

Status: in progress; steps 0–2 implemented on 2026-10-29 and checked by automated tests only (no desktop round yet), step 3 waits for the maintainer's choice of visual design; decisions D1–D8 answered on 2026-10-28, D6 revised, D2 and D7 refined, the share sheet removed and Copy given ⌘C at the plan's review the same day; D9 set provisionally by the agent on 2026-10-29, for the maintainer to adjust. Created: 2026-10-28 at the maintainer's request as 099, renumbered 100 on 2026-10-29 when its branch was rebased onto main, whose 099 is the system interface crop; rewritten the same day after the maintainer's review to put the experience first. Hard dependencies: none open. It builds on the closed 085 (cutting a recording, export and publication), 087 and 098 (editable recordings and their tracks) and 071 (the Recordings tab). Execute in order under the [plan index](README.md). Step 1 moved provenance in saved copies to step 3, with Save a copy…, the only thing that makes one; the Editable mark's tooltip gains "or use Share" in step 3, once Share… exists.

The maintainer's brief (2026-10-28): design the best experience, not the smallest change; people do not know what a track is and just drag what they recorded to someone; some do want the sources, the finished video, or both; work out how the versions of a recording are shared, how they are managed and how sharing looks on screen. Making every recording editable is out of scope (maintainer, 2026-10-28).

## The problem today

Every way a recording leaves RecordStuff hands over the **original file**: dragging its card out of the Recordings tab (`startDrag` in [main](../src/main/index.ts)), Show in Finder, and the saved notification, which opens the recording in the Recordings tab, from where it is dragged. For a plain recording never edited, that is right. Otherwise nothing tells the person what they are giving:

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

What a person drags or shares is a **version**: something produced from original + edit at that moment. A version is not a file the app keeps and manages; it is made into a file when it leaves, in a cache the app owns. So no version has to stay linked to the original, none goes stale, and the person never manages one. Saved copies are different: the person asked for them and placed them, so they are the person's files to keep, rename or delete, and the app only reads where they came from (see [Managing what leaves](#managing-what-leaves)).

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
3. **A quick-action surface right after capture**, from which the result is dragged, copied or saved without opening anything: macOS's screenshot thumbnail, CleanShot X's Quick Access Overlay, which saves, copies or drags captures into other apps ([CleanShot](https://cleanshot.com/features)), and Screen Studio's Quick Share widget after a recording, with Share, Save, Copy and Edit ([Screen Studio, Quick Share](https://www.screen.studio/guide/quick-share-widget-)). This plan keeps the purpose but not the extra window: the saved notification, sent once the recording is ready to share, leads to its card, where every action already is (D6).
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
| **Sound only** | The Video's sound, mixed | Every recording | `Meeting (sound).m4a` |
| **Original** | The file as made, every track | Edited or editable recordings | Editable: `Meeting.recordstuff.mp4` (D3). Plain: `Meeting (original).mp4` |
| **Video without the camera** (under More) | The Video with the camera left out | Editable recordings with a camera | `Meeting (screen only).mp4` |
| **Sources** (under More) | Each track as its own file, copied without re-encoding, for Premiere, Final Cut or DaVinci | Editable recordings | Dragged or saved: a folder `Meeting sources/` with `Meeting - Screen.mp4`, `- Camera.mp4`, `- System sound.m4a`, `- Microphone.m4a` (those it has). Copied: the same files without the folder (D7) |

For an edited plain recording, the Video is `Meeting (edited).mp4` (D9).

**Only the original is marked; everything that leaves is named as a finished file.** This is how project-based recorders and editors name things: Screen Studio and Camtasia give the source a document type of its own and name an export after the project, and open-source editors such as Shotcut export under the project's name ([Shotcut forum](https://forum.shotcut.org/t/batch-export-multiple-projects-automatically/11740)); Photos exports an edited picture under its own name and makes the unmodified original a separate command. A recipient cares what a file holds, not whether it was edited, and "edited" invites the question of what was changed. So:

- A version is named after the recording, localized with the app's language (`會議.mp4`), with a content tag only when it differs from the default form: `(screen only)`, `(sound)`, `(edited)`, `(original)`. macOS hides extensions by default, so `.m4a` and `.mp4` alone do not tell the files apart; what a file holds is in its name, readable at a glance (maintainer, at the plan's review).
- The editable original is `Meeting.recordstuff.mp4`, on disk from the moment it is saved and when it leaves (D3). A plain recording's original, given deliberately after it was edited, leaves as `Meeting (original).mp4`; on disk it keeps its name.
- **Beside its own source** a saved copy would take the source's name. Only there is the edit named, as an iPhone transferring an edited picture beside its original names it `IMG_E…` ([MacRumors](https://forums.macrumors.com/threads/question-on-iphone-16-pro-max-camera-image-files.2478196/)): a copy saved into the folder of a plain recording named `Meeting.mp4` is `Meeting (edited).mp4`, and its card also says "Saved from Meeting" from the provenance in the file (D8). An editable recording never meets this: its source is `Meeting.recordstuff.mp4`.
- **A plain recording's on-disk name never changes**, edited or not: `(original)` is only the name its Original is given when it leaves. So the Video of an edited plain recording would leave with its source's exact name, `Meeting.mp4`, and a drop into the recordings folder would ask Finder to replace the original. D9 extends D8 from saved copies to everything that leaves: a version that would take its source's own name is `Meeting (edited).mp4`, which in practice means every Video of an edited plain recording.
- Any other name already taken where the file lands gets a number (`Meeting 2.mp4`). Version numbers such as V1 and V2 are not used: a recipient seeing V2 asks where V1 is and what changed. In the app, a recording lists its saved copies by time and form instead (D4).

The rule a person has to remember is one: **what is marked is the original; everything else can be given.**

"Video without the camera" is shown only for editable recordings, where the camera can be left out; a plain recording's camera is part of its picture.

## Sharing on screen

### 1. Dragging the card (the path most people take)

**The drag gives the Video: what the card plays is what leaves.** ⌥-drag gives the Original. For an unedited plain recording, the Video is the original file, so nothing changes.

A drag must have its file the moment the pointer goes down (macOS), and an edited or editable recording's Video must be rendered (about 6.3 times real time on the reference Mac: a 10-minute recording in about 1.5 minutes). So the Video is **prepared ahead** into the cache (D2): when the edit view closes, and when an editable recording is saved. While it is not ready, the card shows "Preparing video… 40%" over its picture, a drag does not start, and the card says why and that ⌥-drag gives the original (D1). A native file promise (the drag starts, the file is written as it lands) would remove the wait but needs a native module and is not accepted by web apps such as Slack or Gmail in a browser; it is a later option, not this plan.

**A drag always copies; it never moves.** Photos, Music and Lightroom work the same way: what is dragged out of a library is a copy, and the library keeps its file. A drag of the Video gives a rendered file from the cache, so it cannot move the recording. A drag of the Original (or of an unedited plain recording's Video) gives the recording's own file, and a drag within one volume is a move by default on macOS unless the source allows only copying. Step 0 checks what Electron's `startDrag` allows; if it allows moving, this plan restricts it to copying. There is no in-app way to move a recording out: Show in Finder is that way, as in those apps, and a recording moved out of the folder simply leaves the tab.

### 2. Share… (every version, chosen)

**Share…** is the first item of the card's ⋮ menu, above Show in Finder, Open, Rename…, Edit… and Move to, and one of the card's hover actions. It covers the whole card, picture and title row, with an overlay of tiles, one per version above (the maintainer's direction), so the tiles have the card's full height; the rest of the tab stays as it is, and the overlay names the recording at its top.

- **Three tiles and More, at most**: Video (marked recommended), Sound only and Original; More holds Video without the camera and Sources. A recording offering fewer shows fewer: an unedited plain recording has only Video and Sound only, since its Original is its Video. In the grid a card is at least 272 px wide and about 200 px high with its title row, room for three tiles and More. The list layout's row is too small, so there the same tiles open in a popover anchored to the card.
- Each tile shows the version's name and the file name it will produce, and is **dragged** to give that file, or **clicked** for two actions: **Copy** and **Save to…**. There is no share sheet (AirDrop, Messages, Mail): dragging and copying reach the same places, and one fewer menu keeps the overlay simple (maintainer, at the plan's review).
- **Copy** puts the file on the clipboard as Finder's ⌘C does, so ⌘V pastes the file itself into a Finder window, Mail, Messages or the Slack app; a web page in a browser usually receives only the name or an icon, so there dragging is the way. **⌘C works without the overlay too**: on a selected card it copies the Video (what a drag gives), on a focused tile that tile's version. **Save to…** asks for a folder in the system's save panel and writes the file there under its outgoing name; it is the click equivalent of dragging into a Finder window. A version not ready is copied or saved once it is: Copy waits with the tile's progress and then fills the clipboard.
- **The Original tile says what it holds** in one line, so nothing private leaves unseen: "Everything recorded, including removed parts" for an edited recording, "Includes the camera and each sound separately" for an editable one.
- Tiles not ready show progress; opening Share starts preparing every version that is not ready, since it is a clear intent.
- **Several at once, the macOS way**: ⌘-click a tile to select it (a check mark on the tile), then drag any selected tile to give all of their files together (`startDrag` takes `files`), as Finder does. This covers sending the finished video with the original or the sources. It is a shortcut for people who know it; nothing needs it, since each file can also be dragged on its own.
- Esc, ✕ or a click outside closes it. Tab moves between tiles, Space selects, Return opens a tile's actions, ⌘C copies the focused tile.

### 3. Right after recording: the saved notification (D6)

There is no extra window after a recording. **The saved notification is sent once the recording is ready to share**, and clicking it opens the Recordings tab at that recording, as today's does: its card is there to play, drag, copy or Share…. A plain recording is ready the moment it is saved, so its notification comes as today's. An editable recording's notification waits until its Video is prepared (D2): about 10 s for a 1-minute recording and 1.5 minutes for 10 minutes on the reference Mac, during which the card already shows "Preparing video… 40%" to anyone who opens the tab. If preparing fails, the notification says the recording is saved and the card says the Video could not be made. Notifications turned off change nothing else: the card is the same.

### 4. The edit view

The toolbar's **Export** becomes **Save a copy…**, which asks where and in which form: picture (screen and camera, screen only, none) and sound (mixed), named as above, and saves into the recordings folder by default, where it appears as a card of its own with "Saved from Meeting". What is chosen affects only the new file: leaving the camera out of a copy removes nothing from the original, whose camera track stays for the next copy. The edit view has no Share…: sharing is the card's, and closing the edit view starts preparing the Video for it (D2).

### 5. The card says what it holds

- **Editable** keeps its mark, with a tooltip in plain words: "Keeps the picture, camera and sounds apart so you can change them later. To send it, drag it or use Share."
- **Edited** keeps its mark.
- While a Video is prepared: the progress over the picture. No warning appears on a drag that gives the right file.

## Managing what leaves

- **Versions are not managed.** They are made into the cache, keyed by recording, edit revision and version, and reused while the edit is unchanged; an edit makes the next one. Dragged files are hard links to the cache entry under their outgoing names, in the same folder, so a name costs no copy.
- **Where the cache is:** `~/Library/Caches/RecordStuff/Versions/` on macOS and `%LOCALAPPDATA%\RecordStuff\Cache\Versions\` on Windows (cut plain recordings exist there too), the systems' places for files that can be made again: Time Machine leaves them out, and nothing in them is the only copy of anything.
- **How it is cleaned:** at most D5's limit, oldest first. A file handed out (dragged or copied) is kept at least 24 hours even past the limit, and as long as it is on the clipboard, because a web page such as Slack or Gmail in a browser may still be reading it after the drop; the worst case is the cache over its limit by what was handed out in a day. Deleting a recording, or moving it out of the folder, removes its entries at once, held or not: a recording the person deleted must not linger in a hidden folder, even if an upload in progress then fails. A recording edited again removes its older entries once they are not held.
- **Saved copies are ordinary files** the person placed. RecordStuff writes into each one where it came from (the source's name and the edit revision, in its `udta`, as `rsed` describes an editable file), so the Recordings tab can say "Saved from Meeting" on a copy saved into the recordings folder even after it is renamed in Finder. No link is stored outside the file, so there is nothing to keep in step.
- **A recording lists the saved copies it has in the recordings folder** (D4): the Recordings tab finds them by the provenance in each file, and the recording's menu lists them by time and form with Show in Finder. A copy moved out of the folder RecordStuff watches, or deleted, is simply not listed; there is no separate log to keep.
- **The editable original is told apart by its name**, `Meeting.recordstuff.mp4` (D3): still an MP4 any player opens, but not taken for the video to send. This is the double-extension convention (`.tar.gz`, `.min.js`, `.d.ts`): the last extension says how to open the file, the one before it what kind of file it is. The name is only for people:
  - the app knows an editable recording by the `rsed` description in the file, never by its name, so a file renamed in Finder stays editable and a plain file named `.recordstuff.mp4` does not become one;
  - the card's title leaves `.recordstuff` out (the Editable mark says it), and Rename… in the tab keeps it;
  - the file name template ([recording settings](../src/main/settings/model/recording.ts)) applies before the marker: `<template>.recordstuff.mp4`;
  - editable recordings made before this plan are not renamed; they work as before, without the marker.
- **Exports made before this plan** (`Meeting (edited).mp4`) carry no provenance and stay cards of their own.

- **A Video that needs no rendering is not rendered.** An editable recording with no edit and no camera shown already has the right picture and the mixed sound (098); its Video is those two tracks copied into a new file without re-encoding, in seconds, which leaves out the camera and the separate sounds. Only a cut, a shown camera, a changed volume or a hidden stretch needs the renderer.
- **The cache can be seen and cleared**, as Final Cut Pro's Delete Generated Files, Lightroom's cache purge and Premiere's media cache settings allow: Settings → General shows its size and a Clear button, which keeps only files still within their hold.

### Preparing alongside a recording

Preparation (D2) runs while the person goes on working, and may run while they record again. It must never cost that recording a frame.

**Why a recording can lose frames.** A recording is real time: every picture is captured, composed on the GPU (Metal) and encoded by the hardware video engine (VideoToolbox) within its frame's time, 33 ms at 30 fps. A picture still waiting when the next arrives is skipped, and the pacer repeats the previous one ([recording](../docs/system-design/recording.md)). Rendering uses the same video engine (decoding and encoding), the same GPU, memory bandwidth and disk. If it holds them when the recording needs them, the recording's picture is late. Base M-series chips have one video encode engine, Pro and Max chips two, so the risk depends on the Mac. Sound is a small CPU load and is not at risk in the same way.

**What others do.** Final Cut Pro renders in the background only after the person has been idle a few seconds and stops the moment they act. OBS runs nothing heavy beside its live encode and reports "encoding overloaded" when frames are skipped. macOS runs deferrable work (Photos' analysis, Spotlight, Time Machine) at background priority, which the system throttles for CPU, disk and network and keeps on efficiency cores, and defers it under heat or in Low Power Mode. The common rule: the real-time job has priority, background work yields to it as soon as it is under pressure, and it is measured.

**The design, in five layers:**

1. **Its own process at background priority.** Preparation runs in the export worker, already a process of its own ([editing](../docs/system-design/editing.md)), under Darwin's background policy, so macOS gives it only leftover CPU, throttles its disk I/O and keeps it on efficiency cores. A crash there cannot touch the recording.
2. **The encoder knows which job is live.** The recording's VideoToolbox session is real time, as now. The render's is not (it already is not), and while a recording runs it keeps at most one picture in flight instead of eight.
3. **A governor fed by the recording's health.** The capture process already measures what matters: how far ahead of the host clock pictures are stamped, pictures skipped and the encoder's backlog (its stop report). During a recording it sends main one small sample a second. Main pauses preparation at the next picture when a sample shows a late or skipped picture or a backlog above one picture, and resumes it after 10 s of clean samples, so it does not flap. The pause costs nothing: the renderer already checks for cancellation at every picture. Whatever the samples say, preparation is never paused past the recording's end.
4. **The system's conditions.** Preparation is paused under serious or critical thermal pressure and in Low Power Mode, and paused for a Live preview, whose frames the person is watching.
5. **A measured gate before it is on.** On the slowest supported Mac (a base M1), recordings at 30 and 60 fps, with and without the camera, while a 10-minute Video is prepared: late and skipped pictures equal the same recording alone (0.00% at 30 fps today), `verify --sync` unchanged, the recording's CPU within 087's budget. On a Mac class that fails, the governor's policy there is to pause for the whole recording, the plain pause this design falls back to.

Each prepared version is cancelled when its recording is deleted or edited again and dropped when the app quits (the half-made file is removed; it is prepared again when next needed). Preparation runs one version at a time. While it runs, the export worker stays alive for it, which the idle rules ([design overview](../docs/system-design/design-overview.md)) and `measure:cpu` must account for: idle is measured once preparation has finished, and preparation's own cost is measured.

**What it costs to build:** the health sample (the capture process already has the numbers), a governor in main (a small state machine, unit-tested over sequences of samples, including flapping and a recording that ends while paused), the process's priority, and the gate's measurement. The errors to guard against are flapping (the 10-second hysteresis), a pause that never ends (cleared when the recording ends) and preparation starved by long recordings (it finishes afterwards; the card shows its progress).

## Rejected alternatives

- **A warning dialog on every drag of an edited recording:** people learn to click it away, and it breaks the drag.
- **Grouping saved copies under their recording's card with a stored link:** every rename, move and deletion must be kept in step, and a copy renamed in Finder breaks it. Provenance in the file itself gives the same "Saved from" without that.
- **A `.recordstuff` package for editable originals:** gives up 087's "any player opens it".
- **Version numbers (V1, V2) in file names:** say nothing about content to the recipient.
- **"(edited)" on every version that leaves:** marks the deliverable instead of the source; recipients do not need it and it invites questions. It stays only where a copy sits beside its own source.
- **Making the editable file's enabled picture the composed one:** a second encoder while recording, and still without the edit.
- **Writing the edit into the original:** 085's rule that the source is never written.
- **A quick-access thumbnail after each recording** (macOS's screenshot thumbnail, CleanShot's overlay): an extra window that interrupts while the Video is still being made; the notification sent when it is ready, leading to the card, does the same with what already exists (maintainer, at the plan's review).
- **Zipping Sources when copied:** a file the person did not choose, which the recipient must unpack; the four files themselves, named alike, go to any chat or mail that takes files.

## Decisions (answered by the maintainer, 2026-10-28)

- **D1 — dragging a card whose Video is not ready: wait.** The drag gives the Video, what the card plays: an unedited plain recording's original at once; an edited plain recording's cut, and any editable recording's composed picture with the edit and volumes applied, once rendered. Until then the drag does not start, the card shows the progress and says ⌥-drag gives the original.
- **D2 — prepare the Video when the edit view closes and when an editable recording is saved.** It may run while the person records again, under the governor in [Preparing alongside a recording](#preparing-alongside-a-recording), which never lets it cost the recording a frame (the maintainer's direction at the plan's review).
- **D3 — the editable original is named `<name>.recordstuff.mp4` when it is saved.** The full name, not `rs`: `.rs` reads as nothing to most people and as a Rust source file to developers, while `recordstuff` says which app reopens it; the extension stays `.mp4`, so every player still opens it.
- **D4 — a recording lists the saved copies it has in the recordings folder**, found by the provenance in each file. A copy moved out of the watched folder or deleted is not listed; there is no separate log. A saved copy is a file made by Save a copy… (today's Export); edits themselves make no file.
- **D5 — the cache holds at most 10 GB or 10% of the free space, whichever is smaller.**
- **D6 — no quick-access thumbnail; the saved notification is sent when the recording is ready to share** (revised at the plan's review, 2026-10-28; first answered as a thumbnail on by default). A plain recording's at once, as today; an editable recording's once its Video is prepared. Clicking it opens the recording in the Recordings tab.
- **D7 — Sources is one folder when dragged or saved, the tracks copied without re-encoding** (sound as AAC in `.m4a`); copied, the same files without the folder, since most chat and mail apps refuse a folder (refined at the plan's review, 2026-10-28).
- **D8 — a copy saved beside its plain source is `<name> (edited).mp4`**, the naming rule above.
- **D9 — a version that would take its source's own name is `<name> (edited).mp4`; Sound only is `<name> (sound).m4a`** (set provisionally by the agent on 2026-10-29; the maintainer will adjust it). D8 extended from saved copies to drags, so the Video of an edited plain recording never leaves as `Meeting.mp4` and cannot replace its original in Finder. In Chinese the tag is 剪輯版 ("the cut version"), which says what the file is rather than what happened to it.

## Steps

- [x] **0. Start.** (2026-10-29: Electron's `startDrag` offers a drop outside the app a copy only, `NSDragOperationCopy` in `drag_util_mac.mm`, read from its source; step 5 confirms it on a real drop.) Inspect the current tree, 085's publication and naming, 087's and 098's tracks, the Recordings tab's cards, drag, menus and notification, and the edit records. Check whether `startDrag` lets a drop move the recording (into a Finder window on the same volume); if it does, restricting it to copying is part of step 2. D1–D8 were answered on 2026-10-28; D9 was set provisionally on 2026-10-29. Start `caffeinate -d -i -t 5400` before the first desktop round, per [AGENTS.md](../AGENTS.md).
- [x] **1. Versions and the cache.** The versions as a model in shared code (what each recording offers, each name in both languages, collisions); the cache keyed by recording, edit revision and version, its place, limit, 24-hour hold and cleaning; background preparation, one at a time, at background priority, the copy without rendering where none is needed, cancelled and dropped as above; the cache's size and Clear in Settings; rendering a version through the export worker without publishing it beside the recording; the outgoing names as hard links. Provenance written into saved copies. Unit tests for every recording kind and edit state, the names, the cache's reuse, staleness and limit.
- [x] **2. The card.** The drag gives the Video, ⌥-drag the Original, copying only, the preparing state (D1, D2), the tooltip; D3's naming for new editable recordings, the title without the marker and Rename… keeping it. Background UI cases for each state, both languages and themes, asserting behaviour and accessibility only.
- [ ] **3. Share….** **First, a design choice:** the review's sketches only placed the parts and are not the design. Before building, present several distinct visual designs of the overlay, its tiles, the tile actions and the preparing state (at least three, made with the app's own components, fonts and tokens, in both themes and languages, the grid card and the list popover), and build the one the maintainer picks; this is a decision point that pauses the plan. Then: The menu item and hover action; the overlay (grid) and popover (list), at most three tiles and More, the Original tile's line, the tiles' names and file names, Copy and Save to… (Sources as files when copied, D7), ⌘C on a card and a tile, ⌘-click selection and several files at once, preparation and cancel, keyboard and VoiceOver. The edit view's Save a copy… with its form, replacing Export; the recording's list of its saved copies (D4).
- [ ] **4. Preparing alongside a recording and the saved notification.** The capture process's health sample, the governor and its pause and resume, the thermal and Low Power conditions, the export worker's priority; the gate measured on the slowest supported Mac, and the policy set per Mac class from it. The saved notification (D6): sent when the recording is ready to share, an editable recording's after its Video is prepared, and what it says when preparing fails. `measure:cpu` and the idle rules updated for background preparation; its cost measured.
- [ ] **5. Desktop round.** After the "好了" handoff, on a fresh signed bundle: each version dragged into a Finder window and into a mail draft or chat, its file checked (the Video one picture and one sound with the edit applied and the camera where shown; Sound only decodes; Original byte for byte; Sources match the recording's tracks); the card's drag in each state and ⌥-drag; Copy and ⌘C pasted into Finder, Mail and the Slack app, and what a browser page receives; the notification's timing; how long preparing takes for 1, 10 and 30 minutes; a recording made while a Video is prepared, its skipped pictures and sync compared with the same recording alone, and the governor's pauses in the log; a drop on the same volume leaving the recording in place; the cache's limit and hold. Restore settings, close the app and confirm its processes exited.
- [ ] **6. Usability check.** The [edit view usability skill](../.agents/skills/edit-view-usability/SKILL.md)'s method, applied to sharing: a first-time person asked to send a recording to a colleague, then to send the sources to an editor, observed by Computer Use; findings fixed or recorded.
- [ ] **7. Document and close.** [editing](../docs/system-design/editing.md) (versions, the cache, provenance), [desktop](../docs/system-design/desktop.md) (the card, Share…, the notification), the [design overview](../docs/system-design/design-overview.md)'s idle rules, [design decisions](../docs/system-design/decisions.md) (the model, the drag rule, naming, the rejected alternatives), the README's description of sharing, the verification record, translations, this plan's removal and the index.

## Verification

- Steps 1–4: `pnpm test:scope` on the library and editing scopes while working; `pnpm check` before step 5, because the export worker, the Recordings tab and main's publication change.
- Steps 5–6: desktop rounds with the [native acceptance skill](../.agents/skills/native-acceptance/SKILL.md); drags move the real pointer, so each needs the handoff. Serialize `out/` and `dist/` consumers.
- Report separately: automated results, what was dragged where and which file arrived, what the usability round saw, and what stayed unverified (Windows, where editable recordings do not exist, plain recordings' sharing is CI-checked only, and Copy of files is not offered (drag and Save to… are); services the round did not drop into).

## Execution and closure contract

Follow the [plan index](README.md) for order, decision points, desktop handoff and closure. D1–D8 were answered on 2026-10-28 (D6 revised and D7 refined the same day); D9 is provisional, for the maintainer to adjust; step 3's choice among visual designs is the maintainer's; a change to any decision pauses the plan for the maintainer. No commit, push, PR or release is part of this plan unless requested.
