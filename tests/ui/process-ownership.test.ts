import { expect, it } from "vitest";
import { ProcessOwnership } from "./process-ownership";

const tracker = () => new ProcessOwnership(10, "unique-profile", "C:\\electron.exe", 99);
const pids = (owner: ProcessOwnership, table: string) => owner.read(table).map(row => row.pid);

it("does not adopt old children of a dead root that was never observed", () => {
  expect(pids(tracker(), '20 10 @100 system.exe\n30 1 @300 "C:\\electron.exe" unique-profile')).toEqual([30]);
});

it("tracks surviving helpers but rejects reused root and child PIDs before signalling", () => {
  const owner = tracker();
  expect(pids(owner, '10 1 @200 "C:\\electron.exe" host\n20 10 @201 renderer\n30 1 @202 "C:\\electron.exe" unique-profile')).toEqual([10, 30, 20]);
  expect(pids(owner, '10 1 @400 unrelated.exe\n20 10 @401 unrelated-child.exe\n30 1 @202 "C:\\electron.exe" unique-profile')).toEqual([30]);
});

it("uses the original parent's time after it exits, including exact FILETIME precision", () => {
  const owner = tracker();
  pids(owner, '10 1 @134000000000000001 "C:\\electron.exe" host');
  expect(pids(owner, '20 10 @134000000000000000 system.exe\n21 10 @134000000000000002 renderer')).toEqual([21]);
  expect(pids(owner, '21 1 @134000000000000002 renderer')).toEqual([21]);
  expect(pids(owner, '')).toEqual([]);
});

it("never adopts a watcher, the worker itself, or an executable with a matching prefix", () => {
  expect(pids(tracker(), '10 1 @200 "C:\\electron.exe" host\n99 10 @201 worker\n30 1 @202 tail unique-profile\n40 1 @203 C:\\electron.exe-other unique-profile')).toEqual([10]);
});

it("tracks POSIX descendants and a reparented helper without Windows timestamps", () => {
  const owner = new ProcessOwnership(10, "unique-profile", "/app/Electron", 99);
  expect(pids(owner, '10 1 /app/Electron host\n20 10 renderer\n30 1 /app/Electron unique-profile')).toEqual([10, 30, 20]);
  expect(pids(owner, '20 1 renderer\n30 1 /app/Electron unique-profile')).toEqual([20, 30]);
});
