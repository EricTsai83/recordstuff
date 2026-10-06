/**
 * What the window server says about a background launch (plan 066): whether any window of its main process was
 * on screen, and whether it became the frontmost app. Sampled about once a second while the test runs and once more
 * before teardown. macOS only, through the CoreGraphics window list and NSWorkspace (read-only queries: no window
 * is moved, no input is sent and nothing is captured). Elsewhere it reports itself unsupported, and the boundary's
 * own guards are the only containment evidence.
 *
 * A sample cannot see a window that appeared and went between two samples; the boundary's adapter log is the
 * complete record of what production asked for.
 */
import { execFile } from "node:child_process";

const SCRIPT = `ObjC.import("CoreGraphics"); ObjC.import("AppKit");
function run(argv) {
  const pid = Number(argv[0]);
  const all = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0))) || [];
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return JSON.stringify({
    windows: all.filter(w => w.kCGWindowOwnerPID === pid).map(w => ({ onscreen: Boolean(w.kCGWindowIsOnscreen), name: w.kCGWindowName || "", layer: w.kCGWindowLayer, bounds: w.kCGWindowBounds })),
    frontmost: front ? Number(front.processIdentifier) : 0,
  });
}`;

export interface ProbeSample { at: number; onscreen: Array<{ name: string; bounds: unknown }>; frontmost: number; windows: number }
export interface ProbeReport { supported: boolean; samples: number; onscreen: ProbeSample[]; frontmost: ProbeSample[]; errors: string[] }

const sample = (pid: number): Promise<ProbeSample> => new Promise((resolve, reject) => {
  execFile("osascript", ["-l", "JavaScript", "-e", SCRIPT, String(pid)], { timeout: 5000, encoding: "utf8" }, (error, stdout) => {
    if (error) { reject(error); return; }
    try {
      const value = JSON.parse(stdout) as { windows: Array<{ onscreen: boolean; name: string; bounds: unknown }>; frontmost: number };
      resolve({ at: Date.now(), onscreen: value.windows.filter(window => window.onscreen).map(({ name, bounds }) => ({ name, bounds })), frontmost: value.frontmost, windows: value.windows.length });
    } catch (cause) { reject(cause as Error); }
  });
});

export class DesktopProbe {
  readonly supported = process.platform === "darwin";
  private readonly report: ProbeReport;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  constructor(private readonly pid: number, intervalMs = 1000) {
    this.report = { supported: this.supported, samples: 0, onscreen: [], frontmost: [], errors: [] };
    if (!this.supported) return;
    this.timer = setInterval(() => { if (!this.running) this.running = this.take().finally(() => { this.running = undefined; }); }, intervalMs);
    this.timer.unref();
    this.running = this.take().finally(() => { this.running = undefined; });
  }
  private async take(): Promise<void> {
    try {
      const result = await sample(this.pid);
      this.report.samples += 1;
      if (result.onscreen.length) this.report.onscreen.push(result);
      if (result.frontmost === this.pid) this.report.frontmost.push(result);
    } catch (error) {
      // The process may have exited between samples; only a failure while it runs is worth keeping.
      if (this.report.errors.length < 5) this.report.errors.push(String(error));
    }
  }
  /** One last sample, then the findings. */
  async stop(): Promise<ProbeReport> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
    if (this.supported) await this.take();
    return this.report;
  }
}
