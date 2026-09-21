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
    show = vi.fn();
    focus = vi.fn();
    setTitle = vi.fn();
    loadFile = vi.fn(() => load());
    loadURL = vi.fn(() => load());
    destroyed = false;
    isDestroyed = () => this.destroyed;
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
  ipcMain: {
    handle: (name: string, fn: (...args: any[]) => any) => mock.handlers.set(name, fn),
    removeHandler: (name: string) => mock.handlers.delete(name),
  },
}));
import { SettingsWindow } from "./settings-window";
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
};

/** A panel wired to a mutable copy of the committed settings. */
function setup(overrides: { act?: (action: AppAction) => Promise<void>; state?: () => RecordingState } = {}) {
  const live = { ...context };
  let state: RecordingState = { type: "idle" };
  const act = overrides.act ?? vi.fn(async (action: AppAction) => {
    if (typeof action !== "string" && "setLanguage" in action) live.language = action.setLanguage;
  });
  const log = vi.fn();
  const panel = new SettingsWindow({
    state: overrides.state ?? (() => state),
    context: () => live,
    act,
    log,
  });
  return {
    panel,
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
