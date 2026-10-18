/**
 * The Recording Studio's level meters (plan 075, D19): while the page has them in sight and a recording is in
 * progress, the session's capture process tells its inputs' levels, which main passes to the page as they come; the
 * engine gathers them only then. A new session, or the page watching again, is asked again.
 */
import type { HostMessage } from "../../shared/protocol";
import { SETTINGS_CHANNELS, type StudioLevels } from "../../shared/settings-panel";

/** The page that watches: Electron's `WebContents`, narrowed for tests. */
export interface LevelsPage {
  isDestroyed(): boolean;
  send(channel: string, levels: StudioLevels): void;
}

export interface LevelsLinkOptions {
  /** The recording whose levels the page may show (Recorder.audio). */
  session: () => string | undefined;
  /** Says whether the session's levels are watched; false when the host does not run it. */
  watch: (sessionId: string, watching: boolean) => boolean;
}

export class LevelsLink {
  private page: LevelsPage | undefined;
  private joined: string | undefined;

  constructor(private readonly options: LevelsLinkOptions) {}

  /** The page watches the meters, or `undefined`: none does. */
  watch(page: LevelsPage | undefined): void {
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
    if (session && this.options.watch(session, true)) this.joined = session;
  }

  /** A host message: the joined session's levels go to the page. */
  deliver(message: HostMessage): void {
    if (message.type !== "levels" || message.sessionId !== this.joined || !this.page || this.page.isDestroyed()) return;
    this.page.send(SETTINGS_CHANNELS.levels, { system: message.system, ...(message.microphone === undefined ? {} : { microphone: message.microphone }) });
  }

  private leave(): void {
    const joined = this.joined;
    if (joined === undefined) return;
    this.joined = undefined;
    this.options.watch(joined, false);
  }
}
