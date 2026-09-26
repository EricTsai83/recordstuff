import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_QUALITY } from "../shared/quality";
import { DEFAULT_HOTKEY, SETTINGS_SHORTCUT, type HotkeySettings } from "../shared/hotkey";
import type { RecordingState } from "../shared/state";

const mock = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const windows: any[] = [];
  const focus = vi.fn();
  let load: () => Promise<void> = () => Promise.resolve();
  class Window {
    webContents = {
      mainFrame: {},
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      send: vi.fn(),
      isDestroyed: () => false,
    };
    events = new Map<string, () => void>();
    isMinimized = vi.fn(() => false);
    restore = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    setTitle = vi.fn();
    getSize = vi.fn(() => [this.options.width, this.options.height]);
    loadFile = vi.fn(() => load());
    loadURL = vi.fn(() => load());
    destroyed = false;
    isDestroyed = () => this.destroyed;
    isFocused = () => true;
    destroy = vi.fn(() => {
      this.destroyed = true;
      this.events.get("closed")?.();
    });
    once = (name: string, callback: () => void) => this.events.set(name, callback);
    on = this.once;
    constructor(public options: any) {
      windows.push(this);
    }
  }
  return {
    handlers,
    windows,
    focus,
    Window,
    failNextLoad: (reason: string) => {
      load = () => Promise.reject(new Error(reason));
    },
    resetLoad: () => {
      load = () => Promise.resolve();
    },
  };
});
vi.mock("electron", () => ({
  app: { isPackaged: true, focus: mock.focus },
  BrowserWindow: mock.Window,
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workAreaSize: { width: 1440, height: 900 }, workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
  ipcMain: {
    handle: (name: string, fn: (...args: any[]) => any) => mock.handlers.set(name, fn),
    removeHandler: (name: string) => mock.handlers.delete(name),
  },
}));
import { SettingsWindow, type SettingsWindowOptions } from "./settings-window";
import { preferencesUnlocked, type AppAction, type AppContext } from "./ui-model";
import { AppShortcuts } from "./shortcuts";

const context: AppContext = {
  platform: "darwin",
  outputDir: "/tmp/recordings",
  homeDir: "/tmp",
  quality: DEFAULT_QUALITY,
  countdown: 3,
  language: "en",
  hotkey: { ...DEFAULT_HOTKEY, registered: true },
  updates: { state: { kind: "idle" }, enabled: true },
  notifications: true,
  displays: [], display: { kind: "primary" },
};

/** A panel wired to a mutable copy of the committed settings. */
function setup(overrides: { act?: (action: AppAction) => Promise<boolean | void>; state?: () => RecordingState; geometry?: SettingsWindowOptions["geometry"] } = {}) {
  const live = { ...context };
  let state: RecordingState = { type: "idle" };
  const act = overrides.act ?? vi.fn(async (action: AppAction) => {
    if (typeof action !== "string" && "setLanguage" in action) live.language = action.setLanguage;
  });
  const log = vi.fn();
  const capture = vi.fn();
  const panel = new SettingsWindow({
    ...(overrides.geometry ? { geometry: overrides.geometry } : {}),
    capture,
    state: overrides.state ?? (() => state),
    context: () => live,
    act,
    log,
  });
  return {
    panel,
    capture,
    act,
    log,
    live,
    setState: (next: RecordingState) => (state = next),
    window: () => mock.windows[0],
    read: (event: unknown) => mock.handlers.get("settings:read")!(event),
    choose: (event: unknown, group: unknown, choice: unknown) =>
      mock.handlers.get("settings:choose")!(event, group, choice) as Promise<{ view: any; applied: boolean }>,
    event: () => ({ sender: mock.windows[0].webContents, senderFrame: mock.windows[0].webContents.mainFrame }),
  };
}

/** Electron's render-process-gone, as the real webContents reports it. */
function crash(window: any): void {
  window.webContents.on.mock.calls.find((call: any[]) => call[0] === "render-process-gone")[1]({}, { reason: "crashed" });
}
const from = (window: any) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });

