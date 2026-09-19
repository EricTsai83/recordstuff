# Global shortcut acceptance (`pnpm acceptance`)

Run 2026-09-19T16:17:02.229Z on caiyaolideMacBook-Pro.local, macOS 25.6.0, pid 5027, shortcut `CommandOrControl+Alt+Shift+R`, 20 s requested. Keys were sent by System Events from this script; the material was opened in a Chrome kiosk with autoplay allowed.

Result: **pass** (0 failing check(s); integrity tier, test material: audio bitrate reported only).

## Events

- 2026-09-19T16:16:26.872Z opened test material in Chrome kiosk on the primary display; waiting 5 s
- 2026-09-19T16:16:32.042Z sent CommandOrControl+Alt+Shift+R via System Events (start)
- 2026-09-19T16:16:32.297Z recording (press → pressed 166 ms; pressed → recording 96 ms)
- 2026-09-19T16:16:52.506Z sent CommandOrControl+Alt+Shift+R via System Events (stop)
- 2026-09-19T16:16:52.765Z saved /Users/eric/Movies/RecordStuff/2026-09-20 00-16-32.mp4
- 2026-09-19T16:17:02.228Z markers: 20 flashes, 19 beeps in 20 s

## Verifier

```text
/Users/eric/Movies/RecordStuff/2026-09-20 00-16-32.mp4
  Video standard, cap source, 60 fps; track 1920x1080 @ 60 fps, 48000 Hz × 2 channels; target 16.20 Mbps / 256 kbps; warnings: track.getSettings() reported 1920x1920; actual frames 1920x1080; using actual frames
  ✅ Output dimensions                         1920x1080                                                                                        1920x1080
  ✅ Recording duration                        20.0 ± 2 s (requested)                                                                           20.4 s
  — Average frame rate                        60 ± 2 fps                                                                                       56.97 fps (1159 frames)  (Frame timing is judged only for continuously moving material: pass --moving, or --sync with the test page)
  — Dropped frames                            < 2%                                                                                             0.52% (6 frames / sampled 1159 frames, max gap 33 ms)  (Frame timing is judged only for continuously moving material: pass --moving, or --sync with the test page)
  ✅ Audio-video duration difference           < 100 ms                                                                                         8 ms
  ✅ Audio-video start offset (container)      Audio late < 125 ms / early < 45 ms (ITU-R BT.1359)                                              0 ms
  — Audio-video offset (flash/beep)           Audio late < 125 ms / early < 45 ms (ITU-R BT.1359); a stable excess indicates inherent latency  —  (Requires --sync and the test material page)
  — End-to-end A/V drift                      < 100 ms                                                                                         —  (Requires --sync and a file longer than 60 seconds)
  ✅ Sample rate/channels                      48 kHz, 2 channels, energy in both channels                                                      48000 Hz, 2 channels, RMS -27.1 dB / -27.2 dB (track reports 2 channels)
  ✅ Video bitrate                             ≥ 70% of 16.20 Mbps                                                                              31.01 Mbps (of target 191%)  (Above target: larger file, not a quality loss (Chromium overshoots at 60 fps))
  — Audio bitrate                             ≥ 50% of 256 kbps                                                                                30 kbps (of target 12%)  (Reported only: the test material's sparse beeps encode far below any request; use the audio-quality diagnostics for bitrate)
  — CPU (all Electron processes)              average ≤ 40%                                                                                    —
  ✅ Decodability (ffprobe full frame decode)  No decode errors                                                                                 Decodable, 20.4 s, 75.2 MB  (Opening and seeking in QuickTime/Chrome still requires manual verification)
  Result: ✅
```

File: `/Users/eric/Movies/RecordStuff/2026-09-20 00-16-32.mp4`. Evidence: [verify.json](verify.json), [app-session.log](app-session.log). Not covered: tray menu cases, playback by ear, first permission grant, long recordings.