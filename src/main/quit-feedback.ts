import type { MessageBoxOptions } from "electron";
import { translate, type Language } from "../shared/i18n";
import { APP_NAME } from "./ui-model";

/** Shared native presentation; fixtures inject real Electron functions, not copied UI. */
export function createQuitFeedback(deps: {
  language(): Language;
  focus(): void;
  show(options: MessageBoxOptions): Promise<unknown>;
  log(message: string): void;
}): () => Promise<void> {
  let active: Promise<void> | undefined;
  return () => {
    if (active) {
      try { deps.focus(); }
      catch (cause) { deps.log(`quit feedback failed: ${String(cause)}`); }
      return active;
    }
    // Register before invoking native code, including synchronous/reentrant callbacks.
    active = Promise.resolve().then(async () => {
      deps.focus();
      await deps.show({
        type: "info",
        title: APP_NAME,
        message: translate("Recording is still starting, saving or cleaning up. RecordStuff will stay open. Any pending capture will stop when it starts. Please try quitting again after it finishes.", deps.language()),
      });
    }).catch(cause => deps.log(`quit feedback failed: ${String(cause)}`)).finally(() => {
      active = undefined;
    });
    return active;
  };
}
