/**
 * The process table the hosts' teardown reads to confirm a launch has ended (fixtures.ts `ownedProcesses`). On
 * Windows a read needs PowerShell's CIM query, and starting a PowerShell for every read (several per test, hundreds
 * per run) left the runner unable to start any process at all: the scan, and then Playwright's worker, failed with
 * 0xC0000142 STATUS_DLL_INIT_FAILED (CI, 2026-10-08). One shell per worker now answers every read over its pipes,
 * and is started again only if it ends. Elsewhere `ps` is cheap and runs per read.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const READ_TIMEOUT_MS = 30_000;
/**
 * Each answer ends with a line of exactly this and the request's number, so a late answer is never taken for a newer
 * one. Only a whole line counts: the shell's own command line, a row of the very table, contains the text too.
 */
const END = "<<<process-table-end";
const END_LINE = /^<<<process-table-end (\d+)$/;

/** The PowerShell loop: one table per line read on stdin, as `pid ppid commandline` lines, then the end line. */
export const WINDOWS_SERVER_SCRIPT = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "while ($null -ne ($request = [Console]::In.ReadLine())) {",
  "  try { Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine -ErrorAction Stop | ForEach-Object {",
  "    \"$($_.ProcessId) $($_.ParentProcessId) $(($_.CommandLine -replace '[\\r\\n]+', ' '))\" } }",
  `  catch { "ERROR $($_.Exception.Message)" }`,
  `  "${END} $request"`,
  "  [Console]::Out.Flush()",
  "}",
].join("\n");

/** A long-lived table server: reads go out one at a time, each answered before the next is sent. */
export class ProcessTableServer {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private requests = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private waiting: { id: number; resolve: (rows: string) => void; reject: (error: Error) => void } | undefined;

  constructor(private readonly command: string, private readonly args: readonly string[]) {}

  read(timeout = READ_TIMEOUT_MS): Promise<string> {
    const next = this.queue.then(() => this.request(timeout));
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Ends the shell; a later read starts another. */
  stop(): void {
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
  }

  private start(): ChildProcessWithoutNullStreams {
    const child = spawn(this.command, [...this.args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const ended = (error: Error): void => {
      if (this.child !== child) return;
      this.child = undefined;
      this.waiting?.reject(error);
      this.waiting = undefined;
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (this.child === child) this.receive(chunk); });
    // A request written as the shell ends fails on the pipe (EPIPE): that read fails, and the next starts a new shell.
    child.stdin.on("error", error => { if (this.child === child) { ended(error); this.stop(); } });
    // Nothing reads stderr's meaning, but an unread pipe could fill and stall the shell.
    child.stderr.resume();
    child.on("error", error => ended(error));
    child.on("exit", (code, signal) => ended(new Error(`process table shell ended (code ${code}, signal ${signal})`)));
    // The worker may exit while the shell idles: it must not hold the worker open.
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as unknown as { unref?: () => void }).unref?.();
    this.child = child;
    this.buffer = "";
    this.lines = [];
    return child;
  }

  private request(timeout: number): Promise<string> {
    const child = this.child ?? this.start();
    const id = ++this.requests;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = undefined;
        // A shell that stopped answering is ended; the next read starts a fresh one.
        this.stop();
        reject(new Error(`process table read timed out after ${timeout} ms`));
      }, timeout);
      this.waiting = {
        id,
        resolve: rows => { clearTimeout(timer); resolve(rows); },
        reject: error => { clearTimeout(timer); reject(error); },
      };
      child.stdin.write(`${id}\n`);
    });
  }

  /** Lines since the last end line; an end line for an earlier, timed-out request drops what came before it. */
  private lines: string[] = [];

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      const end = END_LINE.exec(line);
      if (!end) { this.lines.push(line); continue; }
      const rows = this.lines;
      this.lines = [];
      const waiting = this.waiting;
      if (!waiting || Number(end[1]) !== waiting.id) continue;
      this.waiting = undefined;
      const error = rows.find(row => row.startsWith("ERROR "));
      if (error) waiting.reject(new Error(`process table query failed: ${error.slice("ERROR ".length)}`));
      else waiting.resolve(rows.join("\n") + "\n");
    }
  }
}

let windowsServer: ProcessTableServer | undefined;

/** `pid ppid command` lines of every process. */
export function processTableRows(): Promise<string> {
  if (process.platform === "win32") {
    windowsServer ??= new ProcessTableServer("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SERVER_SCRIPT]);
    return windowsServer.read();
  }
  return new Promise((resolve, reject) => {
    execFile("ps", ["-A", "-ww", "-o", "pid=,ppid=,command="], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 << 20 },
      (error, stdout) => { if (error) reject(error); else resolve(stdout); });
  });
}

process.on("exit", () => windowsServer?.stop());
