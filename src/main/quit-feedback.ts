import type { MessageBoxOptions } from "electron";
import { translate, type Language } from "../shared/i18n";
import { failureReason, persistenceWarning, type RecordingResults } from "./recording-result";
import { APP_NAME } from "./ui-model";

/** What held a quit: recording work, or a settings, window-size or log write after media had settled. */
export type QuitDeferral = "media" | "metadata";

const DEFERRAL_MESSAGE = {
  media: "Recording is still starting, saving or cleaning up. RecordStuff will stay open. A recording that has not started yet will be cancelled. After it finishes, retry the same action: Quit or Relaunch.",
  metadata: "Settings or the log are still being written. RecordStuff will stay open. In a moment, retry the same action: Quit or Relaunch.",
} as const;

/**
 * Deferred-quit feedback, shown once when a quit is postponed by pending
 * recording work or, after media settled, by a settings, window-size or log
 * write (`QuitDeferral`). It only informs, so it is a notification: a windowless message box runs a
 * modal loop in which main runs no timers, I/O or log writes until it is
 * closed (plan 055's probe), which would hold the very work it describes.
 * Returns without waiting for anything, so no deadline depends on it.
 */
export function createQuitFeedback(deps: {
  language(): Language;
  notify(body: string): void;
  log(message: string): void;
}): (deferral?: QuitDeferral) => void {
  return (deferral = "media") => {
    try { deps.notify(translate(DEFERRAL_MESSAGE[deferral], deps.language())); }
    catch (cause) { deps.log(`quit feedback failed: ${String(cause)}`); }
  };
}

/** Initial bounded wait for the final history save at quit; local saves measured far below it. */
export const HISTORY_QUIT_WAIT_MS = 5000;
type HistoryQuitResults = Pick<RecordingResults, "flush" | "unsaved" | "resume" | "close" | "busy">;

/**
 * The metadata phase of quit/relaunch. Retry repeats the bounded save attempt
 * and is offered only when another attempt could succeed, Stay in app declines
 * exit, and exiting without saving is offered only when the last attempt
 * failed with no write in flight. A timed-out save is never
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
      const detail = [...unsaved.length ? [translate("Unsaved records: {count}", language, { count: unsaved.length }), ...listed, ""] : [],
        writing ? translate("The save has not finished. RecordStuff stays open instead of exiting while the history file may still be written.", language)
          : `${issue && issue !== "io" ? persistenceWarning(issue, language) : translate("Check free disk space and access to the app's data folder, then retry.", language)}\n\n${translate("If you exit without saving, these records are lost and will not appear after RecordStuff restarts. Recording files are not affected.", language)}`];
      // An unreadable, newer or oversized history fails the same way on every attempt while the prompt holds the app.
      const retryable = writing || !issue || issue === "io";
      const choices = [...(retryable ? ["retry" as const] : []), "stay" as const, ...(writing ? [] : ["exit" as const])];
      const labels = { retry: writing ? "Keep waiting" : "Retry", stay: "Stay in app", exit: "Exit without saving these records" } as const;
      let response = choices.indexOf("stay");
      try { deps.focus(); }
      catch (cause) { deps.log(`quit: prompt focus failed: ${String(cause)}`); }
      try {
        ({ response } = await deps.show({
          type: "warning", title: APP_NAME,
          message: translate(writing ? "Still saving failure records" : "Could not save failure records", language),
          detail: detail.join("\n"),
          buttons: choices.map(choice => translate(labels[choice], language)),
          defaultId: 0, cancelId: choices.indexOf("stay"), noLink: true,
        }));
      } catch (cause) { deps.log(`quit: unsaved history prompt failed: ${String(cause)}`); }
      const chosen = choices[response] ?? "stay";
      if (chosen === "retry") continue;
      if (chosen === "exit") {
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
