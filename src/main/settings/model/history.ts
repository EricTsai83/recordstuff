/**
 * Dates as rows show them, and the Failures tab: each failure's view and the actions it offers.
 */
import { failureReason, failureGuidance, failureOutcome, isOutputFolderFailure, isPermissionFailure, persistenceWarning } from "../../recording/recording-result";
import { translate as t, type Language, type PlainMessageKey } from "../../../shared/i18n";
import type { RecordingResultView, SettingsChoice, SettingsView } from "../../../shared/settings-panel";
import type { RecordingResult, RecordingResultAction } from "../../../shared/recording-result";
import type { RecordingState } from "../../../shared/state";
import path from "node:path";
import type { AppAction, AppContext } from "../../app/ui-model";
import { preferencesUnlocked } from "../../recording/recording-lock";

/** A calendar day in local time, for grouping and naming failure rows and recordings. */
function localDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const DATE_FORMATS = {
  day: { month: "long", day: "numeric" },
  dayOfYear: { year: "numeric", month: "long", day: "numeric" },
  time: { hour: "numeric", minute: "2-digit" },
} satisfies Record<string, Intl.DateTimeFormatOptions>;
/** Formats a date in one of the shapes above; `zone` is the system time zone the view was made in. */
export type DateFormats = ((date: Date, format: keyof typeof DATE_FORMATS) => string) & { readonly zone: string };
/**
 * One view's date formatters, each made on first use. Every view names each failure row and recording
 * again, and `toLocale…String` builds a new ICU formatter per call (tens of microseconds each), so a folder
 * of hundreds of recordings made every refresh slow. Made per view, never kept across views: a formatter
 * keeps the time zone it was made in, and the system zone can change while the app runs (review batch 1).
 */
export function dateFormats(language: Language): DateFormats {
  const made = new Map<keyof typeof DATE_FORMATS, Intl.DateTimeFormat>();
  const format = (date: Date, shape: keyof typeof DATE_FORMATS): string => {
    let formatter = made.get(shape);
    if (!formatter) made.set(shape, formatter = new Intl.DateTimeFormat(language, DATE_FORMATS[shape]));
    return formatter.format(date);
  };
  return Object.assign(format, { zone: new Intl.DateTimeFormat().resolvedOptions().timeZone });
}

/**
 * The day heading failure rows (plan 047) and recordings are grouped under: Today, Yesterday,
 * then the date, with the year only when it is not the current year.
 */
export function dayHeading(occurredAt: Date, now: Date, language: Language, format = dateFormats(language)): string {
  const days = Math.round((localDay(now) - localDay(occurredAt)) / 86_400_000);
  if (days === 0) return t("Today", language);
  if (days === 1) return t("Yesterday", language);
  return format(occurredAt, occurredAt.getFullYear() === now.getFullYear() ? "day" : "dayOfYear");
}

/** The short local time a failure row shows beside its reason, and the title of a recording the app named. */
export function shortTime(occurredAt: Date, language: Language, format = dateFormats(language)): string {
  return format(occurredAt, "time");
}

/**
 * The last tab: Troubleshooting retains the failure entry id and unread count (plan 047),
 * while its accessible name explains what that count means.
 */
export function failuresTab(ctx: AppContext): SettingsView["tabs"][number] {
  const language = ctx.language;
  const unread = (ctx.recordingResults ?? []).filter(result => !result.acknowledged).length;
  if (!unread) return { id: "failures", label: t("Troubleshooting", language) };
  return {
    id: "failures",
    label: t("Troubleshooting ({count})", language, { count: String(unread) }),
    accessibleLabel: unread === 1
      ? t("Troubleshooting, 1 unread recording failure", language)
      : t("Troubleshooting, {count} unread recording failures", language, { count: String(unread) }),
  };
}

const resultViews = new WeakMap<RecordingResult, { key: string; view: RecordingResultView }>();
export function projectResult(result: RecordingResult, state: RecordingState, ctx: AppContext, now: Date, format: DateFormats): RecordingResultView {
  const language = ctx.language;
  // The zone too: a row's time and day are local, and the system zone can change while the app runs (review batch 2).
  const key = `${language}:${ctx.platform}:${format.zone}:${localDay(now)}:${state.type}:${state.type === "needsPermission" && state.needsRelaunch}`;
  const previous = resultViews.get(result);
  if (previous?.key === key) return previous.view;
  const view: RecordingResultView = {
      id: result.id,
      code: result.code,
      outcomeState: result.outcome,
      reason: failureReason(result.code, language),
      day: dayHeading(new Date(result.occurredAt), now, language, format),
      time: shortTime(new Date(result.occurredAt), language, format),
      outcome: failureOutcome(result, language), guidance: ctx.platform === "darwin" && result.restored && isPermissionFailure(result.code)
        ? t("This failure is from an earlier session. Check recording permissions before trying again.", language)
        : failureGuidance(result.code, language, ctx.platform),
      persistenceWarning: result.persistenceFailed ? persistenceWarning(result.persistenceFailed, language) : "",
      ...(result.saving ? { saving: t("Saving this change…", language) } : {}),
      detail: result.detail,
      ...((result.partialPath ?? result.recordingPath) ? { file: result.partialPath ?? result.recordingPath, fileName: path.basename(result.partialPath ?? result.recordingPath!) } : {}),
      acknowledged: result.acknowledged,
      actions: resultActions(state, ctx, result).map(({ action: _action, ...choice }) => choice),
  };
  resultViews.set(result, { key, view });
  return view;
}

export function resultActions(state: RecordingState, ctx: AppContext, result: RecordingResult): Array<SettingsChoice & { action: AppAction }> {
  const actions: Array<SettingsChoice & { action: AppAction }> = [];
  const add = (id: RecordingResultAction, label: PlainMessageKey, enabled: boolean): void => {
    actions.push({ id, label: t(label, ctx.language), checked: false, enabled,
      action: { recordingResult: { id: result.id, action: id } } });
  };
  if (result.outcome === "partial" && result.partialPath) add("reveal", "Show partial recording", true);
  if (isOutputFolderFailure(result.code))
    add("folder", "Change output folder", preferencesUnlocked(state) && result.outcome !== "pending");
  if (ctx.platform === "darwin" && isPermissionFailure(result.code)) {
    add("permission", "Open System Settings", preferencesUnlocked(state));
    if (!result.restored || (state.type === "needsPermission" && state.needsRelaunch))
      add("relaunch", "Relaunch", preferencesUnlocked(state) && result.outcome !== "pending");
  }
  // Retrying cannot overwrite unreadable or newer history, so it is not offered there.
  if (result.persistenceFailed && result.persistenceFailed !== "blocked") add("retry", "Retry saving the record", true);
  if (!result.acknowledged) add("acknowledge", "Got it", result.outcome !== "pending");
  else add("remove", "Remove from history", true);
  return actions;
}
