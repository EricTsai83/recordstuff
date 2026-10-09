import { describe, expect, it, vi } from "vitest";
import type { AppAction } from "../app/ui-model";
import type { PreferenceSave } from "../settings/preferences";
import { createActionHandler, type ActionDeps } from "./actions";

function harness(overrides: Partial<ActionDeps> = {}) {
  const saves: { what: string; save: PreferenceSave }[] = [];
  const deps = {
    quitRequested: () => false,
    settled: () => true,
    platform: "darwin",
    log: vi.fn(),
    refresh: vi.fn(),
    settings: { language: "en", display: { kind: "primary" }, notifications: true, quality: { resolutionCap: "source" } },
    recorder: { state: { type: "idle" }, startIfIdle: vi.fn(() => true), stop: vi.fn(), cancelCountdown: vi.fn(), mediaPending: false },
    library: { act: vi.fn(async () => true), undoTrash: vi.fn(async () => true) },
    recordingResults: { act: vi.fn(async () => true) },
    tray: {},
    settingsWindow: { show: vi.fn(), showRecordingResult: vi.fn(), showShortcut: vi.fn(), showRecording: vi.fn() },
    shortcuts: { set: vi.fn(async () => {}), retry: vi.fn(() => true) },
    updates: { check: vi.fn(async () => {}), state: { kind: "idle" } },
    captureNotices: { hold: vi.fn() },
    clearData: { request: vi.fn(async () => true) },
    savePreference: vi.fn(async (what: string, save: PreferenceSave) => { saves.push({ what, save }); }),
    changeOutputDir: vi.fn(async () => true),
    openOutputDir: vi.fn(async () => true),
    revealLog: vi.fn(async () => true),
    showLastRecording: vi.fn(async () => {}),
    hideSettings: vi.fn(),
    displayPreferenceChanged: vi.fn(),
    resolutionCapChanged: vi.fn(),
    applyAppearance: vi.fn(),
    quit: vi.fn(),
    quitWithoutWaiting: vi.fn(),
    relaunch: vi.fn(),
    openExternal: vi.fn(async () => {}),
    revealFile: vi.fn(),
    openScreenCaptureSettings: vi.fn(async () => {}),
    openNotificationSettings: vi.fn(async () => {}),
    showInfo: vi.fn(async () => {}),
    ...overrides,
  } as unknown as ActionDeps;
  return { deps, saves, act: createActionHandler(deps) };
}

describe("createActionHandler", () => {
  it("refuses every action but quit while a quit runs", async () => {
    const { deps, act } = harness({ quitRequested: () => true });
    expect(await act("openSettings")).toBe(false);
    expect(await act("hideSettings")).toBe(false);
    expect(deps.hideSettings).not.toHaveBeenCalled();
    expect(await act({ setLanguage: "zh-TW" })).toBe(false);
    expect(await act({ recordingFile: { id: "a", action: "open" } })).toBe(false);
    expect(deps.settingsWindow.show).not.toHaveBeenCalled();
    expect(deps.savePreference).not.toHaveBeenCalled();
    expect(deps.library.act).not.toHaveBeenCalled();
    expect(await act("quit")).toBe(true);
    expect(deps.quit).toHaveBeenCalledOnce();
    // The way out of a quit held by saves in the background is offered while that quit runs.
    expect(await act("quitWithoutWaiting")).toBe(true);
    expect(deps.quitWithoutWaiting).toHaveBeenCalledOnce();
  });

  it("hides the interface without stopping or quitting a recording", async () => {
    const { deps, act } = harness({ settled: () => false });
    expect(await act("hideSettings")).toBe(true);
    expect(deps.hideSettings).toHaveBeenCalledOnce();
    expect(deps.quit).not.toHaveBeenCalled();
    expect(deps.recorder.stop).not.toHaveBeenCalled();
    expect(deps.recorder.cancelCountdown).not.toHaveBeenCalled();
  });

  it("locks the preferences a session holds and leaves the rest free to change", async () => {
    const { saves, act } = harness();
    const actions: AppAction[] = [
      { setDisplay: { kind: "primary" } }, { setUpdateChecks: false }, { setNotifications: false },
      { setTrayClick: "menu" }, { setFileNameTemplate: "{date}" }, { setLibraryLayout: "list" },
      { setAppearance: "dark" }, { setLanguage: "zh-TW" }, { setCountdown: 3 }, { setCountdownSound: true },
      { setQuality: { level: "standard", resolutionCap: "1080p", frameRate: 30 } },
    ] as AppAction[];
    for (const action of actions) await act(action);
    expect(Object.fromEntries(saves.map(({ what, save }) => [what, save.locked === true]))).toEqual({
      display: true, "update checks": true, notifications: true, "tray click": false, "file name": true,
      "library layout": false, appearance: false, language: false, countdown: true, "countdown sound": true, quality: true,
    });
  });

  it("opens the download page for this platform when an update is available, Releases otherwise", async () => {
    const { deps, act } = harness({ platform: "win32", updates: { check: vi.fn(async () => {}), state: { kind: "available", version: "9.0.0" } } } as Partial<ActionDeps>);
    expect(await act("openUpdate")).toBe(true);
    expect(deps.openExternal).toHaveBeenLastCalledWith("https://record.ericts.com/download?platform=windows");
    (deps.updates as { state: { kind: string } }).state = { kind: "failed" };
    expect(await act("openUpdate")).toBe(true);
    expect(deps.openExternal).toHaveBeenLastCalledWith("https://github.com/EricTsai83/recordstuff/releases");
  });

  it("answers a raced update click as handled without opening anything", async () => {
    const { deps, act } = harness({ settled: () => false });
    expect(await act("openUpdate")).toBe(true);
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it("leaves a drag to the window it starts in", async () => {
    const { deps, act } = harness();
    expect(await act({ recordingFile: { id: "a", action: "drag" } })).toBe(false);
    expect(deps.library.act).not.toHaveBeenCalled();
  });
});