beforeEach(() => {
  mock.handlers.clear();
  mock.windows.length = 0;
  mock.focus.mockClear();
  mock.resetLoad();
});

describe("settings window lifecycle", () => {
  it("opens one sandboxed window, brings the menu-bar app forward, and reuses it", () => {
    const s = setup();
    s.panel.show();
    s.panel.show();
    expect(mock.windows).toHaveLength(1);
    expect(mock.focus).toHaveBeenCalledWith({ steal: true });
    expect(mock.focus).toHaveBeenCalledTimes(2);
    expect(s.window().focus).toHaveBeenCalled();
    expect(s.window().options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    });
    // The panel needs a language before its first read can fail.
    expect(s.window().loadFile).toHaveBeenCalledWith(expect.stringContaining("settings.html"), { query: { lang: "en" } });
  });

  it("reopens after the user closes it, and pushes changes only while open", () => {
    const s = setup();
    s.panel.refresh(); // closed: nothing to push, nothing to throw
    s.panel.show();
    s.panel.refresh();
    expect(s.window().webContents.send).toHaveBeenCalledWith("settings:changed", expect.objectContaining({ title: "RecordStuff - Settings" }));
    expect(s.window().setTitle).toHaveBeenCalledWith("RecordStuff - Settings");
    expect(s.window().destroy).not.toHaveBeenCalled();
    s.window().events.get("closed")!();
    s.panel.refresh();
    s.panel.show();
    expect(mock.windows).toHaveLength(2);
  });

  it("destroys the window and logs when the page cannot load", async () => {
    const s = setup();
    mock.failNextLoad("nope");
    s.panel.show();
    await vi.waitFor(() => expect(s.log).toHaveBeenCalledWith(expect.stringContaining("load failed")));
    expect(s.window().destroy).toHaveBeenCalled();
  });

  it("removes its handlers on shutdown", () => {
    const s = setup();
    s.panel.show();
    s.panel.destroy();
    expect(mock.handlers.size).toBe(0);
    expect(s.window().destroy).toHaveBeenCalled();
  });
});

