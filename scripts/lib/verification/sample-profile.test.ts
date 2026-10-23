import { describe, expect, it } from "vitest";
import { OTHER_CAUSE, attribute, formatAttribution, frameLibrary, frameName, parseCallGraph, recordingCpu, threadLabel } from "./sample-profile.mts";

// Shaped as `sample` writes it on macOS 26: a header, `Call graph:`, one root per thread or queue, then a blank line.
const REPORT = `Analysis of sampling RecordStuff Helper (pid 1) every 1 millisecond
Process:         RecordStuff Helper [1]
----

Call graph:
    100 Thread_11   DispatchQueue_387: com.ericts.record.capture.picture.screen  (serial)
    + 100 start_wqthread  (in libsystem_pthread.dylib) + 8  [0x1]
    +   60 _RNvMsl_NtNtCs_19recordstuff_capture3mac7sessionNtB5_8Delegate17stream_did_output  (in recordstuff-capture.node) + 2852  [0x2]
    +   ! 30 _RNvMs4_NtNtCs_19recordstuff_capture3mac10compositorNtB5_10Compositor6render  (in recordstuff-capture.node) + 1720  [0x3]
    +   ! : 20 __psynch_cvwait  (in libsystem_kernel.dylib) + 8  [0x4]
    +   ! : 10 CVBufferPropagateAttachments  (in CoreVideo) + 320  [0x5]
    +   ! 20 objc_retain  (in libobjc.A.dylib) + 4  [0x6]
    +   40 _pthread_wqthread  (in libsystem_pthread.dylib) + 292  [0x7]
    +     40 __workq_kernreturn  (in libsystem_kernel.dylib) + 8  [0x8]
    50 Thread_<multiple>   DispatchQueue_388: com.ericts.record.capture.picture.audio  (serial)
    + 50 start_wqthread  (in libsystem_pthread.dylib) + 8  [0x1]
    +   50 _RNvMs_NtNtCs_19recordstuff_capture3mac5audioNtB4_10AacEncoder10encode_one  (in recordstuff-capture.node) + 176  [0x9]
    +     45 AACEncoder::EncodeFrame(float*, unsigned int)  (in AudioCodecs) + 13460  [0xa]
    100 Thread_12: recordstuff-writer
    + 100 thread_start  (in libsystem_pthread.dylib) + 8  [0xb]
    +   100 mach_msg2_trap  (in libsystem_kernel.dylib) + 8  [0xc]
    30 Thread_13
    + 30 thread_start  (in libsystem_pthread.dylib) + 8  [0xb]
    +   30 _pthread_start  (in libsystem_pthread.dylib) + 136  [0xd]
    +     30 figThreadMain  (in CoreMedia) + 1  [0xe]
    +       30 memmove  (in libsystem_platform.dylib) + 1  [0xf]
    20 Thread_14   DispatchQueue_418: vtencoder-callback-queue-0x13c00137910  (serial)
    + 20 uv_run  (in Electron Framework) + 1  [0x10]

Total number in stack (recursive counted multiple times):
`;

