import { describe, expect, it, vi } from "vitest";
import { withPosition } from "../../shared/camera-layout";
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
    recorder: { state: { type: "idle" }, startIfIdle: vi.fn(() => true), stop: vi.fn(), cancelCountdown: vi.fn(), mediaPending: false,
      updateMicrophone: vi.fn(() => false), audio: undefined },
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

  describe("the camera (plan 075)", () => {
    function cameraHarness(allowed: boolean, platform: NodeJS.Platform = "darwin") {
      const settings = { language: "en", camera: false, setCamera: vi.fn(async (on: boolean) => { settings.camera = on; }) };
      const tray = { notifyCameraDenied: vi.fn() };
      const askCameraAccess = vi.fn(async () => allowed);
      const ctx = harness({ platform, settings, tray, askCameraAccess,
        openCameraSettings: vi.fn(async () => {}),
        savePreference: vi.fn(async (_what: string, save: PreferenceSave) => { await save.write(); save.applied?.(); }) } as unknown as Partial<ActionDeps>);
      return { ...ctx, settings, tray, askCameraAccess };
    }

    it("asks for access when turned on, after saving, and keeps it on when refused, saying so", async () => {
      const allowed = cameraHarness(true);
      await allowed.act({ setCamera: true });
      expect(allowed.settings.camera).toBe(true);
      expect(allowed.askCameraAccess).toHaveBeenCalledOnce();
      expect(allowed.tray.notifyCameraDenied).not.toHaveBeenCalled();
      expect(allowed.deps.refresh).toHaveBeenCalled();
      const refused = cameraHarness(false);
      await refused.act({ setCamera: true });
      expect(refused.settings.camera).toBe(true);
      expect(refused.tray.notifyCameraDenied).toHaveBeenCalledOnce();
    });

    it("does not ask when turned off or when already on", async () => {
      const ctx = cameraHarness(false);
      await ctx.act({ setCamera: false });
      ctx.settings.camera = true;
      await ctx.act({ setCamera: true });
      expect(ctx.askCameraAccess).not.toHaveBeenCalled();
      expect(ctx.tray.notifyCameraDenied).not.toHaveBeenCalled();
    });

    it("saves the camera and the shape, and hands a new shape to the recording in progress", async () => {
      const layout = { width: 0.2, height: 0.2, rounding: 1, mirror: false, positions: [{ display: "primary", x: 0.1, y: 0.1 }] };
      const settings = { language: "en", cameraLayout: layout, cameraDevice: undefined as { id: string; label: string } | undefined,
        setCameraLayout: vi.fn(async (shape: Omit<typeof layout, "positions">) => { settings.cameraLayout = { ...settings.cameraLayout, ...shape }; }),
        setCameraDevice: vi.fn(async (device: { id: string; label: string } | null) => { settings.cameraDevice = device ?? undefined; }),
        setCameraPosition: vi.fn(async (display: string, position: { x: number; y: number }) => { settings.cameraLayout = withPosition(settings.cameraLayout, display, position); }) };
      const updateCamera = vi.fn(() => true);
      const ctx = harness({ settings, recorder: { updateCamera },
        savePreference: vi.fn(async (_what: string, save: PreferenceSave) => { await save.write(); save.applied?.(); }) } as unknown as Partial<ActionDeps>);
      await ctx.act({ setCameraShape: { width: 0.4 } });
      expect(settings.setCameraLayout).toHaveBeenLastCalledWith({ width: 0.4, height: 0.2, rounding: 1, mirror: false });
      expect(updateCamera).toHaveBeenLastCalledWith({ layout: expect.objectContaining({ width: 0.4, positions: layout.positions }) });
      await ctx.act({ setCameraShape: { height: 0.3 } });
      expect(settings.cameraLayout).toMatchObject({ width: 0.4, height: 0.3 });
      await ctx.act({ setCameraShape: { mirror: true } });
      expect(settings.cameraLayout.mirror).toBe(true);
      await ctx.act({ setCameraPosition: { display: "9", x: 0.25, y: 0.5 } });
      expect(settings.setCameraPosition).toHaveBeenLastCalledWith("9", { x: 0.25, y: 0.5 });
      expect(updateCamera).toHaveBeenLastCalledWith({ layout: expect.objectContaining({ positions: expect.arrayContaining([{ display: "9", x: 0.25, y: 0.5 }]) }) });
      await ctx.act({ setCameraDevice: { id: "iphone", label: "iPhone Camera" } });
      expect(settings.cameraDevice).toEqual({ id: "iphone", label: "iPhone Camera" });
      // The shape is saved unlocked (D7), the device locked as the microphone's.
      const saves = vi.mocked(ctx.deps.savePreference).mock.calls;
      expect(saves.filter(([what]) => what === "camera shape" || what === "camera position").every(([, save]) => !save.locked)).toBe(true);
      expect(saves.find(([what]) => what === "camera device")?.[1].locked).toBe(true);
    });

    it("starts and lets go of a Live preview, reporting done to the Studio (D20)", async () => {
      const startPreview = vi.fn(() => false), stopPreview = vi.fn();
      const ctx = harness({ recorder: { startPreview, stopPreview, state: { type: "recording" } } } as unknown as Partial<ActionDeps>);
      await expect(ctx.act("startPreview")).resolves.toBe(true);
      expect(ctx.deps.log).toHaveBeenCalledWith("studio: Live preview not started in state recording");
      await expect(ctx.act("stopPreview")).resolves.toBe(true);
      expect(stopPreview).toHaveBeenCalledOnce();
      // A choice queued behind a save, from a Studio since closed: no preview.
      const closed = harness({ studioOpen: () => false, recorder: { startPreview, stopPreview, state: { type: "idle" } } } as unknown as Partial<ActionDeps>);
      startPreview.mockClear();
      await closed.act("startPreview");
      expect(startPreview).not.toHaveBeenCalled();
      expect(closed.deps.log).toHaveBeenCalledWith("studio: Live preview not started: the Studio is no longer open");
    });

    it("mutes an input of the recording in progress, and says so when there is none (D19)", async () => {
      const updateAudio = vi.fn(() => true);
      const ctx = harness({ recorder: { updateAudio } } as unknown as Partial<ActionDeps>);
      await ctx.act({ setAudioMuted: { source: "microphone", muted: true } });
      expect(updateAudio).toHaveBeenLastCalledWith({ microphone: true });
      updateAudio.mockReturnValue(false);
      await ctx.act({ setAudioMuted: { source: "system", muted: false } });
      expect(updateAudio).toHaveBeenLastCalledWith({ system: false });
      expect(ctx.deps.log).toHaveBeenCalledWith("audio: no recording to mute or unmute system audio in");
    });

    it("saves an input's volume and gives it to the session in progress, also while recording (D21)", async () => {
      const updateGains = vi.fn(() => true);
      const settings = { audioVolume: { system: 100, microphone: 100 },
        setAudioVolume: vi.fn(async (source: "system" | "microphone", volume: number) => { settings.audioVolume = { ...settings.audioVolume, [source]: volume }; }) };
      const ctx = harness({ recorder: { updateGains, state: { type: "recording", startedAt: "2026-10-18T00:00:00Z" } }, settings,
        savePreference: vi.fn(async (_what: string, save: PreferenceSave) => {
          expect(save.locked, "not locked while recording").toBeFalsy();
          await save.write(); save.applied?.();
        }) } as unknown as Partial<ActionDeps>);
      await ctx.act({ setAudioVolume: { source: "microphone", volume: 250 } });
      expect(settings.setAudioVolume).toHaveBeenCalledWith("microphone", 250);
      expect(updateGains).toHaveBeenCalledTimes(1);
      expect(ctx.deps.log).toHaveBeenCalledWith("settings: volume system 100%, microphone 250%");
    });

    it("hides and shows the camera of the recording in progress, and says so when there is none", async () => {
      const updateCamera = vi.fn((_change: { hidden?: boolean }) => true);
      const ctx = harness({ recorder: { updateCamera } } as unknown as Partial<ActionDeps>);
      await ctx.act({ setCameraHidden: true });
      await ctx.act({ setCameraHidden: false });
      expect(updateCamera.mock.calls).toEqual([[{ hidden: true }], [{ hidden: false }]]);
      expect(ctx.deps.refresh).toHaveBeenCalledTimes(2);
      updateCamera.mockReturnValueOnce(false);
      await ctx.act({ setCameraHidden: true });
      expect(vi.mocked(ctx.deps.log).mock.calls.map((call) => call[0])).toContainEqual(expect.stringContaining("no recording composes the camera"));
    });

    it("opens the camera's privacy page on macOS and Windows and reports whether it opened", async () => {
      for (const platform of ["darwin", "win32"] as const) {
        const ctx = cameraHarness(true, platform);
        expect(await ctx.act("openCameraSettings")).toBe(true);
        expect(ctx.deps.openCameraSettings).toHaveBeenCalledOnce();
        vi.mocked(ctx.deps.openCameraSettings).mockRejectedValueOnce(new Error("refused"));
        expect(await ctx.act("openCameraSettings")).toBe(false);
      }
      const linux = cameraHarness(true, "linux");
      expect(await linux.act("openCameraSettings")).toBe(false);
      expect(linux.deps.openCameraSettings).not.toHaveBeenCalled();
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

    it("switches the recording's microphone, unlocked only while a recording records one (plan 079, D3)", async () => {
      const saves: Array<[string, boolean]> = [];
      const recording = microphoneHarness(true);
      const recorder = recording.deps.recorder as unknown as { audio: unknown; updateMicrophone: ReturnType<typeof vi.fn> };
      vi.mocked(recording.deps.savePreference).mockImplementation(async (what, save) => { saves.push([what, save.locked === true]); await save.write(); save.applied?.(); });
      recorder.audio = { sessionId: "s1", systemMuted: false, microphone: { muted: false } };
      await recording.act({ setMicrophoneDevice: { id: "usb", label: "USB Microphone" } });
      expect(recorder.updateMicrophone).toHaveBeenCalledOnce();
      recorder.audio = { sessionId: "s1", systemMuted: false };
      await recording.act({ setMicrophoneDevice: null });
      expect(saves).toEqual([["microphone device", false], ["microphone device", true]]);
    });

    it("searches for devices at the user's request (plan 079, D2)", async () => {
      const searchMicrophones = vi.fn(async () => {});
      const { act } = harness({ searchMicrophones });
      await act("searchMicrophones");
      expect(searchMicrophones).toHaveBeenCalledOnce();
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
