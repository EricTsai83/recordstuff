import { expect, it, vi } from "vitest";
import { createPreferenceActions } from "./preferences";

it("shares one folder dialog and refuses its result if recording began meanwhile", async () => {
  let settled = true, resolve!: (folder: string) => void;
  const chooseFolder = vi.fn(() => new Promise<string>(done => { resolve = done; }));
  const saveFolder = vi.fn(async () => {});
  const actions = createPreferenceActions({ settled: () => settled, chooseFolder, saveFolder,
    folderChanged: vi.fn(), folderFailed: vi.fn(), refresh: vi.fn(), log: vi.fn() });
  const first = actions.changeOutputDir();
  expect(actions.changeOutputDir()).toBe(first);
  await Promise.resolve();
  settled = false;
  resolve("/external");
  expect(await first).toBe(false);
  expect(chooseFolder).toHaveBeenCalledOnce();
  expect(saveFolder).not.toHaveBeenCalled();
  settled = true;
  const next = actions.changeOutputDir();
  await Promise.resolve();
  resolve("/available");
  expect(await next).toBe(true);
  expect(saveFolder).toHaveBeenCalledExactlyOnceWith("/available");
});
