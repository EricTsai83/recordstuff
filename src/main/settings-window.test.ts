import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_QUALITY } from "../shared/quality";
import { DEFAULT_HOTKEY } from "../shared/hotkey";
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
import type { AppAction, AppContext } from "./ui-model";

const context: AppContext = {
  platform: "darwin",
  outputDir: "/tmp/recordings",
  homeDir: "/tmp",
  quality: DEFAULT_QUALITY,
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
    expect(s.window().webContents.send).toHaveBeenCalledWith("settings:changed", expect.objectContaining({ title: "Settings" }));
    expect(s.window().setTitle).toHaveBeenCalledWith("Settings");
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
    expect(s.read(s.event())).toMatchObject({ title: "Settings" });
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

it("keeps registration suspended through main blur/timeout while a hotkey commit is pending", async () => {
  vi.useFakeTimers();
  try {
    let finish!: () => void;
    const act = vi.fn(async () => new Promise<void>(resolve => { finish = resolve; }));
    const s = setup({ act });
    s.panel.show();
    mock.handlers.get("settings:capture")!(s.event(), true);
    const save = s.choose(s.event(), "hotkey", "Control+K");
    await Promise.resolve();
    expect(act).toHaveBeenCalledTimes(1);
    s.window().events.get("blur")();
    vi.advanceTimersByTime(15_000);
    expect(s.capture).toHaveBeenCalledTimes(1);
    finish();
    await save;
    expect(s.capture.mock.calls).toEqual([[true], [false]]);
  } finally { vi.useRealTimers(); }
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
  const handler = s.window().webContents.on.mock.calls.find((call: any[]) => call[0] === "render-process-gone")[1];
  handler(); expect(s.capture).toHaveBeenLastCalledWith(false);
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
