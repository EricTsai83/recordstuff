/**
 * Joins the Recording Studio's page to the recording it shows (plan 075 step 7 and D19, plan 081): while the page has
 * the preview or the meters in sight and a session runs, the session's capture process gets one end of a fresh message
 * channel and the page the other, so the preview's frames and the levels go from the engine to the renderer without
 * passing through main (studio-port.ts), and the engine makes each only while it is watched. A new session, or a
 * page that let both go and watches again, gets a new channel.
 */
import { SETTINGS_CHANNELS } from "../../shared/settings-panel";

/** The page that watches: Electron's `WebContents`, narrowed for tests. */
export interface StudioPage<Port extends StudioPortEnd> {
  isDestroyed(): boolean;
  postMessage(channel: string, message: unknown, transfer?: Port[]): void;
}
/** One end of a `MessageChannelMain`. */
export interface StudioPortEnd {
  close(): void;
}

/** What the page shows of the recording, each asked for on its own. */
export type StudioFeed = "preview" | "levels";

export interface StudioLinkOptions<Port extends StudioPortEnd> {
  /** The session the Studio may show: a Live preview or a recording, prepared (Recorder.previewSessionId). */
  session: () => string | undefined;
  /** Hands the session's capture process its end of the channel; false when the host does not run the session. */
  join: (sessionId: string, port: Port) => boolean;
  /** Says whether the session's feed is watched; false when the host does not run the session. */
  watch: (sessionId: string, feed: StudioFeed, watching: boolean) => boolean;
  channel: () => { port1: Port; port2: Port };
  log: (message: string) => void;
}

const FEEDS: readonly StudioFeed[] = ["preview", "levels"];

export class StudioLink<Port extends StudioPortEnd> {
  /** The page watching each feed, if any: Settings' one window. */
  private readonly pages: Record<StudioFeed, StudioPage<Port> | undefined> = { preview: undefined, levels: undefined };
  /** The session and page joined, and the feeds told watched. */
  private joined: { session: string; page: StudioPage<Port>; feeds: Record<StudioFeed, boolean> } | undefined;

  constructor(private readonly options: StudioLinkOptions<Port>) {}

  /**
   * The page watches `feed`, or `undefined`: no page does (out of sight, the window closed). A page that let both feeds
   * go closed its port, so it gets a new one when it watches again.
   */
  watch(feed: StudioFeed, page: StudioPage<Port> | undefined): void {
    this.pages[feed] = page;
    this.sync();
  }

  /** Follows the recording: called whenever its state changes. */
  sync(): void {
    const alive = (page: StudioPage<Port> | undefined): StudioPage<Port> | undefined => page && !page.isDestroyed() ? page : undefined;
    const page = alive(this.pages.preview) ?? alive(this.pages.levels);
    const session = page ? this.options.session() : undefined;
    if (!page || !session || this.joined?.session !== session || this.joined.page !== page) {
      this.leave();
      if (!page || !session) return;
      const { port1, port2 } = this.options.channel();
      if (!this.options.join(session, port1)) {
        port1.close();
        port2.close();
        return;
      }
      page.postMessage(SETTINGS_CHANNELS.cameraPreviewPort, null, [port2]);
      this.joined = { session, page, feeds: { preview: false, levels: false } };
      this.options.log(`studio: Settings joined to session ${session}`);
    }
    const joined = this.joined;
    if (!joined) return;
    for (const feed of FEEDS) {
      const wanted = alive(this.pages[feed]) === page;
      if (wanted === joined.feeds[feed]) continue;
      joined.feeds[feed] = wanted;
      this.options.watch(session, feed, wanted);
    }
  }

  private leave(): void {
    const joined = this.joined;
    if (joined === undefined) return;
    this.joined = undefined;
    // A session that ended has nothing to stop; one still running stops making what was watched.
    let running = false;
    for (const feed of FEEDS) if (joined.feeds[feed]) running = this.options.watch(joined.session, feed, false) || running;
    if (running) this.options.log(`studio: Settings left session ${joined.session}`);
  }
}