describe("settings window IPC", () => {
  it("trusts an action's own outcome when there is no committed value to compare", async () => {
    // Regression: the macOS notification pane is an action inside the switch's
    // own card, so its `checked` is always false; judging it that way reported
    // every success as "Could not apply this setting" while the pane did open.
    let opened = true;
    const s = setup({ act: vi.fn(async () => opened) });
    s.panel.show();
    await s.read(s.event());
    expect(await s.choose(s.event(), "notifications", "openSettings")).toMatchObject({ applied: true });
    opened = false;
    expect(await s.choose(s.event(), "notifications", "openSettings")).toMatchObject({ applied: false });
  });

  it("still judges a real preference by what is committed, not by the handler", async () => {
    // A handler that claims nothing must not turn an unsaved choice into success.
    const s = setup({ act: vi.fn(async () => undefined) });
    s.panel.show();
    await s.read(s.event());
    expect(await s.choose(s.event(), "notifications", "off")).toMatchObject({ applied: false });
  });

  it("reports a completed update command as applied without a checked preference", async () => {
    const s = setup({ act: vi.fn(async () => undefined) });
    s.panel.show();
    expect(await s.choose(s.event(), "updates", "check")).toMatchObject({ applied: true });
    expect(s.act).toHaveBeenCalledWith("checkUpdates");
  });
  it("answers only its own window's main frame", async () => {
    const s = setup();
    s.panel.show();
    expect(s.read(s.event())).toMatchObject({ title: "RecordStuff - Settings" });
    expect(() => s.read({ sender: {}, senderFrame: {} })).toThrow("Invalid settings sender");
    expect(() => s.read({ sender: s.window().webContents, senderFrame: {} })).toThrow("Invalid settings sender");
    // `ipcMain.handle` turns a thrown error into a rejected invoke for the panel.
    expect(() => s.choose({ sender: {}, senderFrame: {} }, "language", "zh-TW")).toThrow("Invalid settings sender");
    expect(s.act).not.toHaveBeenCalled();
  });

  it("applies an offered choice and reports the committed result", async () => {
    const s = setup();
    s.panel.show();
    const result = await s.choose(s.event(), "language", "zh-TW");
    expect(s.act).toHaveBeenCalledWith({ setLanguage: "zh-TW" });
    expect(result).toMatchObject({ applied: true });
    expect(result.view.language).toBe("zh-TW");
  });

  it("refuses arbitrary ids and locked groups without calling the handler", async () => {
    const s = setup();
    s.panel.show();
    for (const [group, choice] of [["quit", "now"], ["language", "fr"], [7, "zh-TW"]] as Array<[unknown, unknown]>) {
      expect(await s.choose(s.event(), group, choice)).toMatchObject({ applied: false });
    }
    s.setState({ type: "recording", startedAt: "2026-09-20T00:00:00Z" });
    expect(await s.choose(s.event(), "frameRate", "60")).toMatchObject({ applied: false });
    expect(s.act).not.toHaveBeenCalled();
    expect(s.log).toHaveBeenCalledWith(expect.stringContaining("refused"));
  });

  it("reports a save that did not commit, without closing the window", async () => {
    const s = setup({ act: vi.fn(async () => undefined) });
    s.panel.show();
    const result = await s.choose(s.event(), "language", "zh-TW");
    expect(result.applied).toBe(false);
    expect(result.view.language).toBe("en");
    expect(s.window().destroy).not.toHaveBeenCalled();
  });

  it("serializes saves in request order instead of failing the second one", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const act = vi.fn(async (action: AppAction) => {
      const id = JSON.stringify(action);
      order.push(`start ${id}`);
      if (order.length === 1) await gate;
      order.push(`end ${id}`);
    });
    const s = setup({ act });
    s.panel.show();
    const first = s.choose(s.event(), "language", "zh-TW");
    const second = s.choose(s.event(), "videoQuality", "high");
    await vi.waitFor(() => expect(act).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual([
      'start {"setLanguage":"zh-TW"}',
      'end {"setLanguage":"zh-TW"}',
      'start {"setQuality":{"videoQuality":"high"}}',
      'end {"setQuality":{"videoQuality":"high"}}',
    ]);
  });

  it("a failed save does not wedge the queue", async () => {
    const act = vi.fn(async (action: AppAction) => {
      if (typeof action !== "string" && "setLanguage" in action) throw new Error("disk full");
    });
    const s = setup({ act });
    s.panel.show();
    await expect(s.choose(s.event(), "language", "zh-TW")).rejects.toThrow("disk full");
    expect(await s.choose(s.event(), "videoQuality", "high")).toMatchObject({ applied: false });
    expect(act).toHaveBeenCalledTimes(2);
  });
});


it("authorizes capture and restores ownership on cancel, blur, close, timeout and recording lock", () => {
  vi.useFakeTimers();
  try {
    const s = setup();
    s.panel.show();
    const arm = (value: boolean) => mock.handlers.get("settings:capture")!(s.event(), value);
    expect(() => mock.handlers.get("settings:capture")!({ sender: {}, senderFrame: {} }, true)).toThrow();
    for (const end of [() => arm(false), () => s.window().events.get("blur")(), () => vi.advanceTimersByTime(15_000), () => { s.setState({ type: "starting" }); s.panel.refresh(); }]) {
      s.setState({ type: "idle" });
      expect(arm(true).groups.find((g: any) => g.id === "hotkey").capturing).toBe(true);
      end();
      expect(s.capture).toHaveBeenLastCalledWith(false);
    }
    expect(arm(true).groups.find((g: any) => g.id === "hotkey").capturing).toBe(false);
    s.setState({ type: "idle" });
    arm(true);
    s.panel.destroy();
    expect(s.capture).toHaveBeenLastCalledWith(false);
  } finally { vi.useRealTimers(); }
});

