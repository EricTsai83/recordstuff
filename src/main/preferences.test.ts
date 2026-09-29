import { expect, it, vi } from "vitest";
import { createPreferenceActions } from "./preferences";

it("shares one folder dialog and refuses its result if recording began meanwhile", async () => {
  let settled = true, resolve!: (folder: string) => void;
  const chooseFolder = vi.fn(() => new Promise<string>(done => { resolve = done; }));
  const saveFolder = vi.fn(async () => {});
  const focus = vi.fn();
  const folderRefused = vi.fn();
  const log = vi.fn();
  const actions = createPreferenceActions({ settled: () => settled, chooseFolder, saveFolder,
    folderChanged: vi.fn(), folderFailed: vi.fn(), folderRefused, refresh: vi.fn(), log, focus });
  const first = actions.changeOutputDir();
  expect(focus).not.toHaveBeenCalled();
  // A second request joins the open dialog and brings it forward, e.g. from behind another app.
  expect(actions.changeOutputDir()).toBe(first);
  expect(focus).toHaveBeenCalledOnce();
  await Promise.resolve();
  settled = false;
  resolve("/external");
  expect(await first).toBe(false);
  expect(chooseFolder).toHaveBeenCalledOnce();
  expect(saveFolder).not.toHaveBeenCalled();
  // The refusal is told, not silent: the tray caller has no reply channel.
  expect(folderRefused).toHaveBeenCalledExactlyOnceWith("/external");
  expect(log).toHaveBeenCalledWith(expect.stringContaining("output folder /external not applied"));
  settled = true;
  const next = actions.changeOutputDir();
  await Promise.resolve();
  resolve("/available");
  expect(await next).toBe(true);
  expect(saveFolder).toHaveBeenCalledExactlyOnceWith("/available");
  expect(folderRefused).toHaveBeenCalledOnce();
});
