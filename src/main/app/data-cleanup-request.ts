import { translate, type Language } from "../../shared/i18n";
import type { MessageBoxOptions } from "electron";

/** User consent and a fresh capture-state check precede every cleanup request. */
export class DataCleanupRequest {
  confirming = false;
  requested = false;
  constructor(private readonly deps: {
    settled(): boolean;
    language(): Language;
    confirm(options: MessageBoxOptions): Promise<{ response: number }>;
    quit(): void;
  }) {}
  cancel(): void { this.requested = false; }
  async request(): Promise<boolean> {
    if (this.confirming || this.requested || !this.deps.settled()) return false;
    this.confirming = true;
    try {
      const language = this.deps.language();
      const answer = await this.deps.confirm({
        type: "warning", title: translate("Clear local app data?", language),
        message: translate("Clear local app data?", language),
        detail: translate("RecordStuff will quit, then permanently clear settings, failure history, cache, logs and old data backups. Recordings and your output folder are kept. This does not uninstall the app or reset system permissions.", language),
        buttons: [translate("Cancel", language), translate("Clear data and quit", language)],
        defaultId: 0, cancelId: 0, noLink: true,
      });
      if (answer.response !== 1) return true; // Cancellation is a successful no-op.
      if (!this.deps.settled()) return false; // A tray/shortcut start may race the prompt.
      this.requested = true;
      this.confirming = false; // Quit's shutdown must see an answered prompt.
      this.deps.quit();
      return true;
    } finally { this.confirming = false; }
  }
}
