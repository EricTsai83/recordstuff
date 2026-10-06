/**
 * The runner side of the controlled acceptance build's command channel (plan 035): a numbered
 * request file in `requests/`, answered by a file of the same name in `responses/`. Shared by
 * acceptance:controlled and the tray runner's long-start mode (plan 065).
 */
import fs from "node:fs";
import path from "node:path";
import { nextRequestNumber } from "./controlled-acceptance.mts";
import type { ControlledCommand, ControlledResponse, ControlledSnapshot } from "../../fixtures/controlled-acceptance";

/** Polls `read` until it returns a value; the caller owns cancellation and the deadline's error. */
export type Until = <T>(read: () => T | undefined, label: string, timeoutMs: number) => Promise<T>;

export const readJson = <T,>(file: string): T | undefined => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return undefined; }
};
export const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** The pid the run's app reported at ready, while that process still runs. */
export function controlledPid(dir: string): number | undefined {
  const ready = readJson<ControlledSnapshot>(path.join(dir, "ready.json"));
  return ready && alive(ready.pid) ? ready.pid : undefined;
}

export async function sendControlled(dir: string, command: ControlledCommand, until: Until): Promise<Extract<ControlledResponse, { ok: true }>> {
  if (controlledPid(dir) === undefined) throw new Error(`The controlled app of ${dir} is not running; use reopen.`);
  const requests = path.join(dir, "requests");
  const name = `${nextRequestNumber(fs.readdirSync(requests))}.json`;
  fs.writeFileSync(path.join(requests, `${name}.tmp`), JSON.stringify(command));
  fs.renameSync(path.join(requests, `${name}.tmp`), path.join(requests, name));
  const response = await until(() => readJson<ControlledResponse>(path.join(dir, "responses", name)), `a reply to ${command.kind}`, 15_000);
  if (!response.ok) throw new Error(response.error);
  return response;
}
