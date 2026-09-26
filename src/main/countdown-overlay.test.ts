import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COUNTDOWN_TIMING, overlayBounds } from "../shared/countdown";

const mock = vi.hoisted(() => {
  const windows: any[] = [];
  class Window {
    calls: Array<[string, ...unknown[]]> = [];
    events = new Map<string, (...args: any[]) => void>();
    contentEvents = new Map<string, (...args: any[]) => void>();
    destroyed = false;
    sent: unknown[] = [];
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: (name: string, listener: (...args: any[]) => void) => this.contentEvents.set(name, listener),
      once: (name: string, listener: (...args: any[]) => void) => this.contentEvents.set(name, listener),
      send: (_channel: string, value: unknown) => this.sent.push(value),
    };
    constructor(public options: any) {
      windows.push(this);
    }
    private note = (name: string) => (...args: unknown[]) => { this.calls.push([name, ...args]); };
    setAlwaysOnTop = this.note("setAlwaysOnTop");
    setVisibleOnAllWorkspaces = this.note("setVisibleOnAllWorkspaces");
    setIgnoreMouseEvents = this.note("setIgnoreMouseEvents");
    setBounds = this.note("setBounds");
    showInactive = this.note("showInactive");
    show = this.note("show");
    focus = this.note("focus");
    static loadError: Error | undefined;
    loadFile = vi.fn(() => (Window.loadError ? Promise.reject(Window.loadError) : Promise.resolve()));
    loadURL = vi.fn().mockResolvedValue(undefined);
    isDestroyed = () => this.destroyed;
    destroy = vi.fn(() => {
      this.destroyed = true;
      this.events.get("closed")?.();
    });
    on = (name: string, listener: (...args: any[]) => void) => this.events.set(name, listener);
    /** The page finished loading. */
    load(): void {
      this.contentEvents.get("did-finish-load")?.();
    }
    names(): string[] {
      return this.calls.map(([name]) => name);
    }
  }
  return { windows, Window };
});
vi.mock("electron", () => ({ BrowserWindow: mock.Window }));
import { CountdownOverlay, overlayWindowOptions, type CountdownOverlayOptions, type OverlayDisplay } from "./countdown-overlay";

const PRIMARY: OverlayDisplay = { id: "1", bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 25, width: 1512, height: 957 } };
const SECONDARY: OverlayDisplay = { id: "2", bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 0, width: 1920, height: 1055 } };

function overlay(options: Partial<CountdownOverlayOptions> = {}) {
  const logs: string[] = [];
  let resolved: OverlayDisplay | undefined = SECONDARY;
  const presenter = new CountdownOverlay({
    preloadPath: "/out/preload/countdown.js",
    htmlPath: "/out/renderer/countdown.html",
    display: () => resolved,
    primaryDisplay: () => PRIMARY,
    platform: "darwin",
    log: (message) => logs.push(message),
    ...options,
  });
  const window = () => mock.windows.at(-1);
  return { presenter, logs, window, resolve: (display: OverlayDisplay | undefined) => { resolved = display; } };
}

