/**
 * Joins Settings' camera preview to a recording's preview frames (plan 075 step 7, D17): while the page has the
 * preview in sight and a recording composes the camera, the session's capture process gets one end of a fresh message
 * channel and the page the other, so frames go from the engine to the renderer without passing through main, and
 * the engine makes them only then. A new session, or the page watching again, gets a new channel.
 */
import { SETTINGS_CHANNELS } from "../../shared/settings-panel";

/** The page that watches: Electron's `WebContents`, narrowed for tests. */
export interface PreviewPage<Port extends PreviewPortEnd> {
  isDestroyed(): boolean;
  postMessage(channel: string, message: unknown, transfer?: Port[]): void;
}
/** One end of a `MessageChannelMain`. */
export interface PreviewPortEnd {
  close(): void;
}

export interface CameraPreviewLinkOptions<Port extends PreviewPortEnd> {
  /** The session Settings may preview: one composing the camera, prepared (Recorder.cameraSessionId). */
  session: () => string | undefined;
  /** Says whether the session's preview is watched, with the port for its frames on joining; false when not running it. */
  watch: (sessionId: string, watching: boolean, port?: Port) => boolean;
  channel: () => { port1: Port; port2: Port };
  log: (message: string) => void;
}

export class CameraPreviewLink<Port extends PreviewPortEnd> {
  private page: PreviewPage<Port> | undefined;
  /** The session the page is joined to. */
  private joined: string | undefined;

  constructor(private readonly options: CameraPreviewLinkOptions<Port>) {}

  /**
   * The page watches the preview, or `undefined`: none does (out of sight, the window closed). A page that starts
   * watching again gets a new port, as it let its last one go.
   */
  watch(page: PreviewPage<Port> | undefined): void {
    this.leave();
    this.page = page;
    this.sync();
  }

  /** Follows the recording: called whenever its state changes. */
  sync(): void {
    const page = this.page && !this.page.isDestroyed() ? this.page : undefined;
    const session = page ? this.options.session() : undefined;
    if (session === this.joined) return;
    this.leave();
    if (!page || !session) return;
    const { port1, port2 } = this.options.channel();
    if (!this.options.watch(session, true, port1)) {
      port1.close();
      port2.close();
      return;
    }
    page.postMessage(SETTINGS_CHANNELS.cameraPreviewPort, null, [port2]);
    this.joined = session;
    this.options.log(`camera preview: Settings joined to session ${session}`);
  }

  private leave(): void {
    const joined = this.joined;
    if (joined === undefined) return;
    this.joined = undefined;
    // A session that ended has nothing to stop; one still running stops making frames.
    if (this.options.watch(joined, false)) this.options.log(`camera preview: Settings left session ${joined}`);
  }
}
