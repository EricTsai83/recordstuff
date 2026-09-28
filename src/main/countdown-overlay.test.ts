import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COUNTDOWN_TIMING, overlayBounds, overlayFontPt, type Rectangle } from "../shared/countdown";

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
      send: (_channel: string, value: unknown) => { this.sent.push(value); this.calls.push(["send", value]); },
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

const SILENT = { sound: false };
const TICKING = { sound: true };
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
  const at = (x: number, y: number, width: number, height: number, menuBar = 0): [Rectangle, Rectangle] =>
    [{ x, y, width, height }, { x, y: y + menuBar, width, height: height - menuBar }];

  it("sizes the digit at 14% of the display's shorter side, in a window 88/56 of it, 16 pt from the right of the work area and 12 pt below its top", () => {
    // 14-inch MacBook Pro: 0.14 × 982 = 137.48 pt → a 216 pt window.
    expect(overlayBounds(PRIMARY.bounds, PRIMARY.workArea)).toEqual({ x: 1280, y: 37, width: 216, height: 216 });
    expect(overlayFontPt(PRIMARY.bounds)).toBeCloseTo(137.48);
    // The maintainer's 1920 × 1080 primary: 151.2 pt → 238 pt.
    expect(overlayBounds(...at(0, 0, 1920, 1080, 25))).toEqual({ x: 1666, y: 37, width: 238, height: 238 });
  });

  it("gives a portrait display the digit of the same panel in landscape, at its own top-right", () => {
    expect(overlayBounds(...at(1920, -420, 1080, 1920, 0))).toEqual({ x: 1920 + 1080 - 16 - 238, y: -408, width: 238, height: 238 });
  });

  it("never draws smaller than 040's 56 pt digit in its 88 pt window, nor larger than 216 pt", () => {
    expect(overlayFontPt({ x: 0, y: 0, width: 640, height: 360 })).toBe(56);
    expect(overlayBounds(...at(0, 0, 640, 360))).toEqual({ x: 536, y: 12, width: 88, height: 88 });
    // A 4K display at 1×: 0.14 × 2160 = 302 pt is clamped to 216 pt → round(339.4) = 339 pt.
    expect(overlayFontPt({ x: 0, y: 0, width: 3840, height: 2160 })).toBe(216);
    expect(overlayBounds(...at(0, 0, 3840, 2160))).toEqual({ x: 3485, y: 12, width: 339, height: 339 });
  });

  it("rounds the window to whole points", () => {
    // 0.14 × 768 = 107.52 pt → 168.96 → 169 pt.
    expect(overlayBounds(...at(0, 0, 1366, 768, 24))).toEqual({ x: 1181, y: 36, width: 169, height: 169 });
  });

  it("places it on a secondary display with a negative origin", () => {
    expect(overlayBounds(SECONDARY.bounds, SECONDARY.workArea)).toEqual({ x: -254, y: 12, width: 238, height: 238 });
  });

  it("asks for a transparent, frameless, shadowless, unfocusable, sandboxed window; a non-activating panel on macOS", () => {
    const options = overlayWindowOptions({ x: 1, y: 2, width: 88, height: 88 }, "/p.js", "darwin");
    expect(options).toMatchObject({
      x: 1, y: 2, width: 88, height: 88, show: false, frame: false, transparent: true, backgroundColor: "#00000000",
      hasShadow: false, resizable: false, movable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, type: "panel",
      webPreferences: { preload: "/p.js", sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
        autoplayPolicy: "no-user-gesture-required" },
    });
    expect(overlayWindowOptions({ x: 0, y: 0, width: 88, height: 88 }, "/p.js", "win32")).not.toHaveProperty("type");
  });
});

