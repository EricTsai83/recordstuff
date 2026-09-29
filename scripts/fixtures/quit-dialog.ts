/** Synthetic bytes and isolated userData: no capture, installed app or user settings. */
import { Notification, app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { Recorder } from "../../src/main/recorder";
import { FileWriter, nodeFs } from "../../src/main/file-writer";
import { installQuitCoordinator } from "../../src/main/quit-coordinator";
import { createQuitFeedback } from "../../src/main/quit-feedback";
import { isLanguage } from "../../src/shared/i18n";
import { DEFAULT_QUALITY } from "../../src/shared/quality";
import type { HostMessage } from "../../src/shared/protocol";

async function main(): Promise<void> {
  const dir = process.argv[2]!;
  const language = process.argv[3];
  assert.ok(isLanguage(language));
  app.setPath("userData", path.join(dir, "user-data"));
  app.setName("RecordStuff Quit Dialog Test");
  app.on("window-all-closed", () => undefined);
  await app.whenReady();
  app.dock?.hide();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let deliver!: (message: HostMessage) => void;
  const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  let started = false, diskPending = false, prompts = 0, deferred = 0;
  let savedPath: string | undefined;
  const events: Array<{ time: string; event: string }> = [];
  const record = (event: string): void => {
    events.push({ time: new Date().toISOString(), event });
    console.log(event);
  };
  const recorder = new Recorder({
    host: {
      start: async () => { started = true; },
      record: sessionId => deliver({ type: "started", sessionId }),
      stop: sessionId => deliver({ type: "stopped", sessionId }),
      onMessage: fn => { deliver = fn; }, onFailure() {},
    },
    outputDir: () => dir, quality: () => DEFAULT_QUALITY,
    newSessionId: () => "dialog-fixture", ensureWritableDir: async () => undefined,
    shutdownTimeoutMs: 100, stopTimeoutMs: 100,
    openWriter: (partial, final) => FileWriter.open(partial, final, { io: {
      ...nodeFs,
      // Publication is a hard link here (a copy only where links are refused); hold whichever runs.
      link: async (from, to) => {
        diskPending = true; record("publication held"); await gate;
        await nodeFs.link(from, to); diskPending = false; record("publication complete");
      },
      copyExclusive: async (from, to) => {
        diskPending = true; record("copy held"); await gate;
        await nodeFs.copyExclusive(from, to); diskPending = false; record("copy complete");
      },
    } }),
  });
  recorder.subscribe(event => {
    if (event.type === "saved") { savedPath = event.path; record("saved synthetic bytes"); }
    if (event.type === "failed") throw new Error("Unexpected synthetic recording failure");
  });
  // Production feedback; the fixture's notification stands in for AppTray's, without a tray icon.
  const notices: Notification[] = [];
  const feedback = createQuitFeedback({
    language: () => language,
    notify: body => {
      prompts++; record("notification requested");
      const notice = new Notification({ title: "RecordStuff", body, silent: true });
      notices.push(notice);
      notice.on("show", () => record("notification shown"));
      notice.on("failed", (_event, error) => record(`notification failed: ${error}`));
      notice.show();
    },
    log: message => { throw new Error(message); },
  });
  // A timer due while the notice is up must fire on time (plan 055): a modal dialog held it until dismissed.
  const lateMs: number[] = [];
  let completed!: () => void;
  const done = new Promise<void>(resolve => { completed = resolve; });
  installQuitCoordinator(app, {
    shutdown: () => recorder.shutdown(),
    pending: () => {
      deferred++; assert.equal(diskPending, true); assert.equal(savedPath, undefined);
      // The first tick is armed before the notice, so a presentation that blocks main is counted too.
      const tick = (): { due: number; elapsed: Promise<void> } => ({ due: Date.now() + 1000, elapsed: pause(1000) });
      let next = tick();
      assert.equal(feedback(), undefined, "feedback must not hand quit anything to wait for");
      record("feedback returned");
      void (async () => {
        for (let count = 0; count < 8; count++) {
          await next.elapsed;
          lateMs.push(Date.now() - next.due);
          next = tick();
        }
        assert.equal(diskPending, true, "the notice must not release disk work");
        record(`timers while the notice was up: late by at most ${Math.max(...lateMs)} ms; publication still held; process alive`); completed();
      })().catch(cause => { console.error(cause); app.exit(1); });
    },
    error: cause => { console.error(cause); app.exit(1); },
  });
  app.on("will-quit", () => { assert.equal(diskPending, false); assert.ok(savedPath); });
  recorder.toggle();
  while (!started) await pause(1);
  deliver({ type: "prepared", sessionId: "dialog-fixture", mimeType: "video/mp4", capture: {
    videoBitsPerSecond: 1, audioBitsPerSecond: 1, warnings: [],
  } });
  deliver({ type: "chunk", sessionId: "dialog-fixture", seq: 0, bytes: new Uint8Array([11, 22, 33]).buffer });
  record("ready: notification in about 3 seconds");
  await pause(3000);
  app.quit(); app.quit();
  await done;
  // Keep ownership after the notice, then recover and retry via production wiring.
  await pause(1000);
  release();
  while (!savedPath) await pause(1);
  assert.deepEqual([...await fs.readFile(savedPath)], [11, 22, 33]);
  assert.equal(prompts, 1); assert.equal(deferred, 1);
  const maxLateMs = Math.max(...lateMs);
  await fs.writeFile(path.join(dir, "result.json"), JSON.stringify({
    language, prompts, deferred, maxLateMs, lateMs, bytes: [11, 22, 33], events,
    nativeObservation: "not recorded: an observer must confirm the banner and its complete text",
    scope: "isolated synthetic capture; production Recorder, FileWriter, quit coordinator and native feedback",
  }, null, 2));
  app.quit();
}
void main().catch(cause => { console.error(cause); app.exit(1); });
