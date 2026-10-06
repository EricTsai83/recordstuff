# Test clips

The background player tests (`tests/ui/player.spec.ts`) play these two clips through the production library, media
scheme, player and full-screen page. They are checked in, so neither CI platform needs FFmpeg (plan 066); a missing
clip fails the run before any test starts (`tests/ui/global-setup.ts`). They are test material only and never ship.

Made with FFmpeg 9.0.1 from its built-in test sources, so anyone can make them again:

```sh
ffmpeg -f lavfi -i "testsrc2=size=480x270:rate=15:duration=8" -f lavfi -i "sine=frequency=440:duration=8" \
  -c:v libx264 -preset veryslow -crf 34 -pix_fmt yuv420p -g 15 -c:a aac -b:a 32k -shortest -movflags +faststart \
  -map_metadata -1 -fflags +bitexact -flags:v +bitexact -flags:a +bitexact landscape-8s.mp4
ffmpeg -f lavfi -i "testsrc2=size=270x480:rate=15:duration=4" \
  -c:v libx264 -preset veryslow -crf 34 -pix_fmt yuv420p -g 15 -movflags +faststart \
  -map_metadata -1 -fflags +bitexact -flags:v +bitexact portrait-4s.mp4
```

| File | Content | SHA-256 |
| --- | --- | --- |
| `landscape-8s.mp4` | 8 s, 480 × 270 H.264 at 15 fps with a 440 Hz AAC tone | `6c16f5d9fb2ef0753a6a9b3724c9b26355ee860fdead86e4c740d5a838db498b` |
| `portrait-4s.mp4` | 4 s, 270 × 480 H.264 at 15 fps, no sound | `e14282904b1509db31b69f42da57266a5419a93fdb6388656975ca65a043fa9b` |

Another encoder version may produce different bytes; the tests read only duration, dimensions, decoding and
playback, so a remade clip with the same properties works. Recording evidence never comes from these clips.
