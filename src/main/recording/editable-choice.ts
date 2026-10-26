/**
 * Whether the next recording is editable (plan 087, macOS only): the Editable recordings setting, or the tray's Start
 * editable recording (2026-10-25) for one recording while the setting stays off. A capture process records one kind
 * or the other from its start, so a Live preview prepared for a plain recording is let go before Start could take it.
 */
export interface EditableChoiceDeps {
  platform: string;
  /** The Editable recordings setting. */
  setting(): boolean;
  /** A Live preview runs that Start would take. */
  preview(): boolean;
  /** Lets the Live preview go. Its cancel settles idle at once, which ends a one-shot choice (`idle`). */
  stopPreview(): void;
  log(line: string): void;
}

export class EditableChoice {
  private once = false;

  constructor(private readonly deps: EditableChoiceDeps) {}

  /** Whether the next capture process records an editable file. */
  next(): boolean {
    return this.deps.platform === "darwin" && (this.deps.setting() || this.once);
  }

  /**
   * The tray's Start editable recording, just before its Start: a plain Live preview goes first, and only then is the
   * one recording made editable, since that preview's idle would otherwise end the choice before Start.
   */
  chooseOnce(): void {
    if (this.deps.platform === "darwin" && !this.next() && this.deps.preview()) {
      this.deps.log("studio: the Live preview records a plain file; letting it go for the editable recording");
      this.deps.stopPreview();
    }
    this.once = true;
    this.deps.log("tray: this recording is editable");
  }

  /** The recorder is idle: the one recording made editable has ended, or never started. */
  idle(): void {
    this.once = false;
  }
}
