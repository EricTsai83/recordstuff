/**
 * Where a process's CPU goes, from the call graph macOS's `sample` writes (plan 091): `pnpm measure:cpu -- --profile`
 * keeps one per process and window. `sample` stops every thread once a millisecond and records its stack whether it ran
 * or waited, so a thread's count is wall time; a sample whose innermost frame is a kernel wait (a condition variable, a
 * Mach message, a kevent, a semaphore) is taken as off the CPU and the rest as on it. That is an estimate: a thread
 * ready to run but not running counts as on it, and the tool's own stops perturb the process, so plan 091 reads the
 * on-CPU samples only as shares and scales them by the process's CPU the sampler measured in the same recording.
 *
 * Shares are given three ways: by thread or dispatch queue, by cause (the first of `CAUSES` that names a frame on the
 * sample's stack or its thread), and by the library its innermost frame is in. Development only; never shipped.
 */

export interface CallNode {
  count: number;
  frame: string;
  children: CallNode[];
}

/** A kernel wait: the innermost frame of a thread that is not running. */
const WAIT_FRAMES = new Set([
  "__psynch_cvwait", "__psynch_mutexwait", "__psynch_rw_rdlock", "__psynch_rw_wrlock", "mach_msg2_trap", "mach_msg_trap",
  "kevent", "kevent64", "kevent_id", "__workq_kernreturn", "__semwait_signal", "__ulock_wait", "__ulock_wait2",
  "semaphore_wait_trap", "semaphore_timedwait_trap", "__select", "poll", "__sigsuspend", "__wait4",
]);

/** Frames that only start a thread, skipped when naming one that has no name of its own. */
const START_FRAMES = /^(thread_start|_pthread_start|start_wqthread|_pthread_wqthread|start|main|std::__1::__thread_proxy.*|void\* std::__1::__thread_proxy.*)$/;

export interface Cause {
  name: string;
  /** Matches a frame's name anywhere on the sample's stack. */
  frame?: RegExp;
  /** Matches the thread's or queue's label. */
  thread?: RegExp;
}

/**
 * In order: the first that matches takes the sample, so the specific work inside a delivery (encoding the sound,
 * composing the picture) is named before the delivery that calls it. Patterns follow the engine's mangled Rust names
 * (`…3mac5audio10AacEncoder…`) and the system's symbols as `sample` printed them on macOS 26.
 */
export const CAUSES: readonly Cause[] = [
  { name: "AAC encoding (AudioToolbox)", frame: /AacEncoder|AudioConverterFillComplexBuffer/ },
  { name: "Sound mixing (engine)", frame: /core5mixer/ },
  { name: "Composing the picture (engine, Metal)", frame: /Compositor6render/ },
  { name: "Submitting to the video encoder (VideoToolbox)", frame: /VTCompressionSessionEncodeFrame/ },
  { name: "Writer thread", thread: /^recordstuff-writer$/ },
  { name: "Refresh thread", thread: /^recordstuff-refresh$/ },
  { name: "Picture delivery (ScreenCaptureKit to the engine)", thread: /^queue com\.ericts\.record\.capture\..*screen/ },
  { name: "Sound delivery (ScreenCaptureKit to the engine)", thread: /^queue com\.ericts\.record\.capture\..*audio/ },
  { name: "Other engine threads", thread: /^recordstuff-|^queue com\.ericts\.record\./ },
  { name: "Microphone (CoreAudio)", frame: /AUHAL|AudioDeviceIOProc|HALC_Proxy|AudioUnitRender/ },
  { name: "System media queues (VideoToolbox, CoreMedia, Metal)", thread: /videotoolbox|vtencoder|coremedia|FigMemory|com\.Metal|caulk|AudioToolbox/i },
  { name: "Node.js, V8 and Chromium's threads", frame: /v8::|node::|uv_run|uv__|libuv|Electron Framework/, thread: /V8Worker|libuv|ThreadPool|Chrome_|main-thread|Perfetto|DelayedTask|SignalInspector|NetworkConfig/ },
];
export const OTHER_CAUSE = "Other";

/** The tree under `Call graph:`, one root per thread or queue. */
export function parseCallGraph(text: string): CallNode[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("Call graph:"));
  if (start < 0) throw new Error("no call graph: not a `sample` report");
  const roots: CallNode[] = [];
  const stack: { depth: number; node: CallNode }[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) break;
    const match = /^([ +!:|]*)(\d+) (.*)$/.exec(line);
    if (!match) continue;
    const depth = match[1]!.length;
    const node: CallNode = { count: Number(match[2]), frame: match[3]!.trim(), children: [] };
    while (stack.length && stack.at(-1)!.depth >= depth) stack.pop();
    (stack.length ? stack.at(-1)!.node.children : roots).push(node);
    stack.push({ depth, node });
  }
  return roots;
}

/** A frame's function, without its library, offset and address. */
export function frameName(frame: string): string {
  return frame.replace(/\s+\(in [^)]*\).*$/, "").replace(/\s+\+ [\d,.]+\s*$/, "").trim();
}

/** The library a frame is in, or `?`. */
export function frameLibrary(frame: string): string {
  return /\(in ([^)]+)\)/.exec(frame)?.[1] ?? "?";
}

/**
 * A root's label: the thread's name (`recordstuff-writer`), `queue <label>` for a dispatch queue (an address or a trailing
 * number in the label dropped, so one queue's runs merge), or for an unnamed thread its first frame past the thread's start.
 */
