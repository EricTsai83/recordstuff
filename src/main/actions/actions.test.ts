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
    clearVersionCache: vi.fn(async () => true),
    removeKeptEdits: vi.fn(async () => true),
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
  describe("the first-launch guide (2026-10-26)", () => {
    function guideHarness(allowed: boolean, platform: NodeJS.Platform = "darwin") {
      const settings = { language: "en", microphone: true, camera: true,
        setMicrophone: vi.fn(async (on: boolean) => { settings.microphone = on; }), setCamera: vi.fn(async (on: boolean) => { settings.camera = on; }) };
      const onboarding = { open: vi.fn(), finish: vi.fn(async () => true) };
      const access: Record<string, string> = { microphone: "granted", camera: "granted" };
      const settingsWindow = { show: vi.fn(), showStudio: vi.fn() };
      const askMicrophoneAccess = vi.fn(async () => allowed), askCameraAccess = vi.fn(async () => allowed);
      const ctx = harness({ platform, settings, onboarding, settingsWindow, askMicrophoneAccess, askCameraAccess, inputAccess: (input: string) => access[input],
        savePreference: vi.fn(async (_what: string, save: PreferenceSave) => { await save.write(); save.applied?.(); }) } as unknown as Partial<ActionDeps>);
      return { ...ctx, settings, onboarding, settingsWindow, askMicrophoneAccess, askCameraAccess, access };
    }

    it("asks macOS as a guide's switch is turned on when it was never asked, and turned off asks nothing (2026-11-01)", async () => {
      const ctx = guideHarness(true);
      ctx.access.microphone = "not-determined";
      await ctx.act({ setOnboardingInput: { input: "microphone", enabled: false } });
      expect(ctx.askMicrophoneAccess).not.toHaveBeenCalled();
      await ctx.act({ setOnboardingInput: { input: "microphone", enabled: true } });
      expect(ctx.askMicrophoneAccess).toHaveBeenCalledTimes(1);
      expect(ctx.settings.setMicrophone.mock.calls).toEqual([[false], [true]]);
      // Allowed already: saved, nothing asked.
      await ctx.act({ setOnboardingInput: { input: "camera", enabled: true } });
      expect(ctx.askCameraAccess).not.toHaveBeenCalled();
      expect(ctx.settings.camera).toBe(true);
    });

    it("turns a guide's switch back off when macOS is refused at its prompt, the user's own answer (2026-11-01)", async () => {
      const ctx = guideHarness(false);
      ctx.access.camera = "not-determined";
      await ctx.act({ setOnboardingInput: { input: "camera", enabled: true } });
      expect(ctx.askCameraAccess).toHaveBeenCalledTimes(1);
      expect(ctx.settings.camera).toBe(false);
      expect(ctx.deps.log).toHaveBeenCalledWith("settings: camera access is not allowed: turned off (setup guide)");
    });

    it("keeps a guide's switch on and opens System Settings when macOS refused before, as it asks only once (2026-11-01)", async () => {
      const ctx = guideHarness(true);
      ctx.access.microphone = "denied";
      ctx.settings.microphone = false;
      await ctx.act({ setOnboardingInput: { input: "microphone", enabled: true } });
      expect(ctx.askMicrophoneAccess).not.toHaveBeenCalled();
      expect(ctx.settings.microphone).toBe(true);
      expect(ctx.deps.log).toHaveBeenCalledWith(expect.stringContaining("microphone"));
    });

    it("turns off, as it closes, an input left on that macOS was never asked for, and keeps an allowed one (review F1)", async () => {
      const ctx = guideHarness(true);
      ctx.access.camera = "not-determined";
      expect(await ctx.act({ finishOnboarding: {} })).toBe(true);
      expect(ctx.settings.camera).toBe(false);
      expect(ctx.settings.microphone).toBe(true);
      expect(ctx.askCameraAccess).not.toHaveBeenCalled();
      expect(ctx.deps.log).toHaveBeenCalledWith("settings: camera off as the setup guide closed without asking macOS");
    });

    it("stays open and says the press failed when the guide cannot be saved as done (review F3)", async () => {
      const ctx = guideHarness(true);
      ctx.onboarding.finish.mockResolvedValueOnce(false);
      expect(await ctx.act({ finishOnboarding: { then: "studio" } })).toBe(false);
      expect(ctx.settingsWindow.showStudio).not.toHaveBeenCalled();
    });

    it("asks macOS at Allow, keeps an allowed input on and turns a refused one off, answering at once either way", async () => {
      const allowed = guideHarness(true);
      expect(await allowed.act("askMicrophone")).toBe(true);
      expect(allowed.askMicrophoneAccess).toHaveBeenCalledOnce();
      expect(allowed.settings.microphone).toBe(true);
      expect(allowed.deps.refresh).toHaveBeenCalled();
      const refused = guideHarness(false);
      expect(await refused.act("askCamera")).toBe(true);
      expect(refused.settings.camera).toBe(false);
      expect(refused.settings.setCamera.mock.calls).toEqual([[false]]);
      expect(refused.deps.log).toHaveBeenCalledWith("settings: camera access is not allowed: turned off");
    });

    it("asks nothing for an input that is off, or anywhere but macOS", async () => {
      const off = guideHarness(true);
      off.settings.microphone = false;
      expect(await off.act("askMicrophone")).toBe(false);
      expect(off.askMicrophoneAccess).not.toHaveBeenCalled();
      const windows = guideHarness(true, "win32");
      expect(await windows.act("askCamera")).toBe(false);
      expect(await windows.act("showOnboarding")).toBe(false);
      expect(windows.askCameraAccess).not.toHaveBeenCalled();
    });

    it("opens the guide again, and finishes it, into the Recording Studio when asked", async () => {
      const ctx = guideHarness(true);
      expect(await ctx.act("showOnboarding")).toBe(true);
      expect(ctx.onboarding.open).toHaveBeenCalledOnce();
      expect(await ctx.act({ finishOnboarding: {} })).toBe(true);
      expect(ctx.settingsWindow.showStudio).not.toHaveBeenCalled();
      expect(await ctx.act({ finishOnboarding: { then: "studio" } })).toBe(true);
      expect(ctx.onboarding.finish).toHaveBeenCalledTimes(2);
      expect(ctx.settingsWindow.showStudio).toHaveBeenCalledOnce();
    });
  });

  it("makes only the recording Start editable recording begins editable, and only from idle (2026-10-25)", async () => {
    const editableOnce = vi.fn();
    const { deps, act } = harness({ editableOnce });
    expect(await act("startEditable")).toBe(true);
    expect(editableOnce).toHaveBeenCalledTimes(1);
    expect(deps.recorder.startIfIdle).toHaveBeenCalledTimes(1);
    (deps.recorder as { state: { type: string } }).state = { type: "recording" };
    expect(await act("startEditable")).toBe(true);
    expect(editableOnce).toHaveBeenCalledTimes(1);
    expect(deps.recorder.startIfIdle).toHaveBeenCalledTimes(1);
  });

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
      { setAppearance: "dark" }, { setLanguage: "zh-TW" }, { setCountdown: 3 }, { setCountdownSound: true }, { setHideMenuBar: true }, { setHideDock: true }, { setHideDesktop: true },
      { setStudioOnStart: true },
      { setQuality: { level: "standard", resolutionCap: "1080p", frameRate: 30 } },
      { setSystemAudio: false }, { setMicrophone: false }, { setMicrophoneDevice: null },
    ] as AppAction[];
    for (const action of actions) await act(action);
    expect(Object.fromEntries(saves.map(({ what, save }) => [what, save.locked === true]))).toEqual({
      display: true, "update checks": true, notifications: true, "tray click": false, "file name": true,
      "library layout": false, "library preview sound": false, appearance: false, language: false, countdown: true, "countdown sound": true, "hide menu bar": true, "hide Dock": true, "hide desktop icons and widgets": true, "Recording Studio on start": true, quality: true,
      "system audio": true, microphone: true, "microphone device": true,
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

    it("asks for access when turned on, after saving, and turns it back off when refused, saying so", async () => {
      const allowed = cameraHarness(true);
      await allowed.act({ setCamera: true });
      expect(allowed.settings.camera).toBe(true);
      expect(allowed.askCameraAccess).toHaveBeenCalledOnce();
      expect(allowed.tray.notifyCameraDenied).not.toHaveBeenCalled();
      expect(allowed.deps.refresh).toHaveBeenCalled();
      const refused = cameraHarness(false);
      await refused.act({ setCamera: true });
      expect(refused.settings.camera).toBe(false);
      expect(refused.settings.setCamera.mock.calls).toEqual([[true], [false]]);
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

  it("saves the System audio switch and redraws, asking for nothing (plan 101)", async () => {
    const settings = { language: "en", systemAudio: true, setSystemAudio: vi.fn(async (on: boolean) => { settings.systemAudio = on; }) };
    const ctx = harness({ settings, savePreference: vi.fn(async (_what: string, save: PreferenceSave) => { await save.write(); save.applied?.(); }) } as unknown as Partial<ActionDeps>);
    await ctx.act({ setSystemAudio: false });
    expect(settings.setSystemAudio.mock.calls).toEqual([[false]]);
    expect(ctx.deps.refresh).toHaveBeenCalled();
    expect(ctx.deps.log).toHaveBeenCalledWith("settings: system audio off");
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

    it("asks for access when turned on, after saving, and turns it back off when refused, saying so", async () => {
      const allowed = microphoneHarness(true);
      await allowed.act({ setMicrophone: true });
      expect(allowed.settings.microphone).toBe(true);
      expect(allowed.askMicrophoneAccess).toHaveBeenCalledOnce();
      expect(allowed.tray.notifyMicrophoneDenied).not.toHaveBeenCalled();
      expect(allowed.deps.refresh).toHaveBeenCalled();

      const refused = microphoneHarness(false);
      await refused.act({ setMicrophone: true });
      expect(refused.settings.microphone).toBe(false);
      expect(refused.settings.setMicrophone.mock.calls).toEqual([[true], [false]]);
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

    it("searches for devices at the user's request (plan 079, D2), answering applied without waiting for the listing", async () => {
      let finish!: () => void;
      const searchMicrophones = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
      const { act } = harness({ searchMicrophones });
      expect(await act("searchMicrophones")).toBe(true);
      expect(searchMicrophones).toHaveBeenCalledOnce();
      finish();
    });

    it("answers a relaunch request as applied, whether it relaunches now or after the saves", async () => {
      const { act, deps } = harness();
      expect(await act("relaunch")).toBe(true);
      expect(deps.relaunch).toHaveBeenCalledOnce();
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

  it("routes a missing input's ways out from a failure record to its privacy page and to Recording settings (2026-10-31)", async () => {
    let effects: { inputPrivacy(input: "microphone" | "camera"): Promise<boolean>; inputSettings(): Promise<void> } | undefined;
    const act = vi.fn(async (_id: string, _action: string, given: typeof effects) => { effects = given; return true; });
    const ctx = harness({ recordingResults: { act }, openMicrophoneSettings: vi.fn(async () => {}), openCameraSettings: vi.fn(async () => {}) } as unknown as Partial<ActionDeps>);
    expect(await ctx.act({ recordingResult: { id: "mic", action: "inputPrivacy" } })).toBe(true);
    expect(act).toHaveBeenCalledWith("mic", "inputPrivacy", expect.anything());
    expect([await effects!.inputPrivacy("microphone"), await effects!.inputPrivacy("camera")]).toEqual([true, true]);
    await effects!.inputSettings();
    expect([vi.mocked(ctx.deps.openMicrophoneSettings).mock.calls.length, vi.mocked(ctx.deps.openCameraSettings).mock.calls.length,
      vi.mocked(ctx.deps.settingsWindow.showRecording).mock.calls.length]).toEqual([1, 1, 1]);
    // A pane the system refused to open answers false, so the row says the action did not complete (review F1).
    vi.mocked(ctx.deps.openMicrophoneSettings).mockRejectedValueOnce(new Error("refused"));
    expect(await effects!.inputPrivacy("microphone")).toBe(false);
  });

  it("saves hiding the menu bar, the Dock and the desktop only on macOS (plan 076, D6; plan 099)", async () => {
    const windows = harness({ platform: "win32" });
    for (const action of [{ setHideMenuBar: true }, { setHideDock: true }, { setHideDesktop: true }]) await windows.act(action);
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
