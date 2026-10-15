/**
 * Isolated real Electron process; delays real filesystem work, never the user's app. The host plays the native engine
 * (plan 076): it writes the file itself and reports progress, its outcome comes after `stopped`, and EngineFileWriter
 * keeps or publishes what it wrote. Modes hold one step each: `publish` the final name's link after a stop, `finish`
 * the engine's outcome after a stop, `crash` the size check that keeps the partial after the host ends, and `result`
 * the failure history's check of that partial.
 */
import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { nodeFs } from "../../src/main/recording/file-writer";
import { EngineFileWriter } from "../../src/main/recording/engine-file-writer";
import { RecordingResults } from "../../src/main/recording/recording-result";
import { RecordingResultStore } from "../../src/main/recording/recording-result-store";
import { Recorder } from "../../src/main/recording/recorder";
import { installQuitCoordinator } from "../../src/main/app/quit-coordinator";
import { DEFAULT_QUALITY } from "../../src/shared/quality";
import type { HostMessage } from "../../src/shared/protocol";

async function main(): Promise<void> {
const dir = process.argv[2]!;
const mode = process.argv[3]!;
/** `publish` and `finish` stop normally; `crash` and `result` end the host while it records. */
const stops = mode === "publish" || mode === "finish";
app.setPath("userData", path.join(dir, "user-data"));
app.on("window-all-closed", () => undefined);
await app.whenReady();
app.dock?.hide();
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
let deliver!: (message: HostMessage) => void;
let crash!: () => void;
let started = false, diskPending = false, release!: () => void;
let deferred = 0, terminal = 0, stablePath: string | undefined, partial: string | undefined;
/** Holds a step of the file's finishing until `release`, marking the disk work as pending meanwhile. */
const held = async <T>(work: () => Promise<T>): Promise<T> => { diskPending = true; await gate; const value = await work(); diskPending = false; return value; };
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
    start: async (_sessionId, _quality, recordingPath) => { partial = recordingPath; started = true; },
    // Prepare then record, as the real host does; no countdown here.
    record: sessionId => deliver({ type: "started", sessionId }),
    stop: sessionId => { if (stops) deliver({ type: "stopped", sessionId }); },
    onMessage: fn => { deliver = fn; },
    onFailure: fn => { crash = () => fn("capture_host_crashed", "controlled fault"); },
  },
  outputDir: () => dir, quality: () => DEFAULT_QUALITY,
  newSessionId: () => "fixture", ensureWritableDir: async () => undefined,
  shutdownTimeoutMs: 100,
  stopTimeoutMs: 100, // Same production deadline path, shortened for the fixture.
  // Publication is a hard link here (a copy only where links are refused); `publish` holds whichever runs.
  openWriter: (partial, final) => EngineFileWriter.open(partial, final, {
    io: mode !== "publish" ? nodeFs : {
      ...nodeFs,
      link: (from, to) => held(() => nodeFs.link(from, to)),
      copyExclusive: (from, to) => held(() => nodeFs.copyExclusive(from, to)),
    },
    outcome: () => mode === "finish" ? held(async () => ({ bytes: 3, finalizeMs: 1 })) : Promise.resolve({ bytes: 3, finalizeMs: 1 }),
    ...(mode === "crash" ? { size: (file: string) => held(async () => (await fs.stat(file)).size) } : {}),
  }),
});
recorder.subscribe(event => {
  if (event.type === "saved" || event.type === "failed") {
    terminal++; stablePath = event.type === "saved" ? event.path : event.partialPath;
  }
});
installQuitCoordinator(app, { shutdown: () => recorder.shutdown(), pending: () => { deferred++; },
  error: cause => { console.error(cause); app.exit(1); } });
app.on("will-quit", () => {
  assert.equal(diskPending, false, "process must retain pending disk ownership");
  assert.equal(terminal, 1);
});
recorder.toggle();
while (!started) await pause(1);
deliver({ type: "prepared", sessionId: "fixture", mimeType: "video/mp4", capture: {
  videoBitsPerSecond: 1, audioBitsPerSecond: 1, warnings: [],
} });
// The engine writes the file itself and reports the bytes written so far.
await fs.writeFile(partial!, new Uint8Array([11, 22, 33]));
deliver({ type: "progress", sessionId: "fixture", bytes: 3 });
if (!stops) crash();
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
if (!stops) { assert.equal(await results.persist(), true); assert.equal((await resultStore.load())[0]?.outcome, "partial"); }
await fs.writeFile(path.join(dir, "result.json"), JSON.stringify({ mode, deferred, terminal, stablePath, bytes: [11, 22, 33] }));
app.quit();

}
// A failed assertion in an event handler exits with it at once, not as an error dialog or the runner's timeout.
process.on("uncaughtException", cause => { console.error(cause); app.exit(1); });
process.on("unhandledRejection", cause => { console.error(cause); app.exit(1); });
void main().catch(cause => { console.error(cause); app.exit(1); });
