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
    settingsWindow: { show: vi.fn(), showRecordingResult: vi.fn(), showShortcut: vi.fn(), showShortcutList: vi.fn(), showRecording: vi.fn() },
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

  it("resets an unreadable failure history only after the user confirms, and only while it is unreadable (plan 078)", async () => {
    const resetHistory = vi.fn(async () => true);
    const confirm = vi.fn(async () => ({ response: 0 }));
    const { deps, act } = harness({ recordingResults: { act: vi.fn(), historyFailed: true, resetHistory }, confirm } as Partial<ActionDeps>);
    // Cancel: a successful no-op.
    expect(await act("resetFailureHistory")).toBe(true);
    expect(resetHistory).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ buttons: ["Cancel", "Reset failure history"], cancelId: 0 }));
    confirm.mockResolvedValueOnce({ response: 1 });
    expect(await act("resetFailureHistory")).toBe(true);
    expect(resetHistory).toHaveBeenCalledOnce();
    expect(deps.refresh).toHaveBeenCalled();
    const readable = harness({ recordingResults: { act: vi.fn(), historyFailed: false, resetHistory }, confirm } as Partial<ActionDeps>);
    expect(await readable.act("resetFailureHistory")).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("opens Windows's Optional features only on Windows (plan 078)", async () => {
    const openOptionalFeatures = vi.fn(async () => {});
    expect(await harness({ platform: "win32", openOptionalFeatures }).act("openOptionalFeatures")).toBe(true);
    expect(await harness({ platform: "darwin", openOptionalFeatures }).act("openOptionalFeatures")).toBe(false);
    expect(openOptionalFeatures).toHaveBeenCalledOnce();
  });

  it("opens the Keyboard Shortcuts tab from Help, and not while a quit runs (plan 073)", async () => {
    const { deps, act } = harness();
    await act("openShortcutList");
    expect(deps.settingsWindow.showShortcutList).toHaveBeenCalledOnce();
    const quitting = harness({ quitRequested: () => true });
    expect(await quitting.act("openShortcutList")).toBe(false);
    expect(quitting.deps.settingsWindow.showShortcutList).not.toHaveBeenCalled();
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
      { setTrayClick: "menu" }, { setFileNameTemplate: "{date}" }, { setLibraryLayout: "list" }, { setLibraryPreviewSound: true },
      { setAppearance: "dark" }, { setLanguage: "zh-TW" }, { setCountdown: 3 }, { setCountdownSound: true }, { setHideSystemUi: true },
      { setQuality: { level: "standard", resolutionCap: "1080p", frameRate: 30 } },
      { setMicrophone: false }, { setMicrophoneDevice: null },
    ] as AppAction[];
    for (const action of actions) await act(action);
    expect(Object.fromEntries(saves.map(({ what, save }) => [what, save.locked === true]))).toEqual({
      display: true, "update checks": true, notifications: true, "tray click": false, "file name": true,
      "library layout": false, "library preview sound": false, appearance: false, language: false, countdown: true, "countdown sound": true, "hide system UI": true, quality: true,
      microphone: true, "microphone device": true,
    });
  });

  describe("the microphone (plan 074)", () => {
    function microphoneHarness(allowed: boolean, platform: NodeJS.Platform = "darwin") {
      const settings = { language: "en", microphone: false, microphoneDevice: undefined as { id: string; label: string } | undefined,
        setMicrophone: vi.fn(async (on: boolean) => { settings.microphone = on; }),
        setMicrophoneDevice: vi.fn(async (device: { id: string; label: string } | null) => { settings.microphoneDevice = device ?? undefined; }) };
      const tray = { notifyMicrophoneDenied: vi.fn() };
      const askMicrophoneAccess = vi.fn(async () => allowed);
      const ctx = harness({ platform, settings, tray, askMicrophoneAccess,
        openMicrophoneSettings: vi.fn(async () => {}),
        savePreference: vi.fn(async (_what: string, save: PreferenceSave) => { await save.write(); save.applied?.(); }) } as unknown as Partial<ActionDeps>);
      return { ...ctx, settings, tray, askMicrophoneAccess };
    }

    it("asks for access when turned on, after saving, and keeps it on when refused, saying so", async () => {
      const allowed = microphoneHarness(true);
      await allowed.act({ setMicrophone: true });
      expect(allowed.settings.microphone).toBe(true);
      expect(allowed.askMicrophoneAccess).toHaveBeenCalledOnce();
      expect(allowed.tray.notifyMicrophoneDenied).not.toHaveBeenCalled();
      expect(allowed.deps.refresh).toHaveBeenCalled();

      const refused = microphoneHarness(false);
      await refused.act({ setMicrophone: true });
      expect(refused.settings.microphone).toBe(true);
      expect(refused.tray.notifyMicrophoneDenied).toHaveBeenCalledOnce();
    });

    it("does not ask when turned off or when already on", async () => {
      const ctx = microphoneHarness(false);
      await ctx.act({ setMicrophone: false });
      ctx.settings.microphone = true;
      await ctx.act({ setMicrophone: true });
      expect(ctx.askMicrophoneAccess).not.toHaveBeenCalled();
      expect(ctx.tray.notifyMicrophoneDenied).not.toHaveBeenCalled();
    });

    it("saves the chosen input or the system default", async () => {
      const ctx = microphoneHarness(true);
      await ctx.act({ setMicrophoneDevice: { id: "usb", label: "USB Microphone" } });
      expect(ctx.settings.microphoneDevice).toEqual({ id: "usb", label: "USB Microphone" });
      await ctx.act({ setMicrophoneDevice: null });
      expect(ctx.settings.microphoneDevice).toBeUndefined();
    });

    it("opens the Microphone pane on macOS only and reports whether it opened", async () => {
      const mac = microphoneHarness(true);
      expect(await mac.act("openMicrophoneSettings")).toBe(true);
      expect(mac.deps.openMicrophoneSettings).toHaveBeenCalledOnce();
      vi.mocked(mac.deps.openMicrophoneSettings).mockRejectedValueOnce(new Error("refused"));
      expect(await mac.act("openMicrophoneSettings")).toBe(false);
      const windows = microphoneHarness(true, "win32");
      expect(await windows.act("openMicrophoneSettings")).toBe(false);
      expect(windows.deps.openMicrophoneSettings).not.toHaveBeenCalled();
    });
  });

  it("saves hiding the menu bar and Dock only on macOS (plan 076, D6)", async () => {
    const windows = harness({ platform: "win32" });
    await windows.act({ setHideSystemUi: true });
    expect(windows.deps.savePreference).not.toHaveBeenCalled();
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
