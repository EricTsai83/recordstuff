/** Read-only audit. Tool sessions are closed by their owner through supported lifecycle APIs. */
import { execFileSync } from "node:child_process";

export type ToolProcess = { pid: number; parentPid: number; state: string; executable: string };
export type CursorWindow = { id: number; pid: number; owner: string; name: string };

const CURSOR_SCRIPT = String.raw`
ObjC.import('Cocoa');
ObjC.import('ApplicationServices');
ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
if (!$.CGPreflightScreenCaptureAccess()) throw new Error('Screen access is required to inspect window names; no permission prompt was opened.');
const list = $.CGWindowListCopyWindowInfo(1, 0);
if (!list) throw new Error('Could not enumerate visible windows.');
const rows = ObjC.deepUnwrap(ObjC.castRefToObject(list));
JSON.stringify(rows.filter(w => w.kCGWindowName === 'Software Cursor').map(w => ({
  id: w.kCGWindowNumber, pid: w.kCGWindowOwnerPID,
  owner: w.kCGWindowOwnerName || '', name: w.kCGWindowName
})));
`;

export function parseProcesses(output: string): ToolProcess[] {
  return output.split("\n").filter((line) => line.trim()).map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) throw new Error("Could not parse process inventory");
    return { pid: Number(match[1]), parentPid: Number(match[2]), state: match[3]!, executable: match[4]! };
  });
}

export function judgeToolCleanup(windows: CursorWindow[], processes: ToolProcess[], ownedPids: number[]) {
  const ownedProcesses = processes.filter((row) => ownedPids.includes(row.pid));
  const sharedHelpers = processes.filter((row) => !ownedPids.includes(row.pid)
    && /\/(SkyComputerUseService|cmux-cua)$/.test(row.executable));
  return {
    status: windows.length || ownedProcesses.length ? "fail" as const : "pass" as const,
    visibleSoftwareCursors: windows,
    ownedProcesses,
    ownedZombies: ownedProcesses.filter((row) => row.state.startsWith("Z")),
    sharedHelpers,
    scope: "Known Software Cursor windows and explicitly supplied owned PIDs; shared helpers are observed, never terminated.",
  };
}

export function auditToolCleanup(ownedPids: number[]) {
  if (process.platform !== "darwin") throw new Error("Tool cleanup audit requires macOS");
  const options = { encoding: "utf8" as const, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 };
  const windows: unknown = JSON.parse(execFileSync("osascript", ["-l", "JavaScript", "-e", CURSOR_SCRIPT], options));
  if (!Array.isArray(windows) || windows.some((row) => !row || !Number.isInteger(row.id)
    || !Number.isInteger(row.pid) || typeof row.owner !== "string" || row.name !== "Software Cursor")) {
    throw new Error("Could not parse cursor window inventory");
  }
  const processes = parseProcesses(execFileSync("ps", ["-A", "-o", "pid=,ppid=,stat=,comm="], options));
  if (!processes.length) throw new Error("Empty process inventory cannot confirm cleanup");
  return judgeToolCleanup(windows as CursorWindow[], processes, ownedPids);
}
