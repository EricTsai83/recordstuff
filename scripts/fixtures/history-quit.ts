/**
 * Isolated real Electron process for plan 036: production Recorder, FileWriter,
 * RecordingResults, quit coordinator and unsaved-history quit flow over a
 * controllable history storage boundary. Synthetic bytes only; the prompt's
 * native presentation is replaced by scripted answers that record its options.
 */
import { app, BrowserWindow, type MessageBoxOptions } from "electron";
import fs from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { FileWriter, nodeFs } from "../../src/main/file-writer";
import { RecordingResults } from "../../src/main/recording-result";
import type { ResultStorage } from "../../src/main/recording-result-store";
import { Recorder } from "../../src/main/recorder";
import { installQuitCoordinator } from "../../src/main/quit-coordinator";
import { createHistoryQuit } from "../../src/main/quit-feedback";
import { DEFAULT_QUALITY } from "../../src/shared/quality";
import type { HostMessage } from "../../src/shared/protocol";

async function main(): Promise<void> {
  const dir = process.argv[2]!;
  app.setPath("userData", path.join(dir, "user-data"));
  app.on("window-all-closed", () => undefined);
  await app.whenReady();
  app.dock?.hide();
  const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  const events: string[] = [];
  const note = (event: string): void => { events.push(`${new Date().toISOString()} ${event}`); console.log(event); };

  // A save that hangs until released, then a disk that keeps rejecting.
  const historyFile = path.join(dir, "recording-history.json");
  let storageMode: "hang" | "reject" = "hang";
  let active = 0, peak = 0, saves = 0;
  let failHung!: (error: Error) => void;
  const storage: ResultStorage = {
    load: async () => [],
    save: async () => {
      saves++; active++; peak = Math.max(peak, active);
      try {
        if (storageMode === "hang") await new Promise<void>((_, reject) => { failHung = reject; });
        throw Object.assign(new Error("ENOSPC: controlled full disk"), { code: "ENOSPC" });
      } finally { active--; }
    },
  };
  const results = new RecordingResults(storage, note, () => {}, [60_000]);

  let deliver!: (message: HostMessage) => void, crash!: () => void;
  let started = 0, sessions = 0, copyHeld = false, releaseCopy!: () => void;
  const copyGate = new Promise<void>(resolve => { releaseCopy = resolve; });
  let savedPath: string | undefined, partialPath: string | undefined;
  const recorder = new Recorder({
    publishFailure: result => results.receive(result, { stat: file => fs.stat(file), refresh() {}, notify() {} }),
    host: {
      start: async () => { started++; },
      record: sessionId => deliver({ type: "started", sessionId }),
      stop: sessionId => { if (sessionId === "B") deliver({ type: "stopped", sessionId }); },
      onMessage: fn => { deliver = fn; },
      onFailure: fn => { crash = () => fn("capture_host_crashed", "controlled fault"); },
    },
    outputDir: () => dir, quality: () => DEFAULT_QUALITY,
    newSessionId: () => (++sessions === 1 ? "A" : "B"), ensureWritableDir: async () => undefined,
    shutdownTimeoutMs: 100, stopTimeoutMs: 100,
    openWriter: (partial, final) => FileWriter.open(partial, final, { io: { ...nodeFs,
      copyExclusive: async (from, to) => { copyHeld = true; await copyGate; await nodeFs.copyExclusive(from, to); copyHeld = false; } } }),
  });
  recorder.subscribe(event => {
    if (event.type === "saved") { savedPath = event.path; note("media: B saved"); }
    if (event.type === "failed") { partialPath = event.partialPath; note(`media: A failed ${event.code}`); }
  });
  const begin = (id: string, bytes: number[]): void => {
    deliver({ type: "prepared", sessionId: id, mimeType: "video/mp4", capture: { videoBitsPerSecond: 1, audioBitsPerSecond: 1, warnings: [] } });
    deliver({ type: "chunk", sessionId: id, seq: 0, bytes: new Uint8Array(bytes).buffer });
  };

  const prompts: Array<{ message: string; buttons: string[] | undefined; detail: string | undefined; copyHeld: boolean; savedPath?: string; busy: boolean }> = [];
  const answers = [0, 1, 2]; // Keep waiting, Stay in app, Exit without saving these reminders.
  let joined = 0, deferred = 0, resumed = 0;
  installQuitCoordinator(app, {
    shutdown: () => recorder.shutdown(),
    history: createHistoryQuit({ results, language: () => "en", focus() {}, log: note, waitMs: 300,
      show: async (options: MessageBoxOptions) => {
        prompts.push({ message: options.message, buttons: options.buttons, detail: options.detail, copyHeld, ...(savedPath ? { savedPath } : {}), busy: results.busy });
        note(`prompt: ${options.message} [${options.buttons?.join(" | ")}]`);
        return { response: answers.shift() ?? 1 };
      } }),
    pending: () => { deferred++; note("quit deferred: media pending"); },
    resume: () => { resumed++; recorder.resumeAdmission(); note("quit declined: stayed in app"); },
    joined: () => { joined++; },
    error: cause => { console.error(cause); app.exit(1); },
  });
  let lag = 0;
  const trips: number[] = [];
  app.on("will-quit", () => {
    try {
      writeFileSync(path.join(dir, "result.json"), JSON.stringify({
        prompts, joined, deferred, resumed, peak, saves, active, lagMs: Math.round(lag), roundTripsMs: trips.map(Math.round),
        mediaBytes: savedPath ? [...readFileSync(savedPath)] : null, partialBytes: partialPath ? [...readFileSync(partialPath)] : null,
        historyFileWritten: existsSync(historyFile), busyAtExit: results.busy, events,
        scope: "isolated synthetic capture; production Recorder, FileWriter, RecordingResults, quit coordinator and history quit flow; scripted prompt answers",
      }, null, 2));
    } catch (cause) { console.error(cause); app.exit(1); }
  });

  // 1. A fails and its reminder cannot be saved: the write hangs.
  recorder.toggle();
  while (started < 1) await pause(1);
  begin("A", [11, 22, 33]);
  crash();
  while (!partialPath || results.all[0]?.outcome !== "partial") await pause(5);
  await pause(50);
  assert.equal(active, 1, "one hanging history write");
  // 2. Main and a renderer keep responding while that write hangs.
  const probe = new BrowserWindow({ show: false });
  await probe.loadURL("data:text/html,<p>probe</p>");
  let last = performance.now();
  const ticker = setInterval(() => { const now = performance.now(); lag = Math.max(lag, now - last - 10); last = now; }, 10);
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    assert.equal(await probe.webContents.executeJavaScript("1 + 1"), 2);
    trips.push(performance.now() - start);
    await pause(100);
  }
  clearInterval(ticker);
  probe.destroy();
  // 3. Repeated quit joins one attempt; the hanging write keeps the app open without an exit choice.
  app.quit(); app.quit();
  while (resumed < 1) await pause(5);
  assert.equal(joined, 1);
  assert.deepEqual(prompts.map(p => p.buttons), [["Keep waiting", "Stay in app"], ["Keep waiting", "Stay in app"]]);
  assert.equal(results.busy, true, "the timed-out write is still owned, not abandoned");
  // 4. Staying restores capture admission.
  recorder.toggle();
  while (started < 2) await pause(1);
  begin("B", [44, 55, 66]);
  assert.equal(recorder.state.type, "recording");
  // 5. The hung write finally fails; no second writer ran meanwhile.
  storageMode = "reject";
  failHung(new Error("EIO: controlled hung write failed"));
  while (results.busy) await pause(5);
  assert.equal(peak, 1);
  assert.equal(results.all.find(r => r.outcome === "partial")?.persistenceFailed, "io");
  // 6. Quit while B finalizes: media stays owned and no metadata prompt appears.
  app.quit();
  while (deferred < 1) await pause(5);
  assert.equal(prompts.length, 2);
  assert.equal(copyHeld, true);
  releaseCopy();
  while (!savedPath) await pause(5);
  // 7. Retry quit: media is safe, the save fails, and exit without saving is chosen explicitly.
  app.quit();
}
process.on("uncaughtException", cause => { console.error(cause); app.exit(1); });
void main().catch(cause => { console.error(cause); app.exit(1); });
