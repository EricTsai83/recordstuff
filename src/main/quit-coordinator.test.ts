import { expect, it, vi } from "vitest";
import { installQuitCoordinator } from "./quit-coordinator";

it("joins repeated quit requests, defers unsafe exit and admits only a safe retry", async () => {
  let listener!: (event: { preventDefault(): void }) => void;
  const preventDefault = vi.fn();
  const app = { on: (_: "before-quit", fn: typeof listener) => { listener = fn; }, quit: vi.fn(() => listener({ preventDefault })) };
  let release!: (safe: boolean) => void;
  const shutdown = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
  const pending = vi.fn();
  installQuitCoordinator(app, { shutdown, pending, error: vi.fn() });
  listener({ preventDefault }); listener({ preventDefault });
  expect(shutdown).toHaveBeenCalledTimes(1);
  release(false); await new Promise(resolve => setTimeout(resolve, 0));
  expect(app.quit).not.toHaveBeenCalled(); expect(pending).toHaveBeenCalledOnce();
  listener({ preventDefault }); release(true); await new Promise(resolve => setTimeout(resolve, 0));
  expect(app.quit).toHaveBeenCalledOnce(); expect(shutdown).toHaveBeenCalledTimes(2);
  expect(preventDefault).toHaveBeenCalledTimes(3);
});

it("registers relaunch only on safe admission and clears it after a deferral", async () => {
  let listener!: (event: { preventDefault(): void }) => void;
  const app = { on: (_: "before-quit", fn: typeof listener) => { listener = fn; }, quit: vi.fn(() => listener({ preventDefault() {} })) };
  let safe = false;
  const relaunch = vi.fn();
  const coordinator = installQuitCoordinator(app, { shutdown: async () => safe, pending() {}, error() {}, relaunch });
  coordinator.relaunch(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(relaunch).not.toHaveBeenCalled();
  safe = true; app.quit(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(relaunch).not.toHaveBeenCalled();
});

it("registers an admitted relaunch exactly once", async () => {
  let listener!: (event: { preventDefault(): void }) => void;
  const app = { on: (_: "before-quit", fn: typeof listener) => { listener = fn; }, quit: vi.fn(() => listener({ preventDefault() {} })) };
  const relaunch = vi.fn();
  const coordinator = installQuitCoordinator(app, { shutdown: async () => true, pending() {}, error() {}, relaunch });
  coordinator.relaunch(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(relaunch).toHaveBeenCalledOnce();
});
