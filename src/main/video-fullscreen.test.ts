import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  class FakeWindow {
    static instances: FakeWindow[] = [];
    readonly events = new Map<string, () => void>();
    opacity = 1;
    shown = false;
    simple = false;
    destroyed = false;
    loaded: { file: string; query: Record<string, string> } | undefined;
    readonly contentsEvents = new Map<string, (...args: unknown[]) => void>();
    readonly webContents = { setWindowOpenHandler: () => {}, on: (event: string, listener: (...args: unknown[]) => void) => { this.contentsEvents.set(event, listener); } };
    constructor(readonly options: Record<string, unknown>) { FakeWindow.instances.push(this); }
    on(event: string, listener: () => void): this { this.events.set(event, listener); return this; }
    setOpacity(value: number): void { this.opacity = value; }
    getOpacity(): number { return this.opacity; }
    show(): void { this.shown = true; }
    focus(): void {}
    setSimpleFullScreen(on: boolean): void { this.simple = on; }
    isSimpleFullScreen(): boolean { return this.simple; }
    isDestroyed(): boolean { return this.destroyed; }
    loadFile(file: string, options: { query: Record<string, string> }): Promise<void> { this.loaded = { file, query: options.query }; return Promise.resolve(); }
    loadURL(): Promise<void> { return Promise.resolve(); }
    close(): void { this.events.get("close")?.(); this.destroy(); }
    destroy(): void { if (this.destroyed) return; this.destroyed = true; this.events.get("closed")?.(); }
  }
  return { FakeWindow, handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>() };
});
vi.mock("electron", () => ({
  BrowserWindow: electron.FakeWindow,
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => electron.handlers.set(channel, handler) },
}));

const { VideoFullScreen } = await import("./video-fullscreen");
type Window = InstanceType<typeof electron.FakeWindow>;

const display = { x: 0, y: 0, width: 1920, height: 1080 };
const state = { time: 12.5, playing: true, volume: 0.8, muted: false };
const from = (window: Window) => ({ sender: window.webContents });
const ready = (window: Window) => electron.handlers.get("video:ready")!(from(window));
const exit = (window: Window, value: unknown) => electron.handlers.get("video:exit")!(from(window), value);

