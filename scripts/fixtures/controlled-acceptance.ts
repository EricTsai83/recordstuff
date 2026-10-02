/**
 * The controlled acceptance build of plan 035. Only imported into a throwaway source copy by
 * acceptance:controlled; normal builds have no command channel. The app keeps its production
 * tray, Settings, Recorder, FileWriter, failure history, notifications and quit flow. This file
 * moves its data into the run directory, labels the tray and lets the runner arm the fault
 * points of controlled-faults.ts through request files.
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { Recorder, RecorderHost } from "../../src/main/recorder";
import type { RecordingResults } from "../../src/main/recording-result";
import type { ResultStorage } from "../../src/main/recording-result-store";
import type { SettingsStore } from "../../src/main/settings";
import type { AppTray } from "../../src/main/tray";
import type { AppAction } from "../../src/main/ui-model";
import type { RecordingFailure, RecordingResult } from "../../src/shared/recording-result";
import type { RecordingState } from "../../src/shared/state";
import { ControlledFaults } from "./controlled-faults";
import { isFaultName, isHoldTarget, type Faults, type HoldTarget } from "./controlled-modes";

export const CONTROLLED_LABEL = "[Controlled acceptance build]";

export interface ControlledConfig { holdHistoryLoad?: boolean }

export type ControlledCommand =
  | { kind: "status" }
  | { kind: "fault"; name: string; mode: string }
  | { kind: "release"; target: string }
  /** Throws from a timer on the next tick: a synthetic programming fault for the uncaught-exception box (plan 056). */
  | { kind: "throw" }
  /** Self-test only: calls the recorder's toggle directly; it is not a tray click. */
  | { kind: "toggle" }
  /** Self-test only: the production action handler; it is not a native click. */
  | { kind: "action"; action: AppAction }
  | { kind: "quit" };

export interface ControlledSnapshot {
  pid: number;
  label: string;
  attached: boolean;
  /** The last tooltip handed to the native tray, label included. */
  tooltip: string;
  faults: Faults;
  held: Record<HoldTarget, number>;
  userData: string;
  state?: RecordingState;
  historyLoading?: boolean;
  history?: readonly RecordingResult[];
  outputDir?: string;
  language?: string;
  notifications?: boolean;
}

export type ControlledResponse =
  | { ok: true; snapshot: ControlledSnapshot; released?: number }
  | { ok: false; error: string };

interface Attached {
  recorder: Recorder;
  recordingResults: RecordingResults;
  settings: SettingsStore;
  tray: AppTray;
  handleAction: (action: AppAction) => Promise<unknown>;
  log: (message: string) => void;
}