describe("CountdownOverlay", () => {
  it("prepares a hidden window that floats over full-screen apps and ignores the mouse", () => {
    const { presenter, window } = overlay();
    presenter.prepare(SILENT);
    presenter.prepare(SILENT);
    expect(mock.windows).toHaveLength(1);
    // Created at the primary display's scaled bounds.
    expect(window().options).toMatchObject({ x: 1280, y: 37, width: 216, height: 216 });
    expect(window().calls).toEqual([
      ["setAlwaysOnTop", true, "screen-saver"],
      ["setVisibleOnAllWorkspaces", true, { visibleOnFullScreen: true, skipTransformProcessType: true }],
      ["setIgnoreMouseEvents", true],
    ]);
    expect(window().loadFile).toHaveBeenCalledWith("/out/renderer/countdown.html", {});
  });

  it("shows inactive on the recorded display only once the page can draw, then updates the digit", () => {
    const { presenter, window, logs } = overlay();
    presenter.prepare(SILENT);
    presenter.show(3, SILENT);
    expect(window().calls.at(-1)).toEqual(["setBounds", { x: -254, y: 12, width: 238, height: 238 }]);
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
    expect(logs).toContain("countdown overlay: display 2 at -254,12 238x238 in display bounds -1920,0 1920x1080");
  });

  it("resizes a loaded window for the recorded display before it sends the first digit", () => {
    const { presenter, window } = overlay();
    presenter.prepare(SILENT);
    window().load();
    presenter.show(3, SILENT);
    const names = window().names();
    expect(names.indexOf("setBounds")).toBeGreaterThan(-1);
    expect(names.indexOf("setBounds")).toBeLessThan(names.indexOf("send"));
    expect(names.indexOf("send")).toBeLessThan(names.indexOf("showInactive"));
    expect(window().calls.find(([name]: [string]) => name === "setBounds")).toEqual(["setBounds", overlayBounds(SECONDARY.bounds, SECONDARY.workArea)]);
  });

  it("falls back to the primary display, logged, when the recorded display is unknown", () => {
    const { presenter, window, logs, resolve } = overlay();
    resolve(undefined);
    presenter.show(3, SILENT);
    expect(mock.windows).toHaveLength(1);
    expect(window().calls.find(([name]: [string]) => name === "setBounds")).toEqual(["setBounds", overlayBounds(PRIMARY.bounds, PRIMARY.workArea)]);
    expect(logs).toContain("countdown overlay: the recorded display is unknown; using the primary display 1");
  });

  it("dismisses by fading out, then destroys the window before resolving", async () => {
    const { presenter, window } = overlay();
    presenter.show(3, SILENT);
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
    first.presenter.show(3, SILENT);
    await first.presenter.dismiss();
    expect(first.window().destroyed).toBe(true);

    const second = overlay();
    second.presenter.show(3, SILENT);
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
    presenter.prepare(SILENT);
    window().contentEvents.get("render-process-gone")?.({}, { reason: "crashed" });
    expect(window().destroyed).toBe(true);
    expect(logs).toContainEqual(expect.stringContaining("render process gone (crashed)"));
    mock.Window.loadError = new Error("missing page");
    try {
      presenter.prepare(SILENT);
      expect(mock.windows).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(window().destroyed).toBe(true);
      expect(logs).toContainEqual(expect.stringContaining("page failed to load: Error: missing page"));
    } finally {
      mock.Window.loadError = undefined;
    }
    presenter.show(2, SILENT);
    expect(mock.windows).toHaveLength(3);
    expect(window().destroyed).toBe(false);
  });

  it("loads the dev server page when one is given", () => {
    const { presenter, window } = overlay({ devUrl: "http://localhost:5173/countdown.html" });
    presenter.prepare(SILENT);
    expect(window().loadURL).toHaveBeenCalledWith("http://localhost:5173/countdown.html");
    expect(window().loadFile).not.toHaveBeenCalled();
  });

  it("tells the page to tick through its query, for the file and the dev server alike (plan 046)", () => {
    const file = overlay();
    file.presenter.prepare(TICKING);
    expect(file.window().loadFile).toHaveBeenCalledWith("/out/renderer/countdown.html", { query: { sound: "1" } });
    const silent = overlay();
    silent.presenter.show(3, SILENT);
    expect(silent.window().loadFile).toHaveBeenCalledWith("/out/renderer/countdown.html", {});
    const dev = overlay({ devUrl: "http://localhost:5173/countdown.html" });
    dev.presenter.show(3, TICKING);
    expect(dev.window().loadURL).toHaveBeenCalledWith("http://localhost:5173/countdown.html?sound=1");
  });

  it("keeps a prepared page for the same flag and loads a new one for a different flag", () => {
    const { presenter, window } = overlay();
    presenter.prepare(TICKING);
    const first = window();
    presenter.show(3, TICKING);
    expect(mock.windows).toHaveLength(1);
    presenter.prepare(SILENT);
    expect(first.destroyed).toBe(true);
    expect(mock.windows).toHaveLength(2);
    expect(window().loadFile).toHaveBeenCalledWith("/out/renderer/countdown.html", {});
  });
});