export function threadLabel(root: CallNode): string {
  const queue = /DispatchQueue_\d+: (.+?)\s+\((serial|concurrent)\)\s*$/.exec(root.frame)?.[1];
  if (queue) return `queue ${queue.replace(/-?0x[0-9a-f]+/gi, "").replace(/[.-]\d+$/, "")}`;
  const named = /^Thread_\S+:\s+(.+)$/.exec(root.frame)?.[1];
  if (named) return named.replace(/\.\d+$/, "").replace(/:\d+$/, "");
  let node: CallNode | undefined = root.children[0];
  while (node && START_FRAMES.test(frameName(node.frame)) && node.children.length) node = node.children[0];
  return `unnamed (${node ? frameName(node.frame) : "no frames"})`;
}

export interface Attribution {
  /** On-CPU samples in all. */
  onCpu: number;
  /** Per label: every sample, and those on the CPU. */
  threads: { label: string; samples: number; onCpu: number }[];
  causes: { cause: string; onCpu: number }[];
  /** On-CPU samples by the library of their innermost frame. */
  libraries: { library: string; onCpu: number }[];
}

const add = (map: Map<string, number>, key: string, value: number): void => { map.set(key, (map.get(key) ?? 0) + value); };

/** Shares of one or more call graphs of the same process and workload, merged. */
export function attribute(graphs: readonly CallNode[][], causes: readonly Cause[] = CAUSES): Attribution {
  const threads = new Map<string, { samples: number; onCpu: number }>();
  const byCause = new Map<string, number>();
  const byLibrary = new Map<string, number>();
  let onCpu = 0;
  for (const roots of graphs) {
    for (const root of roots) {
      const label = threadLabel(root);
      const entry = threads.get(label) ?? { samples: 0, onCpu: 0 };
      entry.samples += root.count;
      threads.set(label, entry);
      const threadCause = causes.find((cause) => cause.thread?.test(label));
      const walk = (node: CallNode, path: string[]): void => {
        const name = frameName(node.frame);
        const here = [...path, name];
        const own = node.count - node.children.reduce((sum, child) => sum + child.count, 0);
        if (own > 0 && !WAIT_FRAMES.has(name)) {
          entry.onCpu += own;
          onCpu += own;
          const cause = causes.find((c) => c.frame !== undefined && here.some((frame) => c.frame!.test(frame))) ?? threadCause;
          add(byCause, cause?.name ?? OTHER_CAUSE, own);
          add(byLibrary, frameLibrary(node.frame), own);
        }
        for (const child of node.children) walk(child, here);
      };
      // The root is the thread itself, not a frame.
      for (const child of root.children) walk(child, []);
    }
  }
  const sorted = <T extends { onCpu: number }>(items: T[]): T[] => items.filter((item) => item.onCpu > 0).sort((a, b) => b.onCpu - a.onCpu);
  return {
    onCpu,
    threads: sorted([...threads].map(([label, value]) => ({ label, ...value }))),
    causes: sorted([...byCause].map(([cause, value]) => ({ cause, onCpu: value }))),
    libraries: sorted([...byLibrary].map(([library, value]) => ({ library, onCpu: value }))),
  };
}

/**
 * A Markdown report of an attribution, each share also as milliseconds of CPU a second when the process's measured
 * CPU (`cpuPercent`, of one core) is known. `top` limits the thread and library tables.
 */
export function formatAttribution(title: string, attribution: Attribution, cpuPercent?: number, top = 12): string {
  const share = (n: number): string => (attribution.onCpu ? `${((100 * n) / attribution.onCpu).toFixed(1)}%` : "—");
  const ms = (n: number): string => (cpuPercent !== undefined && attribution.onCpu ? `${((cpuPercent * 10 * n) / attribution.onCpu).toFixed(1)}` : "—");
  const table = (head: string, rows: [string, number][]): string[] =>
    [`| ${head} | On-CPU samples | Share | ms/s |`, "| --- | --- | --- | --- |", ...rows.map(([name, n]) => `| ${name} | ${n} | ${share(n)} | ${ms(n)} |`)];
  return [
    `### ${title}`, "",
    `${attribution.onCpu} on-CPU samples${cpuPercent === undefined ? "" : `; the process measured ${cpuPercent.toFixed(2)}% of a core (${(cpuPercent * 10).toFixed(1)} ms/s), which the ms/s column divides by share`}.`, "",
    ...table("Cause", attribution.causes.map((c) => [c.cause, c.onCpu])), "",
    ...table("Thread or queue", attribution.threads.slice(0, top).map((t) => [t.label, t.onCpu])), "",
    ...table("Library (innermost frame)", attribution.libraries.slice(0, top).map((l) => [l.library, l.onCpu])), "",
  ].join("\n");
}

/** What `measure:cpu`'s report.json holds of each recording, as far as scaling a profile needs it. */
export interface ReportRecording {
  fps: number;
  summary?: { processes?: { pid: number; cpuPercent: { average: number } }[] };
}

/**
 * The CPU a profile is scaled by: its process's average in the one recording that profile fell in. Only a recording's
 * window (`R` or `S`, at the recording's own rate) has one, and only a pid that appears in that one recording names it:
 * main, the GPU process and a renderer the Studio keeps live through several recordings, so their pid alone cannot say
 * which recording a profile fell in, and a Live preview (`L`) is no recording. Undefined then: such a share is left
 * unscaled rather than given another window's CPU.
 */
export function recordingCpu(recordings: readonly ReportRecording[], window: string, pid: number): number | undefined {
  const match = /^([RS])(\d+)$/.exec(window);
  if (!match) return undefined;
  const found = recordings.flatMap((recording) => (recording.summary?.processes ?? []).filter((process) => process.pid === pid).map((process) => ({ fps: recording.fps, cpu: process.cpuPercent.average })));
  return found.length === 1 && found[0]!.fps === Number(match[2]) ? found[0]!.cpu : undefined;
}
