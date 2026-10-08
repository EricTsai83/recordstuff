/** The Failures tab: which rows are open, the action each row is running, and its paging. */
import { persistsHistory } from "../../../shared/recording-result";
import type { SettingsView } from "../../../shared/settings-panel";
import {
  announce,
  announced,
  draw,
  focus,
  render,
  selectedTab,
  text,
  view,
} from "./core";

export const resultStates = new Map<
  string,
  { open: boolean; acknowledged: boolean }
>();
export const resultIntents = new Map<
  string,
  { action: string; control: string; moved: boolean }
>();
export const resultErrors = new Set<string>();
export let historyPending = false;
export const resultDomId = (id: string): string =>
  `recording-result-${encodeURIComponent(id)}`;
export async function chooseResult(
  id: string,
  action: string,
  control: string,
): Promise<void> {
  const offered = view?.recordingResults?.find((r) => r.id === id);
  if (!offered || resultIntents.has(id) || offered.saving) return;
  // Record the origin before anything can change focus.
  const intent = { action, control, moved: false };
  resultIntents.set(id, intent);
  resultErrors.delete(id);
  if (persistsHistory(action)) announce(text("Saving this change…"));
  draw();
  let applied = false;
  let offeredAfter = true;
  try {
    const result = await window.settings.choose(
      `recordingResult:${id}`,
      action,
    );
    render(result.view);
    applied = result.applied;
    // A reveal whose file is gone changes the row instead: the button left with it, so there is nothing to retry.
    offeredAfter = Boolean(
      result.view.recordingResults
        ?.find((r) => r.id === id)
        ?.actions.some((choice) => choice.id === action),
    );
  } catch {
    /* Keep the current projection; main owns the state. */
  }
  resultIntents.delete(id);
  if (!applied && offeredAfter) {
    resultErrors.add(id);
    announce(text("Could not complete this action. Try again."));
  } else if (announced() === text("Saving this change…")) announce("");
  draw();
  restoreResultFocus(id, intent);
}
/** Summary after acknowledgement, collapse or failure; the active tab after the last row. Never steals. */
function restoreResultFocus(
  id: string,
  intent: { action: string; control: string; moved: boolean },
): void {
  if (intent.moved || !document.hasFocus()) return;
  const control = document.getElementById(intent.control);
  const active = document.activeElement;
  if (active && active !== document.body && active !== control) return;
  const area = document.getElementById(resultDomId(id)) as HTMLElement | null;
  if (
    control &&
    resultStates.get(id)?.open &&
    !persistsHistory(intent.action)
  ) {
    control.focus({ preventScroll: true });
    return;
  }
  const target =
    area?.querySelector<HTMLElement>(".result-summary") ??
    document.querySelector<HTMLElement>(".result-summary") ??
    document.getElementById(`tab-${selectedTab}`);
  target?.focus({ preventScroll: true });
}
/**
 * Carries each row's open state into the new projection: a row just acknowledged closes, a removed row is forgotten,
 * and an explicit entry opens the row it brings into view. Returns the ids the projection now holds.
 */
export function reconcileResults(
  next: SettingsView,
  entering: boolean,
): Set<string> {
  for (const result of next.recordingResults ?? []) {
    const old = resultStates.get(result.id);
    resultStates.set(result.id, {
      open:
        old && !(result.acknowledged && !old.acknowledged) ? old.open : false,
      acknowledged: result.acknowledged,
    });
  }
  const resultIds = new Set(next.recordingResults?.map((item) => item.id));
  for (const id of resultStates.keys())
    if (!resultIds.has(id)) {
      resultStates.delete(id);
      resultErrors.delete(id);
    }
  if (entering && selectedTab === "failures") {
    const target =
      next.recordingResults?.find((result) => !result.acknowledged) ??
      next.recordingResults?.[0];
    for (const [id, state] of resultStates) state.open = id === target?.id;
  }
  return resultIds;
}
export function toggleResult(id: string, open: boolean): void {
  const state = resultStates.get(id);
  if (state && state.open !== open) {
    state.open = open;
    draw();
  }
}
export async function historyMore(): Promise<void> {
  if (historyPending) return;
  const button = document.getElementById("history-more");
  historyPending = true;
  draw();
  const known = new Set(view?.recordingResults?.map((r) => r.id));
  try {
    const result = await window.settings.choose("history", "more");
    const owned = document.activeElement === button;
    render(result.view);
    if (owned && !view?.recordingResultsRemaining && document.hasFocus()) {
      const loaded =
        view?.recordingResults?.find((r) => !known.has(r.id)) ??
        view?.recordingResults?.at(-1);
      focus(
        loaded ? `${resultDomId(loaded.id)}-summary` : `tab-${selectedTab}`,
      );
    }
  } catch {
    announce(text("Could not complete this action. Try again."));
  } finally {
    historyPending = false;
    draw();
  }
}
