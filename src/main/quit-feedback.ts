import type { MessageBoxOptions } from "electron";
import { translate, type Language } from "../shared/i18n";
import { failureReason, persistenceWarning, type RecordingResults } from "./recording-result";
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

/** Initial bounded wait for the final history save at quit; local saves measured far below it. */
export const HISTORY_QUIT_WAIT_MS = 5000;
type HistoryQuitResults = Pick<RecordingResults, "flush" | "unsaved" | "resume" | "close" | "busy">;

/**
 * The metadata phase of quit/relaunch. Retry repeats the bounded save attempt,
 * Stay in app declines exit, and exiting without saving is offered only when
 * the last attempt failed with no write in flight. A timed-out save is never
 * treated as stopped I/O, so it keeps the app open.
 */
export function createHistoryQuit(deps: {
  results: HistoryQuitResults;
  language(): Language;
  focus(): void;
  show(options: MessageBoxOptions): Promise<{ response: number }>;
  log(message: string): void;
  waitMs?: number;
}): () => Promise<boolean> {
  return async () => {
    for (;;) {
      const outcome = await deps.results.flush(deps.waitMs ?? HISTORY_QUIT_WAIT_MS);
      if (outcome === "safe") { deps.results.close(); return true; }
      const language = deps.language();
      const unsaved = deps.results.unsaved();
      const listed = unsaved.slice(0, 5).map(result =>
        `• ${new Date(result.occurredAt).toLocaleString(language)} — ${failureReason(result.code, language)}`);
      if (unsaved.length > listed.length) listed.push(translate("…and {count} more", language, { count: unsaved.length - listed.length }));
      const writing = outcome === "writing";
      const issue = unsaved.find(result => result.persistenceFailed)?.persistenceFailed;
      // A pending acknowledgement alone leaves no reminder unsaved, only an unfinished write.
      const detail = [...unsaved.length ? [translate("Unsaved reminders: {count}", language, { count: unsaved.length }), ...listed, ""] : [],
        writing ? translate("The save has not finished. RecordStuff stays open instead of exiting while the history file may still be written.", language)
          : `${issue && issue !== "io" ? persistenceWarning(issue, language) : translate("Check free disk space and access to the app's data folder, then retry.", language)}\n\n${translate("If you exit without saving, these reminders are lost and will not appear after RecordStuff restarts. Recording files are not affected.", language)}`];
      let response = 1;
      try {
        deps.focus();
        ({ response } = await deps.show({
          type: "warning", title: APP_NAME,
          message: translate(writing ? "Still saving failure reminders" : "Could not save failure reminders", language),
          detail: detail.join("\n"),
          buttons: [translate(writing ? "Keep waiting" : "Retry", language), translate("Stay in app", language),
            ...(writing ? [] : [translate("Exit without saving these reminders", language)])],
          defaultId: 0, cancelId: 1, noLink: true,
        }));
      } catch (cause) { deps.log(`quit: unsaved history prompt failed: ${String(cause)}`); }
      if (response === 0) continue;
      if (response === 2 && !writing) {
        // A write started while the prompt was open (for example Got it) could still publish.
        if (deps.results.busy) continue;
        deps.log(`quit: exiting without saving ${unsaved.length} failure reminder(s) at the user's request`);
        deps.results.close();
        return true;
      }
      deps.results.resume();
      return false;
    }
  };
}
