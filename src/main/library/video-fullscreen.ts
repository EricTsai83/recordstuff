/**
 * A recording played full screen in a window of its own (src/shared/video-player.ts). RecordStuff's window never
 * changes size: the page's own fullscreen grew it to the screen first, white where the picture had not yet
 * followed, and shrank it back the same way (2026-10-05, the maintainer's review of the built app). This window
 * covers the screen of the window it plays for, black, starts hidden and fades in once its page has drawn the
 * first frame at the player's time; leaving, it hands that time back at once, so the player seeks while this
 * window fades out above it.
 *
 * On macOS the window takes the simple fullscreen while still hidden and already the screen's size, so nothing
 * grows and no Space opens; the menu bar and the Dock step aside while it shows. Elsewhere it is created
 * fullscreen. Only one plays at a time; a new request ends the one before.
 *
 * While the player's window is open, a page waits loaded and hidden on macOS (`prepare`), and a request hands it the
 * recording instead of creating a window and loading a page: 140 ms of the 200 between the click and the first frame
 * on 2026-10-10. Without one ready, a request creates its window as before.
 */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type Rectangle } from "electron";
import { VIDEO_CHANNELS, VIDEO_QUERY, VIDEO_TIMING, playbackState, type PlaybackState, type VideoLoad } from "../../shared/video-player";
import type { Language } from "../../shared/i18n";

export interface VideoFullScreenOptions {
  preloadPath: string;
  htmlPath: string;
  /** The dev server's page URL; when absent, `htmlPath` is loaded. */
  devUrl?: string | undefined;
  platform: NodeJS.Platform;
  log: (message: string) => void;
}

export interface VideoFullScreenRequest {
  /** A `recordstuff-media:` URL main resolved from a listed recording, never one the page supplied. */
  src: string;
  state: PlaybackState;
  /** The whole display to cover. */
  display: Rectangle;
  language: Language;
  /** The recording's name over the picture, as the listing shows it; main's own words, never the page's. */
  title?: string;
  /** The window has gone: give focus back to the one it played for. */
  closed?: () => void;
}

interface Playing {
  window: BrowserWindow;
  resolve: (state: PlaybackState | undefined) => void;
  shown: boolean;
  fade?: ReturnType<typeof setInterval>;
  /** Gives the window it played for its focus back once closed: not when main ended it, to hide it or for a newer one. */
  returnFocus: boolean;
  /**
   * Where the wait between the request and the picture went, in ms since `play` began; logged once faded in. A warm
   * page was created and loaded before the request, so it has neither step.
   */
  timing: { began: number; warm: boolean; created?: number; loaded?: number; ready?: number; shown?: number; steps: number; longestStep: number };
}

/** A page loaded and hidden for the next request: creating a window and loading its page took 140 ms of the 200. */
interface Standby {
  window: BrowserWindow;
  loaded: boolean;
}

