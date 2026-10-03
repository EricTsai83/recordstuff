/**
 * Window activation in `pnpm acceptance:settings` (plan 057). The page draws
 * no focus line while its window is inactive (plan 047), and on macOS
 * `BrowserWindow.focus()` does not take activation back from another app. A
 * case that depends on an active window is therefore judged only when the
 * fixture saw its window active when the case started and when it was judged,
 * with no blur between; otherwise it did not run, and the round is blocked,
 * as a locked session makes it, instead of failed. Shared by the fixture,
 * which records, and the runner, which classifies.
 */

/** What main and the page say about the fixture's window at one moment. */
export interface WindowState {
  /** `BrowserWindow.isFocused()`. */
  focused: boolean;
  /** `BrowserWindow.isVisible()`. */
  visible: boolean;
  /** The page's `data-window`: "inactive" from a blur until the next focus, "" when unset, "unreadable" when the page did not answer. */
  page: string;
}

/** Activation around one case; `frontmost` is read only when it did not hold. */
export interface Activation {
  held: boolean;
  before: WindowState;
  after: WindowState;
  /** Blur events between `before` and `after`. */
  blurs: number;
  frontmost?: string | undefined;
}

export interface SettingsCase {
  name: string;
  /** False for a case that did not run. */
  ok: boolean;
  detail: string;
  /** Why an activation-dependent case was not judged. */
  notRun?: string;
  /** Recorded for every activation-dependent case, judged or not. */
  activation?: Activation;
}

/** Written by the fixture when it stopped before its last case. */
export interface FixtureFailure {
  error: string;
  /** The file whose `capturePage()` threw, when a capture stopped the round. */
  screenshot?: string;
  /** The window at the moment the capture threw. */
  window?: WindowState | undefined;
  /** Whether the fixture had already shown and activated its window, so it was meant to be active. */
  shown?: boolean;
  frontmost?: string | undefined;
}

export type SettingsOutcome = "pass" | "fail" | "blocked";

export const windowActive = (state: WindowState): boolean => state.focused && state.visible && state.page !== "inactive";

export function activation(before: WindowState, after: WindowState, blurs: number, frontmost?: () => string | undefined): Activation {
  const held = windowActive(before) && windowActive(after) && blurs === 0;
  return { held, before, after, blurs, ...(held ? {} : { frontmost: frontmost?.() }) };
}

const describe = (state: WindowState): string =>
  `focused ${state.focused}, visible ${state.visible}, data-window ${state.page || "unset"}`;

export function notRunReason(active: Activation): string {
  const when = !windowActive(active.before) ? `was not active when the case started (${describe(active.before)})`
    : active.blurs > 0 ? `lost activation during the case (${active.blurs} blur event${active.blurs === 1 ? "" : "s"}; then ${describe(active.after)})`
      : `was not active when the case was judged (${describe(active.after)})`;
  return `the window ${when}; frontmost app: ${active.frontmost ?? "unknown"}`;
}

/** A case that ran on an active window keeps its pass or fail; any other did not run. */
export function judgeActive(name: string, active: Activation, ok: boolean, detail: string): SettingsCase {
  return active.held ? { name, ok, detail, activation: active } : { name, ok: false, detail, notRun: notRunReason(active), activation: active };
}

/** A capture that threw while the window was meant to be active but was not is blocked; any other stop is a failure. */
export function failureBlocked(failure: FixtureFailure): boolean {
  return failure.screenshot !== undefined && failure.shown === true && failure.window !== undefined && !windowActive(failure.window);
}

/** The fixture exits 0 when every case passed, 1 when it finished otherwise and 2 when it stopped early. */
export function expectedFixtureExit(cases: SettingsCase[], failure: FixtureFailure | undefined): 0 | 1 | 2 {
  return failure ? 2 : cases.length > 0 && cases.every(result => result.ok) ? 0 : 1;
}

export function settingsOutcome(input: {
  cases: SettingsCase[];
  failure?: FixtureFailure | undefined;
  /** The fixture's exit code; `null` when it ended by signal. */
  exit: number | null;
  /** The runner saw no spawn error, timeout or interruption, and the process group is gone. */
  processClean: boolean;
  locked: boolean;
}): { outcome: SettingsOutcome; reasons: string[] } {
  const { cases, failure } = input;
  const unclean = input.processClean ? [] : ["the fixture's process did not exit cleanly; see cleanup.json"];
  // A lock blocks the round, but a fixture left running is still named.
  if (input.locked) return { outcome: "blocked", reasons: ["the screen locked during the round", ...unclean] };
  const failed = cases.filter(result => !result.ok && !result.notRun);
  const notRun = cases.filter(result => result.notRun);
  const reasons: string[] = [...unclean];
  const expected = expectedFixtureExit(cases, failure);
  if (input.exit !== expected) reasons.push(`the fixture exited ${input.exit ?? "by signal"}, not ${expected}`);
  if (failed.length) reasons.push(`${failed.length} case${failed.length === 1 ? "" : "s"} failed`);
  if (failure && !failureBlocked(failure)) reasons.push(`the fixture stopped: ${failure.screenshot ? `capturing ${failure.screenshot}: ` : ""}${failure.error}`);
  if (!failure && cases.length === 0) reasons.push("the fixture recorded no cases");
  if (reasons.length) return { outcome: "fail", reasons };
  const blocked: string[] = [];
  if (notRun.length) blocked.push(`${notRun.length} case${notRun.length === 1 ? "" : "s"} did not run because the window was not active`);
  if (failure) blocked.push(`capturing ${failure.screenshot} failed while the window was not active (${describe(failure.window!)}; frontmost app: ${failure.frontmost ?? "unknown"}): ${failure.error}`);
  return blocked.length ? { outcome: "blocked", reasons: blocked } : { outcome: "pass", reasons: [] };
}

/** The app name in `lsappinfo info -only name <asn>` output. */
export function lsappinfoName(info: string): string | undefined {
  return /"(?:LSDisplayName|CFBundleName)"="([^"]*)"/.exec(info)?.[1] ?? (info.trim() || undefined);
}