it("ends capture even when saving throws and explains rejected candidates", async () => {
  const s = setup({ act: async () => { throw new Error("disk full"); } });
  s.panel.show();
  mock.handlers.get("settings:capture")!(s.event(), true);
  await expect(s.choose(s.event(), "hotkey", "Control+F12")).rejects.toThrow("disk full");
  expect(s.capture).toHaveBeenLastCalledWith(false);
  const result = await s.choose(s.event(), "hotkey", "Shift+R");
  expect(result.applied).toBe(false);
  expect(result.view.groups.find((g: any) => g.id === "hotkey").note).toBe("A shortcut needs Command or Control.");
});

it("keeps capture through a confirmed commit, then ends only that capture", async () => {
  let finish!: () => void;
  const act = vi.fn(async () => new Promise<void>(resolve => { finish = resolve; }));
  const s = setup({ act });
  s.panel.show();
  mock.handlers.get("settings:capture")!(s.event(), true);
  const save = s.choose(s.event(), "hotkey", "Control+K");
  await vi.waitFor(() => expect(act).toHaveBeenCalledTimes(1));
  expect(s.capture.mock.calls).toEqual([[true]]);
  finish();
  await save;
  expect(s.capture.mock.calls).toEqual([[true], [false]]);
});

it("restores a minimized panel, reuses it and creates one replacement after close", () => {
  const s = setup(); s.panel.show();
  const first = s.window(); first.isMinimized.mockReturnValue(true);
  s.panel.show(); s.panel.show();
  expect(mock.windows).toHaveLength(1);
  expect(first.restore).toHaveBeenCalledTimes(2);
  expect(first.focus).toHaveBeenCalledTimes(2);
  first.destroy(); s.panel.show();
  expect(mock.windows).toHaveLength(2);
});
it("rejects the reserved Settings combination with localized feedback and ends capture", async () => {
  const s = setup(); s.panel.show(); s.live.language = "zh-TW";
  mock.handlers.get("settings:capture")!(s.event(), true);
  const result = await s.choose(s.event(), "hotkey", "Alt+CommandOrControl+,");
  expect(result.applied).toBe(false);
  expect(result.view.groups.find((g: any) => g.id === "hotkey").note).toBe("這個組合鍵保留給設定使用。");
  expect(s.act).not.toHaveBeenCalled();
  expect(s.capture).toHaveBeenLastCalledWith(false);
});
it("restores capture ownership after renderer failure", () => {
  const s = setup(); s.panel.show();
  mock.handlers.get("settings:capture")!(s.event(), true);
  crash(s.window()); expect(s.capture).toHaveBeenLastCalledWith(false);
});


it("reauthorizes fixed footer ids during recording and returns link opening failures", async () => {
  const act = vi.fn(async () => false);
  const s = setup({ act, state: () => ({ type: "starting" }) });
  s.panel.show();
  const result = await s.choose(s.event(), "about", "website");
  expect(result.applied).toBe(false);
  expect(result).toHaveProperty("failure", "Could not open the link. Try again.");
  expect(act).toHaveBeenCalledWith("openWebsite");
  await s.choose(s.event(), "about", "https://evil.example");
  expect(act).toHaveBeenCalledTimes(1);
  s.panel.destroy();
});


it("does not report temporary shortcut suspension as an OS conflict while capturing", () => {
  const s = setup(); s.panel.show();
  s.live.hotkey = { ...s.live.hotkey, registered: false };
  const result = mock.handlers.get("settings:capture")!(s.event(), true);
  expect(result.groups.find((g: any) => g.id === "hotkey")).toMatchObject({ capturing: true });
  expect(result.groups.find((g: any) => g.id === "hotkey").diagnostics).toBeUndefined();
  s.panel.destroy();
});