export function configureControlled(dir: string) {
  const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")) as ControlledConfig;
  const userData = path.join(dir, "user-data");
  const outputDir = path.join(dir, "recordings");
  for (const name of ["recordings", "user-data", "logs", "requests", "responses"]) fs.mkdirSync(path.join(dir, name), { recursive: true });
  app.setPath("userData", userData);
  app.setPath("logs", path.join(dir, "logs"));

  let attached: Attached | undefined;
  let tooltip = "";
  const note = (event: string, detail: object = {}): void => {
    fs.appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), event, ...detail }) + "\n");
    attached?.log(`controlled: ${event} ${JSON.stringify(detail)}`);
  };
  const faults = new ControlledFaults(note, config.holdHistoryLoad === true);

  const snapshot = (): ControlledSnapshot => {
    const base: ControlledSnapshot = { pid: process.pid, label: CONTROLLED_LABEL, attached: Boolean(attached), tooltip,
      faults: faults.faults, held: faults.heldCounts, userData };
    if (!attached) return base;
    const { recorder, recordingResults, settings } = attached;
    return { ...base, state: recorder.state, historyLoading: recordingResults.loading, history: recordingResults.all,
      outputDir: settings.outputDir, language: settings.language, notifications: settings.notifications };
  };
  const writeJson = (file: string, value: unknown): void => {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  };

  async function run(command: ControlledCommand): Promise<ControlledResponse> {
    switch (command.kind) {
      case "status":
        return { ok: true, snapshot: snapshot() };
      case "fault":
        if (!isFaultName(command.name)) throw new Error(`unknown fault ${JSON.stringify(command.name)}`);
        faults.set(command.name, command.mode);
        return { ok: true, snapshot: snapshot() };
      case "release": {
        if (!isHoldTarget(command.target)) throw new Error(`unknown hold target ${JSON.stringify(command.target)}`);
        const released = faults.release(command.target);
        return { ok: true, snapshot: snapshot(), released };
      }
      case "throw":
        if (!attached) throw new Error("the app is not ready");
        note("uncaught exception scheduled", { state: attached.recorder.state.type, mediaPending: attached.recorder.mediaPending });
        // Outside any promise, so it reaches process-level uncaughtException like a real fault in a timer or listener.
        setTimeout(() => { throw new Error("controlled acceptance: synthetic uncaught exception, not a real fault"); }, 0);
        return { ok: true, snapshot: snapshot() };
      case "toggle":
        if (!attached) throw new Error("the app is not ready");
        note("self-test toggle");
        attached.recorder.toggle();
        return { ok: true, snapshot: snapshot() };
      case "action":
        if (!attached) throw new Error("the app is not ready");
        note("self-test action", { action: command.action });
        // Not awaited: an action waiting on a held save must not block the release request behind it.
        void attached.handleAction(command.action).then(
          result => note("self-test action settled", { action: command.action, result }),
          (error: unknown) => note("self-test action failed", { action: command.action, error: String(error) }));
        return { ok: true, snapshot: snapshot() };
      case "quit":
        if (!attached) throw new Error("the app is not ready");
        note("quit requested");
        // The production quit path: a recording is stopped and saved, pending work defers exit.
        setImmediate(() => app.quit());
        return { ok: true, snapshot: snapshot() };
      default:
        throw new Error(`unknown command ${JSON.stringify(command)}`);
    }
  }

  // Requests are answered from launch on, so a held history load can be released before the app is ready.
  const requests = path.join(dir, "requests"), responses = path.join(dir, "responses");
  const seen = new Set(fs.readdirSync(requests));
  let queue = Promise.resolve();
  const poll = setInterval(() => {
    for (const name of fs.readdirSync(requests).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))) {
      if (!/^\d+\.json$/.test(name) || seen.has(name)) continue;
      seen.add(name);
      queue = queue.then(async () => {
        let response: ControlledResponse;
        try { response = await run(JSON.parse(fs.readFileSync(path.join(requests, name), "utf8")) as ControlledCommand); }
        catch (error) { response = { ok: false, error: String(error) }; }
        writeJson(path.join(responses, name), response);
      });
    }
  }, 50);

  return {
    outputDir,
    openWriter: faults.openWriter,
    host: (inner: RecorderHost): RecorderHost => faults.host(inner),
    beforePublish: (result: RecordingFailure): Promise<void> => faults.beforePublish(result),
    storage: (inner: ResultStorage): ResultStorage => faults.storage(inner),
    attach(next: Attached): void {
      attached = next;
      // The label rides on every tooltip the production tray sets from now on.
      const native = (next.tray as unknown as { tray: Electron.Tray }).tray;
      const setToolTip = native.setToolTip.bind(native);
      native.setToolTip = (text: string): void => { tooltip = `${CONTROLLED_LABEL}\n${text}`; setToolTip(tooltip); };
      // The tray skips a tooltip it already set, so forget it: this refresh must pass it through the wrapper.
      (next.tray as unknown as { currentTooltip: string | undefined }).currentTooltip = undefined;
      next.tray.refresh();
      next.recorder.subscribe(event => {
        if (event.type === "state") note("state", { state: event.state.type });
        else if (event.type === "failureStatus") note("failure status", { id: event.result.id, code: event.result.code, outcome: event.result.outcome });
        else if (event.type === "saved") note("saved", { path: event.path });
      });
      app.on("will-quit", () => {
        clearInterval(poll);
        writeJson(path.join(dir, "stopped.json"), snapshot());
      });
      next.log(`controlled: acceptance build ${dir}; userData ${userData}; faults ${JSON.stringify(faults.faults)}; history load ${config.holdHistoryLoad ? "held" : "not held"}`);
      writeJson(path.join(dir, "ready.json"), snapshot());
    },
  };
}
