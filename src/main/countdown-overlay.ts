/**
 * The countdown digit (plan 040, docs/system-design/desktop.md#countdown-overlay):
 * a transparent, click-through, non-activating window at the top-right of
 * the recorded display that draws only the digit. It is created during
 * preparation and destroyed when the countdown ends, is cancelled or fails,
 * so none remains between recordings. It never activates RecordStuff or takes
 * keyboard focus from the frontmost app, and no content protection is
 * applied: the overlay is gone before capture begins.
 *
 * Main owns every value and every timing decision; the page only renders
 * what it is sent and cannot reply.
 */
import { BrowserWindow, type BrowserWindowConstructorOptions } from "electron";
import { COUNTDOWN_TIMING, COUNTDOWN_VALUE_CHANNEL, overlayBounds, type CountdownValue, type Rectangle } from "../shared/countdown";
import type { CountdownPresenter } from "./recorder";

export interface OverlayDisplay {
  id: string;
  /** The whole display, in points; logged so acceptance can find the digit in the recorded frames. */
  bounds: Rectangle;
  workArea: Rectangle;
}

export interface CountdownOverlayOptions {
  preloadPath: string;
  htmlPath: string;
  /** The dev server's page URL; when absent, `htmlPath` is loaded. */
  devUrl?: string | undefined;
  /** The display DisplayMedia resolved for this session, when known. */
  display: () => OverlayDisplay | undefined;
  primaryDisplay: () => OverlayDisplay;
  platform: NodeJS.Platform;
  log: (message: string) => void;
}

/** Fixed, shadowless, frameless and unfocusable; macOS gets a non-activating panel. */
export function overlayWindowOptions(bounds: Rectangle, preloadPath: string, platform: NodeJS.Platform): BrowserWindowConstructorOptions {
  return {
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    roundedCorners: false,
    // NSWindowStyleMaskNonactivatingPanel: floats over full-screen apps without activating the app.
    ...(platform === "darwin" ? { type: "panel" } : {}),
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  };
}

export class CountdownOverlay implements CountdownPresenter {
  private window: BrowserWindow | undefined;
  private loaded = false;
  /** The latest value, sent once the page has loaded. */
  private value: CountdownValue | undefined;
  private visible = false;
  private fading: { timer: ReturnType<typeof setTimeout>; done: () => void } | undefined;

  constructor(private readonly options: CountdownOverlayOptions) {}

  prepare(): void {
    if (this.window && !this.window.isDestroyed()) return;
    const { workArea } = this.options.primaryDisplay();
    const window = new BrowserWindow(overlayWindowOptions(overlayBounds(workArea), this.options.preloadPath, this.options.platform));
    this.window = window;
    this.loaded = false;
    this.value = undefined;
    this.visible = false;
    window.setAlwaysOnTop(true, "screen-saver");
    // The process is already an accessory app (no Dock icon); transforming it would flash windows.
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    window.setIgnoreMouseEvents(true);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("render-process-gone", (_event, details) => {
      this.options.log(`countdown overlay: render process gone (${details.reason}); the tray still shows the countdown`);
      if (this.window === window) this.close();
    });
    window.webContents.once("did-finish-load", () => {
      if (this.window !== window || window.isDestroyed()) return;
      this.loaded = true;
      if (this.value !== undefined) this.send(this.value);
      if (this.visible) window.showInactive();
    });
    window.on("closed", () => {
      if (this.window === window) this.forget();
    });
    const load = this.options.devUrl ? window.loadURL(this.options.devUrl) : window.loadFile(this.options.htmlPath);
    void load.catch((cause: unknown) => {
      this.options.log(`countdown overlay: page failed to load: ${String(cause)}`);
      if (this.window === window) this.close();
    });
  }

  show(remaining: number): void {
    this.prepare();
    const window = this.window;
    if (!window) return;
    const resolved = this.options.display();
    const display = resolved ?? this.options.primaryDisplay();
    if (!resolved) this.options.log(`countdown overlay: the recorded display is unknown; using the primary display ${display.id}`);
    const bounds = overlayBounds(display.workArea);
    window.setBounds(bounds);
    const whole = display.bounds;
    this.options.log(`countdown overlay: display ${display.id} at ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height} in display bounds ${whole.x},${whole.y} ${whole.width}x${whole.height}`);
    this.visible = true;
    this.send(remaining);
    if (this.loaded) window.showInactive();
  }

  update(remaining: number): void {
    this.send(remaining);
  }

  /** Fades out, then destroys the window once the last faded frame has reached the screen. */
  dismiss(): Promise<void> {
    const window = this.window;
    if (!window || window.isDestroyed()) return Promise.resolve();
    if (!this.loaded || !this.visible) {
      this.close();
      return Promise.resolve();
    }
    this.send(null);
    return new Promise((resolve) => {
      this.endFade();
      const timer = setTimeout(() => {
        if (this.window === window) this.close();
        else this.endFade();
      }, COUNTDOWN_TIMING.fadeOutMs + COUNTDOWN_TIMING.settleMs);
      this.fading = { timer, done: resolve };
    });
  }

  /** Destroys the window at once; a pending dismissal resolves, since the digit is gone either way. */
  close(): void {
    this.endFade();
    const window = this.window;
    this.forget();
    if (window && !window.isDestroyed()) window.destroy();
  }

  /** Safety net: the app destroys the overlay again on every settled state and at quit. */
  destroy(): void {
    this.close();
  }

  private endFade(): void {
    const fading = this.fading;
    this.fading = undefined;
    if (!fading) return;
    clearTimeout(fading.timer);
    fading.done();
  }

  private forget(): void {
    this.window = undefined;
    this.loaded = false;
    this.value = undefined;
    this.visible = false;
  }

  private send(value: CountdownValue): void {
    this.value = value;
    const window = this.window;
    if (!window || window.isDestroyed() || !this.loaded) return;
    window.webContents.send(COUNTDOWN_VALUE_CHANNEL, value);
  }
}