describe("a `sample` call graph (plan 091)", () => {
  it("parses one root per thread or queue, with nested frames", () => {
    const roots = parseCallGraph(REPORT);
    expect(roots.map((root) => root.count)).toEqual([100, 50, 100, 30, 20]);
    expect(roots[0]!.children[0]!.children.map((child) => child.count)).toEqual([60, 40]);
    expect(roots[0]!.children[0]!.children[0]!.children.map((child) => child.count)).toEqual([30, 20]);
    expect(() => parseCallGraph("not a sample report")).toThrow(/no call graph/);
  });

  it("names frames, libraries and threads", () => {
    expect(frameName("AACEncoder::EncodeFrame(float*, unsigned int)  (in AudioCodecs) + 13460  [0xa]")).toBe("AACEncoder::EncodeFrame(float*, unsigned int)");
    expect(frameLibrary("objc_retain  (in libobjc.A.dylib) + 4  [0x6]")).toBe("libobjc.A.dylib");
    expect(frameLibrary("???")).toBe("?");
    const labels = parseCallGraph(REPORT).map(threadLabel);
    expect(labels).toEqual([
      "queue com.ericts.record.capture.picture.screen",
      "queue com.ericts.record.capture.picture.audio",
      "recordstuff-writer",
      "unnamed (figThreadMain)",
      "queue vtencoder-callback-queue",
    ]);
  });

  it("counts a sample on the CPU unless its innermost frame is a kernel wait, and names its cause", () => {
    const result = attribute([parseCallGraph(REPORT)]);
    // Screen: 10 composing (CoreVideo) + 20 objc_retain + 10 own in stream_did_output; the cvwait and workq waits are off.
    // Audio: 45 in the encoder's frame + 5 own in encode_one. Writer: all waiting. figThreadMain: 30. uv_run: 20.
    expect(result.onCpu).toBe(40 + 50 + 30 + 20);
    expect(result.threads).toEqual([
      { label: "queue com.ericts.record.capture.picture.audio", samples: 50, onCpu: 50 },
      { label: "queue com.ericts.record.capture.picture.screen", samples: 100, onCpu: 40 },
      { label: "unnamed (figThreadMain)", samples: 30, onCpu: 30 },
      { label: "queue vtencoder-callback-queue", samples: 20, onCpu: 20 },
    ]);
    expect(Object.fromEntries(result.causes.map((c) => [c.cause, c.onCpu]))).toEqual({
      "AAC encoding (AudioToolbox)": 50,
      "Picture delivery (ScreenCaptureKit to the engine)": 30,
      "Composing the picture (engine, Metal)": 10,
      // A frame's cause comes before its thread's: uv_run on a VideoToolbox queue is Node's.
      "Node.js, V8 and Chromium's threads": 20,
      [OTHER_CAUSE]: 30,
    });
    expect(result.libraries[0]).toEqual({ library: "AudioCodecs", onCpu: 45 });
  });

  it("merges several graphs and scales shares by the measured CPU", () => {
    const one = attribute([parseCallGraph(REPORT)]);
    const two = attribute([parseCallGraph(REPORT), parseCallGraph(REPORT)]);
    expect(two.onCpu).toBe(2 * one.onCpu);
    const text = formatAttribution("R30", two, 14);
    // 50 of 140 on-CPU samples at 140 ms/s.
    expect(text).toContain("| AAC encoding (AudioToolbox) | 100 | 35.7% | 50.0 |");
    expect(formatAttribution("R30", two)).toContain("| AAC encoding (AudioToolbox) | 100 | 35.7% | — |");
  });

  it("scales a profile only by the one recording its process lived in", () => {
    // Each recording has its own capture process (11, 12, 13); main (1) lives through all of them.
    const process = (pid: number, average: number) => ({ pid, cpuPercent: { average } });
    const recordings = [
      { fps: 30, summary: { processes: [process(11, 10.4), process(1, 0.15)] } },
      { fps: 30, summary: { processes: [process(12, 10.3), process(1, 0.2)] } },
      { fps: 60, summary: { processes: [process(13, 14.5), process(1, 0.18)] } },
    ];
    expect(recordingCpu(recordings, "R30", 11)).toBe(10.4);
    expect(recordingCpu(recordings, "S60", 13)).toBe(14.5);
    // Main's pid is in every recording: which one the profile fell in is not known.
    expect(recordingCpu(recordings, "R30", 1)).toBeUndefined();
    // A Live preview is no recording, whatever its process; another rate's window is not this recording's.
    expect(recordingCpu(recordings, "L30", 11)).toBeUndefined();
    expect(recordingCpu(recordings, "R60", 11)).toBeUndefined();
    expect(recordingCpu(recordings, "R30", 99)).toBeUndefined();
    expect(recordingCpu([], "R30", 11)).toBeUndefined();
  });
});