export class VideoFullScreen {
  private playing: Playing | undefined;
  /** One the viewer left, still fading out: main's own end or a new play takes it away at once (review 2026-10-05). */
  private leaving: Playing | undefined;
  /** While the player's window is open (`prepare` until `close`), a page waits hidden for the next request. */
  private warm = false;
  private standby: Standby | undefined;
  private standbyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: VideoFullScreenOptions) {
    const sender = (event: IpcMainInvokeEvent): Playing | undefined => {
      const playing = this.playing;
      return playing && !playing.window.isDestroyed() && event.sender === playing.window.webContents ? playing : undefined;
    };
    ipcMain.handle(VIDEO_CHANNELS.ready, event => {
      const playing = sender(event);
      if (!playing) return;
      playing.timing.ready ??= performance.now() - playing.timing.began;
      this.show(playing);
    });
    ipcMain.handle(VIDEO_CHANNELS.exit, (event, state: unknown) => {
      const playing = sender(event);
      if (playing) this.end(playing, playbackState(state));
    });
  }

  /**
   * The player's window is open, so a request may come: a page is loaded hidden a moment later (not to slow the
   * window's own opening) and kept until `close`, then again after each play. macOS only: elsewhere the window is
   * created full screen on its display, which a page loaded beforehand could not follow.
   */
  prepare(): void {
    if (this.options.platform !== "darwin") return;
    this.warm = true;
    if (this.standby || this.standbyTimer || this.playing) return;
    this.standbyTimer = setTimeout(() => {
      this.standbyTimer = undefined;
      if (!this.warm || this.standby || this.playing) return;
      const window = this.createWindow();
      const standby: Standby = { window, loaded: false };
      this.standby = standby;
      window.webContents.on("did-finish-load", () => { standby.loaded = true; });
      window.on("closed", () => { if (this.standby === standby) this.standby = undefined; });
      this.load(window, { [VIDEO_QUERY.standby]: "1" });
    }, VIDEO_TIMING.standbyDelayMs);
  }

  /** Plays until the viewer leaves; resolves with where the video was then, or undefined if it closed some other way. */
  play(request: VideoFullScreenRequest): Promise<PlaybackState | undefined> {
    this.disposeAll();
    const began = performance.now();
    const { display, state } = request;
    const mac = this.options.platform === "darwin";
    // A page still loading is no quicker than a new one, and is let go.
    const standby = this.standby?.loaded && !this.standby.window.isDestroyed() ? this.standby : undefined;
    if (standby) this.standby = undefined;
    this.disposeStandby();
    const window = standby?.window ?? this.createWindow(display);
    if (standby) window.setBounds(display);
    return new Promise(resolve => {
      const playing: Playing = { window, resolve, shown: false, returnFocus: true,
        timing: { began, warm: Boolean(standby), steps: 0, longestStep: 0, ...(standby ? {} : { created: performance.now() - began }) } };
      this.playing = playing;
      if (!standby) window.webContents.on("did-finish-load", () => { playing.timing.loaded ??= performance.now() - began; });
      const timeout = setTimeout(() => this.show(playing), VIDEO_TIMING.readyTimeoutMs);
      window.on("closed", () => {
        clearTimeout(timeout);
        clearInterval(playing.fade);
        if (this.playing === playing) this.playing = undefined;
        if (this.leaving === playing) this.leaving = undefined;
        playing.resolve(undefined);
        if (playing.returnFocus) request.closed?.();
        // The next request finds a page waiting again, while the player's window is open.
        if (this.warm) this.prepare();
      });
      // Closed while it covers the screen (by quitting): the menu bar and the Dock come back first.
      window.on("close", () => { if (mac && window.isSimpleFullScreen()) window.setSimpleFullScreen(false); });
      const load: VideoLoad = { src: request.src, state, language: request.language, ...(request.title ? { title: request.title } : {}) };
      if (standby) window.webContents.send(VIDEO_CHANNELS.load, load);
      else this.load(window, {
        [VIDEO_QUERY.src]: load.src,
        [VIDEO_QUERY.time]: String(state.time),
        [VIDEO_QUERY.playing]: state.playing ? "1" : "0",
        [VIDEO_QUERY.volume]: String(state.volume),
        [VIDEO_QUERY.muted]: state.muted ? "1" : "0",
        [VIDEO_QUERY.language]: load.language,
        ...(load.title ? { [VIDEO_QUERY.title]: load.title } : {}),
      });
    });
  }

  /** Hidden, black and at opacity 0: `show` covers the screen with it once its page has drawn the first frame. */
  private createWindow(display?: Rectangle): BrowserWindow {
    const mac = this.options.platform === "darwin";
    const window = new BrowserWindow({
      ...display,
      show: false,
      frame: false,
      backgroundColor: "#000000",
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      title: "RecordStuff",
      ...(mac ? { fullscreenable: false, enableLargerThanScreen: true } : { fullscreen: true }),
      webPreferences: { preload: this.options.preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    });
    window.setOpacity(0);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", event => event.preventDefault());
    // A page that died can neither show nor leave: the window goes, and `closed` ends the request (review pass 1, F2).
    window.webContents.on("render-process-gone", (_event, details) => {
      this.options.log(`video fullscreen: renderer gone (${details.reason}); closing the window`);
      if (window.isDestroyed()) return;
      // `destroy` skips `close`, where the menu bar and the Dock are given back.
      if (mac && window.isSimpleFullScreen()) window.setSimpleFullScreen(false);
      window.destroy();
    });
    return window;
  }

  private load(window: BrowserWindow, query: Record<string, string>): void {
    const loading = this.options.devUrl
      ? window.loadURL(`${this.options.devUrl}?${new URLSearchParams(query).toString()}`)
      : window.loadFile(this.options.htmlPath, { query });
    void loading.catch((cause: unknown) => {
      this.options.log(`video fullscreen: load failed: ${String(cause)}`);
      if (!window.isDestroyed()) window.destroy();
    });
  }

  /** The waiting page and its timer, gone. */
  private disposeStandby(): void {
    clearTimeout(this.standbyTimer);
    this.standbyTimer = undefined;
    const standby = this.standby;
    this.standby = undefined;
    if (standby && !standby.window.isDestroyed()) standby.window.destroy();
  }

  /** The window it plays in, if any, and the page waiting: the settings window ends both when it closes or hides itself. */
  close(): void {
    this.warm = false;
    this.disposeAll();
    this.disposeStandby();
  }

  /** The one playing and the one fading out, both gone at once. */
  private disposeAll(): void {
    if (this.leaving) this.dispose(this.leaving);
    if (this.playing) this.dispose(this.playing);
  }

  /**
   * Ended by main, not by the viewer: gone at once, without a fade in which its video would still sound under a
   * player going on, and with no state handed back (review pass 2, F1).
   */
  private dispose(playing: Playing): void {
    if (this.playing === playing) this.playing = undefined;
    else if (this.leaving === playing) this.leaving = undefined;
    else return;
    // Settled already when the viewer left; otherwise nothing is handed back. Main decides where focus goes.
    playing.resolve(undefined);
    playing.returnFocus = false;
    clearInterval(playing.fade);
    const { window } = playing;
    if (window.isDestroyed()) return;
    // `destroy` skips `close`, where the menu bar and the Dock are given back.
    if (this.options.platform === "darwin" && window.isSimpleFullScreen()) window.setSimpleFullScreen(false);
    window.destroy();
  }

  /** Covers the screen, then fades in. */
  private show(playing: Playing): void {
    const { window } = playing;
    if (playing.shown || window.isDestroyed() || this.playing !== playing) return;
    playing.shown = true;
    if (this.options.platform === "darwin") window.setSimpleFullScreen(true);
    window.show();
    window.focus();
    playing.timing.shown = performance.now() - playing.timing.began;
    this.fade(playing, 1, () => this.logTiming(playing));
  }

  /** Diagnostics only: which step a slow or uneven entry spent its time in. */
  private logTiming(playing: Playing): void {
    const { timing } = playing;
    const ms = (value: number | undefined): string => value === undefined ? "?" : String(Math.round(value));
    this.options.log(`video fullscreen timing: ${timing.warm ? "warm page" : `new window ${ms(timing.created)} ms, page ${ms(timing.loaded)} ms`}, ` +
      `first frame ${timing.ready === undefined ? "never (shown on timeout)" : `${ms(timing.ready)} ms`}, shown ${ms(timing.shown)} ms, ` +
      `faded in ${ms(performance.now() - timing.began)} ms in ${timing.steps} steps, longest step ${ms(timing.longestStep)} ms`);
  }

  /** Hands the state back at once, fades out, and closes. */
  private end(playing: Playing, state: PlaybackState | undefined): void {
    if (this.playing !== playing) return;
    this.playing = undefined;
    this.leaving = playing;
    playing.resolve(state);
    const { window } = playing;
    if (window.isDestroyed()) return;
    this.fade(playing, 0, () => { if (!window.isDestroyed()) window.close(); });
  }

  private fade(playing: Playing, to: 0 | 1, done?: () => void): void {
    clearInterval(playing.fade);
    const { window } = playing;
    const from = window.getOpacity();
    const startedAt = Date.now();
    let last = performance.now();
    playing.fade = setInterval(() => {
      if (window.isDestroyed()) { clearInterval(playing.fade); return; }
      const now = performance.now();
      playing.timing.steps++;
      playing.timing.longestStep = Math.max(playing.timing.longestStep, now - last);
      last = now;
      const progress = Math.min(1, (Date.now() - startedAt) / VIDEO_TIMING.fadeMs);
      window.setOpacity(from + (to - from) * progress);
      if (progress < 1) return;
      clearInterval(playing.fade);
      done?.();
    }, 16);
  }
}