describe("a recording played full screen in a window of its own (2026-10-05)", () => {
  beforeEach(() => { vi.useFakeTimers(); electron.FakeWindow.instances.length = 0; electron.handlers.clear(); });
  afterEach(() => vi.useRealTimers());
  const create = (platform: NodeJS.Platform = "darwin") => new VideoFullScreen({ preloadPath: "/p/video.js", htmlPath: "/r/video.html", platform, log: vi.fn() });

  it("covers the screen hidden and black, fades in on the first frame, and hands the time back as it fades out", async () => {
    const closed = vi.fn();
    const playing = create().play({ src: "recordstuff-media://video/abc?v=1", state, display, language: "zh-TW", closed });
    const window = electron.FakeWindow.instances[0]!;
    expect(window.options).toMatchObject({ ...display, show: false, frame: false, backgroundColor: "#000000", fullscreenable: false });
    expect([window.opacity, window.loaded]).toEqual([0, { file: "/r/video.html", query: { src: "recordstuff-media://video/abc?v=1", t: "12.5", play: "1", vol: "0.8", mute: "0", lang: "zh-TW" } }]);
    // The page's first frame: the screen is covered (the simple kind, already the screen's size), then it fades in.
    await ready(window);
    expect([window.simple, window.shown]).toEqual([true, true]);
    vi.advanceTimersByTime(200);
    expect(window.opacity).toBe(1);
    // Leaving answers at once, so the player seeks under the fade; the window then fades out and closes.
    await exit(window, { time: 30, playing: false, volume: 0.8, muted: true });
    await expect(playing).resolves.toEqual({ time: 30, playing: false, volume: 0.8, muted: true });
    expect(window.destroyed).toBe(false);
    vi.advanceTimersByTime(200);
    // Closed in its simple fullscreen: the menu bar and the Dock come back first.
    expect([window.destroyed, window.simple, closed.mock.calls.length]).toEqual([true, false, 1]);
  });

  it("listens only to its own page, and an exit it cannot read hands nothing back", async () => {
    const playing = create().play({ src: "s", state, display, language: "en" });
    const window = electron.FakeWindow.instances[0]!;
    await electron.handlers.get("video:ready")!({ sender: {} });
    expect(window.shown).toBe(false);
    await exit(window, { time: -1, playing: true, volume: 1, muted: false });
    await expect(playing).resolves.toBeUndefined();
  });

  it("shows a page that never reports its first frame, to be left again", () => {
    void create().play({ src: "s", state, display, language: "en" });
    const window = electron.FakeWindow.instances[0]!;
    vi.advanceTimersByTime(2000);
    expect(window.shown).toBe(true);
  });

  it("ends the one before when asked again, and ends at once when its player's window goes", async () => {
    const video = create();
    const first = video.play({ src: "a", state, display, language: "en" });
    const second = video.play({ src: "b", state, display, language: "en" });
    await expect(first).resolves.toBeUndefined();
    // Never shown: it simply goes.
    expect(electron.FakeWindow.instances[0]!.destroyed).toBe(true);
    video.close();
    await expect(second).resolves.toBeUndefined();
  });

  it("goes at once when main ends it while it plays, with no fade to sound under the player and no state (review pass 2, F1)", async () => {
    const video = create();
    const playing = video.play({ src: "s", state, display, language: "en" });
    const window = electron.FakeWindow.instances[0]!;
    await ready(window);
    vi.advanceTimersByTime(200);
    video.close();
    await expect(playing).resolves.toBeUndefined();
    expect([window.destroyed, window.simple]).toEqual([true, false]);
  });

  it("takes away a window still fading out when main ends it or a new one plays, without stealing the new one's focus (review 2026-10-05)", async () => {
    const video = create();
    // Left by the viewer, then hidden before the fade ends: gone at once, the screen given back.
    const firstClosed = vi.fn();
    const first = video.play({ src: "a", state, display, language: "en", closed: firstClosed });
    const outgoing = electron.FakeWindow.instances[0]!;
    await ready(outgoing);
    vi.advanceTimersByTime(200);
    await exit(outgoing, { time: 5, playing: true, volume: 1, muted: false });
    await expect(first).resolves.toEqual({ time: 5, playing: true, volume: 1, muted: false });
    vi.advanceTimersByTime(50);
    video.close();
    // Main hid it: where focus goes is main's, not this window's.
    expect([outgoing.destroyed, outgoing.simple, firstClosed.mock.calls.length]).toEqual([true, false, 0]);
    // Left again, then a new play before the fade ends: the old window goes at once and leaves the focus to the new one.
    const secondClosed = vi.fn();
    void video.play({ src: "b", state, display, language: "en", closed: secondClosed });
    const leaving = electron.FakeWindow.instances[1]!;
    await ready(leaving);
    vi.advanceTimersByTime(200);
    await exit(leaving, state);
    vi.advanceTimersByTime(50);
    void video.play({ src: "c", state, display, language: "en" });
    expect([leaving.destroyed, secondClosed.mock.calls.length]).toEqual([true, 0]);
  });

  it("closes a window whose page died, ending the request and giving focus back (review pass 1, F2)", async () => {
    const closed = vi.fn();
    const playing = create().play({ src: "s", state, display, language: "en", closed });
    const window = electron.FakeWindow.instances[0]!;
    await ready(window);
    window.contentsEvents.get("render-process-gone")!({}, { reason: "crashed" });
    await expect(playing).resolves.toBeUndefined();
    expect([window.destroyed, window.simple, closed.mock.calls.length]).toEqual([true, false, 1]);
  });

  it("is created fullscreen elsewhere, where the simple kind does not exist", async () => {
    void create("win32").play({ src: "s", state, display, language: "en" });
    const window = electron.FakeWindow.instances[0]!;
    expect(window.options).toMatchObject({ fullscreen: true });
    await ready(window);
    expect([window.shown, window.simple]).toEqual([true, false]);
  });
});
