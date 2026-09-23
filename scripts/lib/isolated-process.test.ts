import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { runIsolatedProcess } from "./isolated-process.mts";

const run = async (source: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}) => {
  const fd = fs.openSync("/dev/null", "w");
  try {
    return await runIsolatedProcess({ executable: process.execPath, args: ["-e", source],
      cwd: process.cwd(), env: process.env, logFd: fd, timeoutMs: 3000, graceMs: 250, ...options });
  } finally { fs.closeSync(fd); }
};
describe.skipIf(process.platform === "win32")("isolated process cleanup", () => {
  it("reaps successful and failed children", async () => {
    for (const code of [0, 7]) {
      expect(await run(`process.exit(${code})`)).toMatchObject({ code, groupGone: true, forced: false });
    }
  });
  it("lets timeout handlers exit gracefully", async () => {
    expect(await run("process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 50)", { timeoutMs: 500 }))
      .toMatchObject({ code: 0, stopped: "timeout", groupGone: true, forced: false });
  });
  it("escalates a process which ignores termination", async () => {
    expect(await run("process.on('SIGTERM', () => {}); setInterval(() => {}, 50)", { timeoutMs: 500 }))
      .toMatchObject({ code: null, stopped: "timeout", groupGone: true, forced: true });
  });
  it("cleans descendants left by an exited parent", async () => {
    const source = "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 50)'], {stdio:'ignore'}).unref()";
    expect(await run(source)).toMatchObject({ code: 0, groupGone: true });
  });
  it("reaps a child on caller interruption", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      expect(await run("setInterval(() => {}, 50)", { signal: controller.signal }))
        .toMatchObject({ stopped: "interrupted", groupGone: true });
    } finally { clearTimeout(timer); }
  });
  it("reports spawn failure with no surviving group", async () => {
    const result = await runIsolatedProcess({ executable: "/nonexistent/recordstuff-test", args: [],
      cwd: process.cwd(), env: process.env, logFd: 1, timeoutMs: 100, graceMs: 100 });
    expect(result.groupGone).toBe(true);
    expect(result.error).toContain("ENOENT");
  });
});