it("reports save refusal rather than static screen help when recording starts", async () => {
  const s = setup({ state: () => ({ type: "starting" }) }); s.panel.show();
  const result = await s.choose(s.event(), "screen", "primary");
  expect(result).toHaveProperty("failure", "Could not apply this setting. Your current settings are shown.");
  expect(result.applied).toBe(false);
  expect(s.act).not.toHaveBeenCalled(); s.panel.destroy();
});


describe("settings window size", () => {
  it("uses a compact default and fits saved dimensions to the display", () => {
    const fresh = setup(); fresh.panel.show();
    expect(fresh.window().options).toMatchObject({ width: 560, height: 680 });
    fresh.panel.destroy(); mock.windows.length = 0;
    const saved = setup({ geometry: { size: { width: 2000, height: 1500 }, save: vi.fn() } });
    saved.panel.show();
    expect(saved.window().options).toMatchObject({ width: 1440, height: 900 });
    saved.panel.destroy();
  });
  it("debounces resize writes and flushes the final size before closing/reopening", () => {
    vi.useFakeTimers();
    try {
      const geometry = { size: { width: 600, height: 700 }, save: vi.fn() };
      const s = setup({ geometry }); s.panel.show();
      s.window().getSize.mockReturnValue([620, 710]); s.window().events.get("resize")!();
      s.window().getSize.mockReturnValue([640, 730]); s.window().events.get("resize")!();
      expect(geometry.save).not.toHaveBeenCalled();
      vi.advanceTimersByTime(250);
      expect(geometry.save).toHaveBeenCalledExactlyOnceWith({ width: 640, height: 730 });
      s.window().getSize.mockReturnValue([660, 750]); s.window().events.get("resize")!();
      s.window().events.get("close")!(); s.window().events.get("closed")!();
      expect(geometry.save).toHaveBeenLastCalledWith({ width: 660, height: 750 });
      s.panel.show(); expect(mock.windows[1].options).toMatchObject({ width: 660, height: 750 });
      s.panel.destroy(); vi.runAllTimers(); expect(geometry.save).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it("flushes pending size on shutdown and ignores minimize dimensions", () => {
    const geometry = { size: { width: 600, height: 700 }, save: vi.fn() };
    const s = setup({ geometry }); s.panel.show();
    s.window().isMinimized.mockReturnValue(true);
    s.window().getSize.mockReturnValue([0, 0]); s.window().events.get("resize")!();
    s.window().isMinimized.mockReturnValue(false);
    s.window().getSize.mockReturnValue([700, 800]); s.window().events.get("resize")!();
    s.panel.destroy();
    expect(geometry.save).toHaveBeenCalledExactlyOnceWith({ width: 700, height: 800 });
  });
});

it("explicit result entry focuses via a stable token without acknowledging the result", () => {
  const s = setup();
  s.live.recordingResults = [{ id: "f", code: "disk_full", detail: "", occurredAt: "2026-09-24T12:00:00Z", outcome: "empty", acknowledged: false }];
  s.panel.showRecordingResult();
  expect(s.read(s.event())).toMatchObject({ resultFocus: 1, recordingResults: [{ acknowledged: false }] });
  s.panel.refresh();
  expect(s.read(s.event()).resultFocus).toBe(1);
  s.panel.showRecordingResult();
  expect(s.read(s.event()).resultFocus).toBe(2);
  expect(s.act).not.toHaveBeenCalled();
  s.panel.destroy();
});

it("routes the exact offered recording result through act and returns its applied result", async () => {
  const act = vi.fn(async (_action: AppAction) => false);
  const ctx = setup({ act });
  ctx.live.recordingResults = [{ id: "failure-a", occurredAt: "2026-09-24T12:00:00Z", code: "disk_full", detail: "", outcome: "empty", acknowledged: false }];
  ctx.panel.show();
  await Promise.resolve();
  expect((await ctx.choose(ctx.event(), "recordingResult:old", "acknowledge")).applied).toBe(false);
  expect(act).not.toHaveBeenCalled();
  expect((await ctx.choose(ctx.event(), "recordingResult:failure-a", "acknowledge")).applied).toBe(false);
  expect(act).toHaveBeenCalledExactlyOnceWith({ recordingResult: { id: "failure-a", action: "acknowledge" } });
  act.mockResolvedValueOnce(true);
  expect((await ctx.choose(ctx.event(), "recordingResult:failure-a", "acknowledge")).applied).toBe(true);
  ctx.panel.destroy();
});

it("runs a result action beside preference saves and shortcut capture instead of queueing behind them", async () => {
  let releasePreference!: () => void, releaseResult!: (applied: boolean) => void;
  const act = vi.fn((action: AppAction) => typeof action !== "string" && "recordingResult" in action
    ? new Promise<boolean>(resolve => { releaseResult = resolve; })
    : new Promise<void>(resolve => { releasePreference = resolve; }));
  const s = setup({ act });
  s.live.recordingResults = [{ id: "f", occurredAt: "2026-09-24T12:00:00Z", code: "disk_full", detail: "", outcome: "empty", acknowledged: false }];
  s.panel.show();
  const preference = s.choose(s.event(), "language", "zh-TW");
  const result = s.choose(s.event(), "recordingResult:f", "acknowledge");
  await vi.waitFor(() => expect(act).toHaveBeenCalledTimes(2));
  expect(mock.handlers.get("settings:capture")!(s.event(), true)).toBeTruthy();
  releaseResult(false);
  expect(await result).toMatchObject({ applied: false, failure: expect.any(String) });
  // A slow durable save neither ends capture nor waits for the preference queue.
  expect(s.capture).toHaveBeenCalledExactlyOnceWith(true);
  const another = s.choose(s.event(), "recordingResult:f", "acknowledge");
  await vi.waitFor(() => expect(act).toHaveBeenCalledTimes(3));
  releaseResult(true);
  expect(await another).toMatchObject({ applied: true });
  releasePreference();
  await preference;
  s.panel.destroy();
});

/**
 * The panel wired to the production shortcut owner, a fake OS registry and a
 * settings store whose writes stay pending until the test settles them.
 */
function wired() {
  const registered = new Map<string, () => void>();
  const globalShortcut = {
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (registered.has(accelerator)) return false;
      registered.set(accelerator, callback);
      return true;
    }),
    unregister: vi.fn((accelerator: string) => { registered.delete(accelerator); }),
  };
  let saved: HotkeySettings = { ...DEFAULT_HOTKEY };
  let state: RecordingState = { type: "idle" };
  const writes: Array<{ setting: HotkeySettings; succeed: () => void; fail: () => void }> = [];
  const store = {
    get hotkey() { return saved; },
    setHotkey: (setting: HotkeySettings) => new Promise<void>((resolve, reject) => writes.push({
      setting, succeed: () => { saved = { ...setting }; resolve(); }, fail: () => reject(new Error("controlled write failure")),
    })),
  };
  const writeFailed = vi.fn();
  let panel!: SettingsWindow;
  const refresh = (): void => panel.refresh();
  const setState = (next: RecordingState): void => { state = next; panel.refresh(); shortcuts.flush(); };
  const toggle = vi.fn(() => setState(state.type === "idle" ? { type: "recording", startedAt: "2026-09-25T00:00:00Z" } : { type: "idle" }));
  const shortcuts = new AppShortcuts({
    globalShortcut, platform: "darwin", toggle, store, settled: () => preferencesUnlocked(state), log: () => undefined,
    openSettings: () => panel.show(), notifyRegistrationFailed: vi.fn(), notifyWriteFailed: writeFailed, refresh,
  });
  panel = new SettingsWindow({
    state: () => state,
    context: () => ({ ...context, hotkey: { ...saved, registered: shortcuts.registered } }),
    capture: armed => shortcuts.capture(armed),
    // The same routing as main's handleAction for this action.
    act: async action => { if (typeof action !== "string" && "setHotkey" in action) await shortcuts.set(action.setHotkey); },
    log: () => undefined,
  });
  shortcuts.start();
  const latest = () => mock.windows.at(-1);
  return {
    panel, writes, writeFailed, toggle, setState,
    saved: () => saved,
    live: () => [...registered.keys()].sort(),
    press: (accelerator: string) => registered.get(accelerator)?.(),
    latest,
    arm: (armed = true, window = latest()) => mock.handlers.get("settings:capture")!(from(window), armed),
    choose: (group: string, choice: string, window = latest()) =>
      mock.handlers.get("settings:choose")!(from(window), group, choice) as Promise<{ view: any; applied: boolean }>,
    shown: (window = latest()) => {
      const group = mock.handlers.get("settings:read")!(from(window)).groups.find((g: any) => g.id === "hotkey");
      return { value: group.choices.find((c: any) => c.checked)?.id, capturing: group.capturing, unavailable: Boolean(group.diagnostics?.length) };
    },
  };
}
const OLD = [DEFAULT_HOTKEY.accelerator, SETTINGS_SHORTCUT].sort();
const NEW = ["Control+K", SETTINGS_SHORTCUT].sort();

describe("capture lease and the confirmed save it started", () => {
  const releases: Array<[string, (w: ReturnType<typeof wired>) => void]> = [
    ["cancel", w => w.arm(false)],
    ["blur", w => w.latest().events.get("blur")()],
    ["timeout", () => vi.advanceTimersByTime(15_000)],
    ["close", w => w.latest().destroy()],
    ["renderer failure", w => crash(w.latest())],
    ["shutdown", w => w.panel.destroy()],
  ];
  for (const [name, release] of releases) for (const outcome of ["success", "failure"] as const) {
    it(`${name} during a stalled ${outcome} restores the committed keys at once; the save decides afterwards`, async () => {
      vi.useFakeTimers();
      try {
        const w = wired();
        w.panel.show();
        expect(w.live()).toEqual(OLD);
        w.arm();
        expect(w.live()).toEqual([]);
        const save = w.choose("hotkey", "Control+K");
        await vi.waitFor(() => expect(w.writes).toHaveLength(1));
        release(w);
        // Suspension ends now, not when the stalled write returns.
        expect(w.live()).toEqual(OLD);
        vi.advanceTimersByTime(20_000);
        expect(w.live()).toEqual(OLD);
        expect(w.saved()).toEqual(DEFAULT_HOTKEY);
        if (outcome === "success") w.writes[0]!.succeed(); else w.writes[0]!.fail();
        await save;
        expect(w.live()).toEqual(outcome === "success" ? NEW : OLD);
        expect(w.saved()).toEqual(outcome === "success" ? { enabled: true, accelerator: "Control+K" } : DEFAULT_HOTKEY);
        expect(w.writeFailed).toHaveBeenCalledTimes(outcome === "success" ? 0 : 1);
        if (name !== "shutdown") {
          w.panel.show();
          expect(w.shown()).toEqual({ value: outcome === "success" ? "Control+K" : DEFAULT_HOTKEY.accelerator, capturing: false, unavailable: false });
        }
      } finally { vi.useRealTimers(); }
    });
  }

  it("a recording started with the restored key keeps it as the stop key until it settles", async () => {
    const w = wired();
    w.panel.show(); w.arm();
    const save = w.choose("hotkey", "Control+K");
    await vi.waitFor(() => expect(w.writes).toHaveLength(1));
    w.latest().destroy();
    w.press(DEFAULT_HOTKEY.accelerator);
    expect(w.toggle).toHaveBeenCalledTimes(1);
    w.writes[0]!.succeed();
    await save;
    expect(w.saved().accelerator).toBe("Control+K");
    // Saved, not yet live: the recording can still be stopped with its own key.
    expect(w.live()).toEqual(OLD);
    w.panel.show();
    expect(w.shown()).toMatchObject({ value: "Control+K", unavailable: true });
    w.press(DEFAULT_HOTKEY.accelerator);
    expect(w.toggle).toHaveBeenCalledTimes(2);
    expect(w.live()).toEqual(NEW);
    expect(w.shown()).toEqual({ value: "Control+K", capturing: false, unavailable: false });
  });

  it("an old save finishing while a reopened window captures neither ends nor pre-empts that capture", async () => {
    const w = wired();
    w.panel.show(); w.arm();
    const save = w.choose("hotkey", "Control+K");
    await vi.waitFor(() => expect(w.writes).toHaveLength(1));
    const first = w.latest();
    first.destroy();
    w.panel.show();
    expect(w.latest()).not.toBe(first);
    expect(w.shown().value).toBe(DEFAULT_HOTKEY.accelerator);
    w.arm();
    expect(w.live()).toEqual([]);
    w.writes[0]!.succeed();
    await save;
    // The new window sees the committed value while its capture still holds both keys.
    expect(w.shown()).toEqual({ value: "Control+K", capturing: true, unavailable: false });
    expect(w.live()).toEqual([]);
    // The old window can no longer reach this capture.
    expect(() => w.arm(false, first)).toThrow("Invalid settings sender");
    expect(w.live()).toEqual([]);
    w.arm(false);
    expect(w.live()).toEqual(NEW);
  });

  it("a crash abandons an unconfirmed draft: nothing is saved and the committed keys return", () => {
    const w = wired();
    w.panel.show(); w.arm();
    crash(w.latest());
    expect(w.writes).toHaveLength(0);
    expect(w.live()).toEqual(OLD);
    w.panel.show();
    expect(w.shown()).toEqual({ value: DEFAULT_HOTKEY.accelerator, capturing: false, unavailable: false });
  });
});

describe("crashed and replaced settings windows", () => {
  it("disposes a crashed window so the next show creates and loads a usable one, without reloading on its own", () => {
    const s = setup();
    for (let round = 1; round <= 3; round++) {
      s.panel.show();
      const window = mock.windows.at(-1);
      expect(mock.windows).toHaveLength(round);
      expect(window.loadFile).toHaveBeenCalledTimes(1);
      crash(window);
      expect(window.destroy).toHaveBeenCalledTimes(1);
      expect(() => s.read(from(window))).toThrow("Invalid settings sender");
      // Nothing is recreated until the user asks again.
      expect(mock.windows).toHaveLength(round);
    }
    s.panel.show();
    expect(mock.windows).toHaveLength(4);
    expect(s.read(from(mock.windows[3]))).toMatchObject({ title: "RecordStuff - Settings" });
    expect(s.log).toHaveBeenCalledWith(expect.stringContaining("renderer gone (crashed)"));
  });

  it("late events from an old window cannot clear its replacement or release the replacement's capture", () => {
    const s = setup();
    s.panel.show();
    const old = mock.windows[0];
    crash(old);
    s.panel.show();
    const replacement = mock.windows[1];
    mock.handlers.get("settings:capture")!(from(replacement), true);
    old.events.get("blur")();
    old.events.get("closed")();
    crash(old);
    expect(s.capture.mock.calls).toEqual([[true]]);
    expect(s.read(from(replacement)).groups.find((g: any) => g.id === "hotkey").capturing).toBe(true);
    s.panel.show();
    expect(mock.windows).toHaveLength(2);
    expect(replacement.focus).toHaveBeenCalled();
  });

  it("a failed load is disposed and the next show loads a working window", async () => {
    const s = setup();
    mock.failNextLoad("nope");
    s.panel.show();
    await vi.waitFor(() => expect(mock.windows[0].destroy).toHaveBeenCalled());
    mock.resetLoad();
    s.panel.show();
    expect(mock.windows).toHaveLength(2);
    expect(mock.windows[1].loadFile).toHaveBeenCalledTimes(1);
    expect(s.read(from(mock.windows[1]))).toMatchObject({ title: "RecordStuff - Settings" });
  });
});
