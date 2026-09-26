/** Isolated real Electron process; delays real filesystem work, never the user's app. */
import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { FileWriter, nodeFs } from "../../src/main/file-writer";
import { RecordingResults } from "../../src/main/recording-result";
import { RecordingResultStore } from "../../src/main/recording-result-store";
import { Recorder } from "../../src/main/recorder";
import { installQuitCoordinator } from "../../src/main/quit-coordinator";
import { DEFAULT_QUALITY } from "../../src/shared/quality";
import type { HostMessage } from "../../src/shared/protocol";

async function main(): Promise<void> {
const dir = process.argv[2]!;
const mode = process.argv[3]!;
app.setPath("userData", path.join(dir, "user-data"));
app.on("window-all-closed", () => undefined);
await app.whenReady();
app.dock?.hide();
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
let deliver!: (message: HostMessage) => void;
let crash!: () => void;
let started = false, diskPending = false, release!: () => void;
let deferred = 0, terminal = 0, stablePath: string | undefined;
const gate = new Promise<void>(resolve => { release = resolve; });
const resultStore = new RecordingResultStore(path.join(dir, "failure-history.json"));
const results = new RecordingResults(resultStore);
const recorder = new Recorder({
  publishFailure: result => results.receive(result, {
    stat: async file => {
      if (mode === "result") { diskPending = true; await gate; }
      const stat = await fs.stat(file);
      if (mode === "result") diskPending = false;
      return stat;
    }, refresh() {}, notify() {},
  }),
  host: {
    start: async () => { started = true; },
    // Prepare then record, as the real host does; no countdown here.
    record: sessionId => deliver({ type: "started", sessionId }),
    stop: sessionId => { if (mode === "copy") deliver({ type: "stopped", sessionId }); },
    onMessage: fn => { deliver = fn; },
    onFailure: fn => { crash = () => fn("capture_host_crashed", "controlled fault"); },
  },
  outputDir: () => dir, quality: () => DEFAULT_QUALITY,
  newSessionId: () => "fixture", ensureWritableDir: async () => undefined,
  shutdownTimeoutMs: 100,
  stopTimeoutMs: 100, // Same production deadline path, shortened for the fixture.
  openWriter: (partial, final) => FileWriter.open(partial, final, { io: {
    ...nodeFs,
    copyExclusive: async (from, to) => { diskPending = true; await gate; await nodeFs.copyExclusive(from, to); diskPending = false; },
    open: async (file, flags) => {
      const handle = await nodeFs.open(file, flags);
      return { write: bytes => handle.write(bytes), sync: () => handle.sync(), close: async () => {
        if (mode === "cleanup") { diskPending = true; await gate; }
        await handle.close(); if (mode === "cleanup") diskPending = false;
      } };
    },
  } }),
});
recorder.subscribe(event => {
  if (event.type === "saved" || event.type === "failed") {
    terminal++; stablePath = event.type === "saved" ? event.path : event.partialPath;
  }
});
installQuitCoordinator(app, { shutdown: () => recorder.shutdown(), pending: () => { deferred++; },
  error: cause => { throw cause; } });
app.on("will-quit", () => {
  assert.equal(diskPending, false, "process must retain pending disk ownership");
  assert.equal(terminal, 1);
});
recorder.toggle();
while (!started) await pause(1);
deliver({ type: "prepared", sessionId: "fixture", mimeType: "video/mp4", capture: {
  videoBitsPerSecond: 1, audioBitsPerSecond: 1, warnings: [],
} });
deliver({ type: "chunk", sessionId: "fixture", seq: 0, bytes: new Uint8Array([11, 22, 33]).buffer });
if (mode !== "copy") crash();
app.quit(); app.quit();
await pause(150);
assert.equal(diskPending, true);
assert.equal(deferred, 1);
assert.equal(terminal, 0);
app.quit(); app.quit();
await pause(150);
assert.equal(deferred, 2);
assert.equal(diskPending, true);
release();
while (terminal === 0) await pause(1);
assert.deepEqual([...await fs.readFile(stablePath!)], [11, 22, 33]);
assert.equal(await recorder.shutdown(), true);
if (mode !== "copy") { assert.equal(await results.persist(), true); assert.equal((await resultStore.load())[0]?.outcome, "partial"); }
await fs.writeFile(path.join(dir, "result.json"), JSON.stringify({ mode, deferred, terminal, stablePath, bytes: [11, 22, 33] }));
app.quit();

}
void main().catch(cause => { console.error(cause); app.exit(1); });
