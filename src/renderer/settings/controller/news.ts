/**
 * What a new projection says aloud through `#feedback` (core.ts `render`): only news. A pure comparison of the
 * previous and next views, kept apart from the store, focus and DOM so the rules can be read and tested on their own.
 */
import { sentences } from "../../../shared/i18n";
import type { SettingsTab, SettingsView } from "../../../shared/settings-panel";

export interface NewsContext {
  /** Only the open tab's rows speak. */
  selectedTab: SettingsTab;
  /** Groups whose shortcut editor closed with nothing changed: their note is the one they had before it opened. */
  returned: ReadonlySet<string>;
  /** Main ended the shortcut editor while the window had focus: why, said first. */
  endedNotice?: string | undefined;
}

/** The announcement for `next` after `previous`, or "" when nothing is news. */
export function settingsNews(previous: SettingsView, next: SettingsView, context: NewsContext): string {
  // Only news is read out: a language switch retranslates every note and row without changing them.
  const sameLanguage = previous.language === next.language;
  const say = (parts: string[]): string =>
    sentences(parts.filter(Boolean), next.language);
  const changes = next.groups
    .filter(
      (g) => sameLanguage && g.tab === context.selectedTab && !context.returned.has(g.id),
    )
    .flatMap((g) => {
      const old = previous.groups.find((o) => o.id === g.id);
      const messages: string[] = [];
      // A status note a diagnostic also states as its reason is read once, with the diagnostic.
      const reasons = new Set((g.diagnostics ?? []).map((d) => d.reason));
      // A finished action (the update check) is news even when its result repeats the last one.
      const finished =
        Boolean(old?.choices.some((c) => c.busy)) &&
        !g.choices.some((c) => c.busy);
      if (
        g.noteKind === "status" &&
        g.note &&
        (old?.note !== g.note || finished) &&
        !reasons.has(g.note)
      )
        messages.push(g.note);
      if (JSON.stringify(old?.diagnostics) !== JSON.stringify(g.diagnostics))
        messages.push(
          ...(g.diagnostics ?? []).map((d) =>
            say([d.heading, d.reason, d.guidance]),
          ),
        );
      return messages;
    });
  if (context.endedNotice) changes.unshift(context.endedNotice);
  // The history arriving from disk is not news: every row would be read out at once.
  const historyLoaded =
    Boolean(previous.recordingHistoryStatus) && !next.recordingHistoryStatus;
  const olds = new Map(
    (previous.recordingResults ?? []).map((r) => [r.id, r]),
  );
  const results =
    sameLanguage && !historyLoaded ? (next.recordingResults ?? []) : [];
  // Newest first, so a new failure precedes every known row; rows after one are older ones paged into view.
  const firstKnown = results.findIndex((r) => olds.has(r.id));
  for (const [index, result] of results.entries()) {
    const old = olds.get(result.id);
    if (!old) {
      if (firstKnown === -1 || index < firstKnown)
        changes.unshift(say([result.reason, result.outcome]));
    } else if (old.outcome !== result.outcome)
      changes.unshift(say([result.reason, result.outcome]));
    else if (
      result.persistenceWarning &&
      old.persistenceWarning !== result.persistenceWarning
    )
      changes.push(say([result.reason, result.persistenceWarning]));
  }
  // The status card is no live region (`#feedback` stays the one announcer), so a state it newly shows is read here:
  // a recording started from the shortcut, a save, a problem that appeared, a countdown after starting (the same tone).
  // Once per state, not every countdown second, and not again when a diagnostic already says it; Ready says nothing.
  const status = next.status,
    was = previous.status;
  if (
    sameLanguage &&
    status &&
    status.tone !== "ready" &&
    (status.tone !== was?.tone ||
      status.phase !== was?.phase ||
      (status.tone === "attention" && status.title !== was?.title)) &&
    !changes.some((change) => change.includes(status.title))
  )
    changes.unshift(say([status.title, status.detail]));
  return changes.length ? say(changes) : "";
}
