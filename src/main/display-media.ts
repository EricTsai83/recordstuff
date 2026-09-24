/**
 * Main's side of display-media requests across recording attempts
 * (docs/system-design/recording.md): the screen the current attempt asked
 * for, why main refused it, the display a running capture uses, and the
 * display diagnostic the UI shows. index.ts wires it to Electron; the state
 * lives here so each rule is testable without Electron.
 */
import type { DisplayFailure, DisplayInfo, DisplayPreference } from "../shared/display";
import type { ErrorCode } from "../shared/state";
import { DisplayRequest } from "./display-source";

type Source = { display_id: string };

export interface DisplayMediaOptions<S extends Source> {
  platform: NodeJS.Platform;
  /** The saved choice; each attempt keeps the value it began with. */
  preference: () => DisplayPreference;
  displays: () => DisplayInfo[];
  primaryDisplayId: () => string;
  getSources: () => Promise<S[]>;
  /** A refusal changed what the UI shows. */
  changed: () => void;
  log: (message: string) => void;
}

export class DisplayMedia<S extends Source> {
  /** The display diagnostic the UI shows; cleared when a capture starts or the choice changes. */
  failure: DisplayFailure | undefined;
  private request: DisplayRequest<S> | undefined;
  private sessionId: string | undefined;
  /** The display the running capture was granted; its removal fails the recording. */
  private activeDisplayId: string | undefined;
  /** Why main refused the last request; the renderer only sees a generic error. */
  private denial: ErrorCode | undefined;
  private topologyGeneration = 0;

  constructor(private readonly options: DisplayMediaOptions<S>) {}

  /** A recorder attempt began; requests from earlier attempts can no longer grant capture. */
  begin(sessionId: string): void {
    this.request?.cancel();
    this.sessionId = sessionId;
    this.denial = undefined;
    this.activeDisplayId = undefined;
    const { platform, getSources, log } = this.options;
    const preference = { ...this.options.preference() };
    this.request = new DisplayRequest({
      preference, platform, getSources,
      snapshot: () => ({
        displays: this.options.displays(),
        primaryDisplayId: this.options.primaryDisplayId(),
        generation: this.topologyGeneration,
      }),
      selected: (source, rule, attempt, resolution) => {
        this.denial = undefined;
        this.activeDisplayId = source.display_id || undefined;
        log(`display media: requested ${JSON.stringify(preference)}; resolved ${source.display_id}; label ${resolution.ok ? resolution.label : ""}; rule ${rule}; retry ${attempt - 1}`);
      },
      denied: (code, detail, attempt) => {
        this.denial = code;
        if (code === "display_unavailable") this.failure = detail;
        log(`display media: denied (${code}); requested ${JSON.stringify(preference)}; resolved none; rule ${preference.kind}; retry ${attempt - 1}; detail ${detail}`);
        this.options.changed();
      },
    });
  }

  /**
   * Answer one OS display-media request. `owns` confirms that the requesting
   * frame belongs to this attempt; any other request gets no source.
   */
  answer(owns: (sessionId: string) => boolean, callback: (source?: S) => void): void {
    const { request, sessionId } = this;
    if (!request || !sessionId || !owns(sessionId)) {
      callback();
      return;
    }
    void request.run(callback);
  }

  /** The real cause of a host error that main's refusal explains; each refusal explains one error. */
  explain(code: ErrorCode): ErrorCode {
    const denial = this.denial;
    this.denial = undefined;
    const explainable = code === "capture_start_failed" || code === "permission_denied" || code === "no_display";
    return denial && explainable ? denial : code;
  }

  /** The attempt settled: cancel its pending request and stop watching its display. */
  settle(): void {
    this.request?.cancel();
    this.request = undefined;
    this.sessionId = undefined;
    this.activeDisplayId = undefined;
  }

  /** Displays changed. True when the display being recorded is no longer connected. */
  topologyChanged(connectedIds: readonly string[]): boolean {
    this.topologyGeneration++;
    const active = this.activeDisplayId;
    if (!active || connectedIds.includes(active)) return false;
    this.options.log(`display media: active display ${active} removed; detail target_removed`);
    return true;
  }
}
