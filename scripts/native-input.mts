/**
 * `pnpm native:input -- <command>`: an executor's own input to the RecordStuff bundle under test, for the guided
 * hands-on rounds of the native acceptance skill, where no committed runner covers an operation (changing a setting
 * mid-recording, choosing an input, starting a recording while the maintainer handles hardware). macOS only; never
 * shipped. It acts only on this checkout's packaged bundle (`dist/mac-*\/RecordStuff.app`), running once, found by its
 * executable path and pid; pointer input must land inside that process's windows, and a shortcut is sent only when the
 * log's latest start is that process. Every result is one JSON line marked as executor input, for the round's report.
 * Commands and exit codes: `USAGE` in scripts/lib/acceptance/native-input.mts.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acceleratorToKeystroke, keystrokeScript, registeredAccelerator, registeredSettingsAccelerator } from "./lib/acceptance/acceptance.mts";
import { setTimeout as delay } from "node:timers/promises";
import { AccessibilityBlockedError, osascriptAx, type NativeAx, type PointHit, type WindowElements } from "./lib/runner/native-ax.mts";
import { USAGE, UsageError, centreOf, chooseElement, lockRefusal, overlayRefusal, parseInputCommand, pointRefusal, startMismatch, systemEventsDenied, visible, type InputCommand } from "./lib/acceptance/native-input.mts";
import { macProbe } from "./lib/runner/desktop-session.mts";
import { recordStuffPids } from "./lib/runner/processes.mts";
import { APP_LOG_PATH, runnerArgs } from "./lib/runner/runner-env.mts";
import { developmentAppPath } from "./lib/runner/verification-timing.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = developmentAppPath(root);
const executable = path.join(bundle, "Contents/MacOS/RecordStuff");

class Refused extends Error {}
class Blocked extends Error {}

/** Turns Chromium's accessibility tree on and reads the window once its web elements are there (up to 5 s). */
async function readElements(ax: NativeAx, pid: number, window: string): Promise<WindowElements> {
  await ax.enableWebAccessibility(pid);
  for (let attempt = 0; ; attempt += 1) {
    const read = await ax.elements(pid, window);
    if (read.webElements > 0 || attempt >= 20) return read;
    await delay(250);
  }
}

/** Refuses input to a locked session, before any key or pointer event. */
function checkUnlocked(): void {
  macProbe.wake();
  const refusal = lockRefusal(macProbe.locked());
  if (refusal) throw new Blocked(refusal);
}

/** Refuses pointer input at a point outside the bundle's visible windows, under another app or, for a press, under another of its windows. */
async function checkPoint(ax: NativeAx, pid: number, x: number, y: number, window?: string): Promise<void> {
  checkUnlocked();
  const { windows } = await ax.windows(pid);
  let hit: PointHit | undefined;
  try { hit = await ax.hit(x, y); } catch (cause) { if (cause instanceof AccessibilityBlockedError) throw cause; hit = undefined; }
  const refusal = pointRefusal(windows.filter((w) => !w.minimized).map((w) => w.frame), hit, pid, x, y, window);
  if (refusal) throw new Refused(refusal);
}

const print = (value: Record<string, unknown>): void => console.log(JSON.stringify({ time: new Date().toISOString(), input: "executor", ...value }));

async function main(command: InputCommand): Promise<Record<string, unknown>> {
  if (process.platform !== "darwin") throw new Blocked("native:input runs on macOS only");
  const pids = recordStuffPids(bundle);
  if (pids.length !== 1) throw new Blocked(pids.length === 0 ? `${bundle} is not running; start it with pnpm start:app or pnpm open:app` : `${bundle} runs ${pids.length} times (${pids.join(", ")})`);
  const pid = pids[0]!;
  const ax = osascriptAx(AbortSignal.timeout(90_000));
  const target = { pid, executable };
  switch (command.kind) {
    case "elements": {
      const read = await readElements(ax, pid, command.window);
      return { ...target, command: "elements", window: command.window, frame: read.frame, overlays: read.overlays, webElements: read.webElements, truncated: read.truncated,
        elements: read.elements.map((element) => ({ ...element, centre: centreOf(element.frame), ...(visible(element) ? {} : { offscreen: true }) })) };
    }
    case "press": {
      const read = await readElements(ax, pid, command.window);
      const choice = chooseElement(read.elements, command.title);
      if (!choice.ok) throw new Refused(choice.reason);
      const covered = overlayRefusal(choice.element, read.overlays);
      if (covered) throw new Refused(covered);
      const point = centreOf(choice.element.frame);
      await checkPoint(ax, pid, point.x, point.y, command.window);
      await ax.mouse("left", point.x, point.y);
      return { ...target, command: "press", window: command.window, element: choice.element, point };
    }
    case "click":
    case "scroll": {
      await checkPoint(ax, pid, command.x, command.y);
      if (command.kind === "click") await ax.mouse("left", command.x, command.y);
      else await ax.scroll(command.x, command.y, command.lines);
      return { ...target, ...command, command: command.kind };
    }
    case "shortcut": {
      const lines = fs.readFileSync(APP_LOG_PATH, "utf8").split("\n");
      const mismatch = startMismatch(lines, pid, executable);
      if (mismatch) throw new Refused(mismatch);
      const accelerator = command.which === "record" ? registeredAccelerator(lines) : registeredSettingsAccelerator(lines);
      if (!accelerator) throw new Refused(`the running bundle has no ${command.which} shortcut registered`);
      const keystroke = acceleratorToKeystroke(accelerator);
      if (!keystroke) throw new Refused(`System Events cannot type ${accelerator}`);
      checkUnlocked();
      const sent = spawnSync("osascript", ["-e", keystrokeScript(keystroke)], { encoding: "utf8", timeout: 10_000 });
      if (sent.error || sent.status !== 0) {
        const detail = sent.error?.message ?? sent.stderr.trim();
        if (systemEventsDenied(detail)) throw new Blocked(`System Events was refused: ${detail}`);
        throw new Error(`osascript failed: ${detail}`);
      }
      return { ...target, command: "shortcut", which: command.which, accelerator };
    }
  }
}

const args = runnerArgs();
if (args.includes("--help") || args.length === 0) {
  console.log(USAGE);
  process.exit(args.length === 0 ? 2 : 0);
}
try {
  print({ status: "done", ...(await main(parseInputCommand(args))) });
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  const blocked = cause instanceof UsageError || cause instanceof Blocked || cause instanceof AccessibilityBlockedError;
  print({ status: blocked ? "blocked" : cause instanceof Refused ? "refused" : "failed", error: message });
  process.exitCode = blocked ? 2 : 1;
}
