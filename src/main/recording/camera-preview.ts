/**
 * Plan 075 step 2's preview page, behind the development switch `RECORDSTUFF_CAMERA_PROTOTYPE`: a plain window that
 * draws the engine's preview frames (D17's first option), so the gate can measure what a preview in Settings costs.
 * Each recording attempt's capture process gets one end of a fresh `MessageChannelMain` and the page the other, so
 * frames go from the capture process to the renderer without passing through main. Never part of a normal launch.
 */
import { BrowserWindow, MessageChannelMain, type UtilityProcess } from "electron";
import { CAMERA_PREVIEW_PORT_CHANNEL, PREVIEW_PORT_MESSAGE } from "../../shared/camera-preview";

export interface CameraPreviewOptions {
  preloadPath: string;
  htmlPath: string;
  devUrl?: string | undefined;
  log: (message: string) => void;
}

export class CameraPreview {
  private window: BrowserWindow | undefined;
  private loaded: Promise<void> | undefined;

  constructor(private readonly options: CameraPreviewOptions) {}

  /** Opens the page if it is closed, then joins it to `child`'s preview frames. */
  connect(child: UtilityProcess): void {
    const { port1, port2 } = new MessageChannelMain();
    child.postMessage({ type: PREVIEW_PORT_MESSAGE }, [port1]);
    void this.open().then((window) => {
      if (window.isDestroyed()) return;
      window.webContents.postMessage(CAMERA_PREVIEW_PORT_CHANNEL, null, [port2]);
      this.options.log("camera prototype: preview page joined to the capture process");
    }, (cause: unknown) => this.options.log(`camera prototype: preview page failed to open: ${String(cause)}`));
  }

  private async open(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed() && this.loaded) {
      await this.loaded;
      return this.window;
    }
    const window = new BrowserWindow({
      width: 680, height: 460, title: "Camera preview (plan 075 prototype)", show: true,
      webPreferences: { preload: this.options.preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    this.window = window;
    this.loaded = this.options.devUrl ? window.loadURL(this.options.devUrl) : window.loadFile(this.options.htmlPath);
    await this.loaded;
    return window;
  }
}