beforeEach(() => {
  mock.windows.length = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("overlay placement", () => {
  it("sits 16 pt from the right of the work area and 12 pt below its top, 88 × 88 pt", () => {
    expect(overlayBounds(PRIMARY.workArea)).toEqual({ x: 1408, y: 37, width: 88, height: 88 });
    expect(overlayBounds(SECONDARY.workArea)).toEqual({ x: -104, y: 12, width: 88, height: 88 });
  });

  it("asks for a transparent, frameless, shadowless, unfocusable, sandboxed window; a non-activating panel on macOS", () => {
    const options = overlayWindowOptions({ x: 1, y: 2, width: 88, height: 88 }, "/p.js", "darwin");
    expect(options).toMatchObject({
      x: 1, y: 2, width: 88, height: 88, show: false, frame: false, transparent: true, backgroundColor: "#00000000",
      hasShadow: false, resizable: false, movable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, type: "panel",
      webPreferences: { preload: "/p.js", sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    });
    expect(overlayWindowOptions({ x: 0, y: 0, width: 88, height: 88 }, "/p.js", "win32")).not.toHaveProperty("type");
  });
});

describe("CountdownOverlay", () => {
  it("prepares a hidden window that floats over full-screen apps and ignores the mouse", () => {
    const { presenter, window } = overlay();
    presenter.prepare();
    presenter.prepare();
    expect(mock.windows).toHaveLength(1);
    expect(window().options).toMatchObject(overlayBounds(PRIMARY.workArea));
    expect(window().calls).toEqual([
      ["setAlwaysOnTop", true, "screen-saver"],
      ["setVisibleOnAllWorkspaces", true, { visibleOnFullScreen: true, skipTransformProcessType: true }],
      ["setIgnoreMouseEvents", true],
    ]);
    expect(window().loadFile).toHaveBeenCalledWith("/out/renderer/countdown.html");
  });

  it("shows inactive on the recorded display only once the page can draw, then updates the digit", () => {
    const { presenter, window, logs } = overlay();
    presenter.prepare();
    presenter.show(3);
    expect(window().calls.at(-1)).toEqual(["setBounds", overlayBounds(SECONDARY.workArea)]);
    expect(window().names()).not.toContain("showInactive");
    window().load();
    expect(window().sent).toEqual([3]);
    expect(window().names()).toContain("showInactive");
    presenter.update(2);
    presenter.update(1);
    expect(window().sent).toEqual([3, 2, 1]);
    // It never activates the app or takes focus.
    expect(window().names()).not.toContain("show");
    expect(window().names()).not.toContain("focus");
    expect(logs).toContain("countdown overlay: display 2 at -104,12 88x88 in display bounds -1920,0 1920x1080");
  });

  it("falls back to the primary display, logged, when the recorded display is unknown", () => {
    const { presenter, window, logs, resolve } = overlay();
    resolve(undefined);
    presenter.show(3);
    expect(mock.windows).toHaveLength(1);
    expect(window().calls.find(([name]: [string]) => name === "setBounds")).toEqual(["setBounds", overlayBounds(PRIMARY.workArea)]);
    expect(logs).toContain("countdown overlay: the recorded display is unknown; using the primary display 1");
  });

  it("dismisses by fading out, then destroys the window before resolving", async () => {
    const { presenter, window } = overlay();
    presenter.show(3);
    window().load();
    let done = false;
    const dismissal = presenter.dismiss().then(() => { done = true; });
    expect(window().sent.at(-1)).toBeNull();
    await vi.advanceTimersByTimeAsync(COUNTDOWN_TIMING.fadeOutMs + COUNTDOWN_TIMING.settleMs - 1);
    expect(window().destroyed).toBe(false);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await dismissal;
    expect(window().destroyed).toBe(true);
  });

  it("destroys at once when the page never loaded, and on close", async () => {
    const first = overlay();
    first.presenter.show(3);
    await first.presenter.dismiss();
    expect(first.window().destroyed).toBe(true);

    const second = overlay();
    second.presenter.show(3);
    second.window().load();
    let done = false;
    void second.presenter.dismiss().then(() => { done = true; });
    second.presenter.close();
    expect(second.window().destroyed).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    second.presenter.close();
    second.presenter.destroy();
    expect(second.window().destroy).toHaveBeenCalledOnce();
  });

  it("never outlives an attempt: a crashed page or failed load closes it, and the next attempt builds a new window", async () => {
    const { presenter, window, logs } = overlay();
    presenter.prepare();
    window().contentEvents.get("render-process-gone")?.({}, { reason: "crashed" });
    expect(window().destroyed).toBe(true);
    expect(logs).toContainEqual(expect.stringContaining("render process gone (crashed)"));
    mock.Window.loadError = new Error("missing page");
    try {
      presenter.prepare();
      expect(mock.windows).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(window().destroyed).toBe(true);
      expect(logs).toContainEqual(expect.stringContaining("page failed to load: Error: missing page"));
    } finally {
      mock.Window.loadError = undefined;
    }
    presenter.show(2);
    expect(mock.windows).toHaveLength(3);
    expect(window().destroyed).toBe(false);
  });

  it("loads the dev server page when one is given", () => {
    const { presenter, window } = overlay({ devUrl: "http://localhost:5173/countdown.html" });
    presenter.prepare();
    expect(window().loadURL).toHaveBeenCalledWith("http://localhost:5173/countdown.html");
    expect(window().loadFile).not.toHaveBeenCalled();
  });
});
