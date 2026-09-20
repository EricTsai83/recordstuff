/**
 * Pure helpers for `pnpm acceptance:notification` (scripts/acceptance-notification.mts):
 * the AppleScript that presses the app's banner in Notification Center, the
 * expected localized banner body, and the verdict for one notification click.
 * Kept free of I/O so the judgement is unit-tested (notification-acceptance.test.ts).
 */
import path from "node:path";

export const FINDER_STATES = ["closed", "behind", "minimized"] as const;
export type FinderState = (typeof FINDER_STATES)[number];
export type Language = "en" | "zh-TW";

/** Where the frontmost application ended up after the click, plus what Finder shows. */
export interface ClickObservation {
  /** Frontmost app when the sampling window closed (about 3 s after the click). */
  finalFront: string;
  /** Distinct frontmost apps seen during the window, in order. */
  fronts: string[];
  /** POSIX path Finder's `selection` reports, or undefined (empty on macOS 26 while the list lacks keyboard focus). */
  selected: string | undefined;
  /** File name of the selected row read from Finder's Accessibility tree, or undefined. */
  selectedRow: string | undefined;
  /** Folder shown by Finder's front window, or undefined. */
  windowTarget: string | undefined;
  /** Banner body text read from Notification Center before pressing it. */
  bannerBody: string | undefined;
  /** App log lines emitted after `saved` (notification/reveal diagnostics). */
  appLog: string[];
}

export type Verdict = "pass" | "fail" | "not-run";

export interface CaseResult {
  language: Language;
  finderState: FinderState;
  /** 1-based click index within one app process. The bug rarely shows on the first click. */
  click: number;
  savedPath: string | undefined;
  observation: ClickObservation | undefined;
  verdict: Verdict;
  reasons: string[];
}

/** `Saved a.mp4` / `已儲存 a.mp4` — the saved notification body from shared/i18n.ts. */
export function expectedBannerBody(savedPath: string, language: Language): string {
  const file = path.basename(savedPath);
  return language === "zh-TW" ? `已儲存 ${file}` : `Saved ${file}`;
}

/** `/private/tmp/x` and `/tmp/x` are the same file to Finder; compare after stripping `/private`. */
export function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string): string => p.replace(/^\/private(?=\/)/, "").replace(/\/+$/, "");
  return norm(a) === norm(b);
}

/**
 * A click passes only when Finder is frontmost at the end of the window *and*
 * the selected file is the one the app saved. "Finder selected the file" and
 * "Finder is in front" are recorded separately in `reasons` so a partial result
 * is legible (plan 014 asks for the two to be reported apart).
 */
export function judgeClick(
  language: Language,
  finderState: FinderState,
  click: number,
  savedPath: string | undefined,
  observation: ClickObservation | undefined,
): CaseResult {
  const base = { language, finderState, click, savedPath, observation };
  if (!savedPath) return { ...base, verdict: "not-run", reasons: ["the recording was not saved"] };
  if (!observation)
    return {
      ...base,
      verdict: "not-run",
      reasons: ["the banner was not found in Notification Center (grouped, hidden or already gone)"],
    };
  const reasons: string[] = [];
  if (!clickDelivered(observation, observation.bannerBody ?? expectedBannerBody(savedPath, language))) {
    reasons.push("no click callback was logged for this saved notification");
  }
  if (!observation.appLog.some((line) =>
    line.endsWith(`notification: reveal requested ${savedPath}`) ||
    line.endsWith(`notification: reveal repeated after activation ${savedPath}`))) {
    reasons.push("no successful reveal request was logged for this saved file");
  }
  const expected = expectedBannerBody(savedPath, language);
  if (observation.bannerBody !== undefined && observation.bannerBody !== expected) {
    reasons.push(`banner body was "${observation.bannerBody}", expected "${expected}"`);
  }
  if (!fileSelected(savedPath, observation)) {
    reasons.push(
      `Finder does not show the saved file selected (selection ${observation.selected ?? "empty"}, row ${observation.selectedRow ?? "none"}, window ${observation.windowTarget ?? "none"})`,
    );
  }
  if (observation.finalFront !== "Finder")
    reasons.push(`frontmost app after the click is ${observation.finalFront}, not Finder`);
  return { ...base, verdict: reasons.length === 0 ? "pass" : "fail", reasons };
}

/** Callback evidence is separate from reveal success, and tied to this save. */
export function clickDelivered(o: Pick<ClickObservation, "appLog">, body: string): boolean {
  return o.appLog.some((line) => line.endsWith(`notification: clicked: ${body}`));
}

/**
 * The saved file counts as selected when Finder's `selection` names it, or when
 * the front window shows its folder and the selected row carries its name. On
 * macOS 26 `selection` came back empty right after a reveal even though the row
 * was highlighted and the path bar showed the file, so the Accessibility row is
 * the primary evidence and `selection` the secondary one.
 */
export function fileSelected(
  savedPath: string,
  o: Pick<ClickObservation, "selected" | "selectedRow" | "windowTarget">,
): boolean {
  if (samePath(o.selected, savedPath)) return true;
  return o.selectedRow === path.basename(savedPath) && samePath(o.windowTarget, path.dirname(savedPath));
}

/** Finder setup before a click: no windows, a window behind the front app, or a minimized one. */
export function finderSetupScript(state: FinderState): string {
  switch (state) {
    case "closed":
      return 'return ""';
    case "behind":
      return 'tell application "Finder" to return id of (make new Finder window to home)';
    case "minimized":
      return 'tell application "Finder"\nset w to make new Finder window to home\nset collapsed of w to true\nreturn id of w\nend tell';
  }
}

/** Finder's selection as a POSIX path, or "" — one line, no trailing newline. */
export const FINDER_SELECTION_SCRIPT = `tell application "Finder"
try
return POSIX path of (item 1 of (get selection as alias list))
end try
return ""
end tell`;

/** Folder of Finder's front window as a POSIX path (with trailing slash), or "". */
export const FINDER_TARGET_SCRIPT = `tell application "Finder"
try
return POSIX path of (target of front Finder window as alias)
end try
return ""
end tell`;

/**
 * File name of the selected row in Finder's front window, read through
 * Accessibility: the first non-empty text under the first cell of the row whose
 * `selected` is true. "" when no window or no selected row. About 2 s.
 */
export const FINDER_SELECTED_ROW_SCRIPT = `on textIn(e, depth)
  tell application "System Events"
    try
      set v to value of e
      if class of v is text and v is not "" then return v
    end try
    if depth < 6 then
      try
        repeat with c in UI elements of e
          set t to my textIn(c, depth + 1)
          if t is not "" then return t
        end repeat
      end try
    end if
  end tell
  return ""
end textIn
on findRow(e, depth)
  tell application "System Events"
    try
      if (role of e) is "AXRow" then
        if selected of e then return my textIn(UI element 1 of e, 0)
        return ""
      end if
    end try
    if depth < 12 then
      try
        repeat with c in UI elements of e
          set t to my findRow(c, depth + 1)
          if t is not "" then return t
        end repeat
      end try
    end if
  end tell
  return ""
end findRow
tell application "System Events" to tell process "Finder"
  if (count of windows) = 0 then return ""
  set w to window 1
end tell
return my findRow(w, 0)`;

/**
 * Press the banner whose title is `title` and whose body is exactly `body`.
 * Notification Center on macOS 26 exposes each banner or stacked alert as a
 * group with subrole AXNotificationCenterBanner/AXNotificationCenterAlert whose
 * children carry the title and body as `name`; the depth varies with stacking,
 * so the tree is searched generically. Matching on the body means a stale banner
 * from an earlier save is never pressed for the current click. Returns
 * `pressed<TAB><body>` or `not found`. Requires Accessibility access.
 */
export function pressBannerScript(title: string, body: string, press = true): string {
  const q = (v: string): string => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `property traceLines : {}
on traceLine(t)
  if (count of traceLines) < 150 then set end of traceLines to t
end traceLine
on traceText()
  set AppleScript's text item delimiters to linefeed
  return traceLines as text
end traceText
on hasNames(e, wantTitle, wantBody)
  set gotTitle to false
  set gotBody to false
  tell application "System Events"
    repeat with k in UI elements of e
      try
        set n to name of k as text
        my traceLine("name=" & n)
        if n is wantTitle then set gotTitle to true
        if n is wantBody then set gotBody to true
      on error message number code
        my traceLine("name error " & code & ": " & message)
      end try
    end repeat
  end tell
  return gotTitle and gotBody
end hasNames
on findBanner(e, depth, wantTitle, wantBody)
  tell application "System Events"
    try
      set sr to subrole of e as text
      my traceLine("depth=" & depth & " subrole=" & sr)
      if sr starts with "AXNotificationCenter" then
        if my hasNames(e, wantTitle, wantBody) then return e
        return missing value
      end if
    end try
    if depth < 8 then
      try
        repeat with c in UI elements of e
          set r to my findBanner(c, depth + 1, wantTitle, wantBody)
          if r is not missing value then return r
        end repeat
      on error message number code
        my traceLine("children error " & code & ": " & message)
      end try
    end if
  end tell
  return missing value
end findBanner
tell application "System Events" to tell process "NotificationCenter"
  my traceLine("windows=" & (count windows))
  repeat with w in windows
    set b to my findBanner(w, 0, "${q(title)}", "${q(body)}")
    if b is not missing value then
      ${press ? 'perform action "AXPress" of b' : 'my traceLine("matching banner found; observation only")'}
      ${press ? `return "pressed" & tab & "${q(body)}"` : 'return my traceText()'}
    end if
  end repeat
  return "not found" & linefeed & my traceText()
end tell`;
}

/**
 * Summarize results for the report. The run is ok when nothing failed and every
 * language × Finder state has at least two passing clicks: the bug rarely showed
 * on the first click of a process, so a group whose later clicks all went
 * unjudged (banner not shown) proves little. Not-run clicks are counted, not
 * hidden, so a flaky Notification Center is visible in the report.
 */
export function summarize(results: readonly CaseResult[]): {
  pass: number;
  fail: number;
  notRun: number;
  /** Language/Finder groups with fewer than two passing clicks (the run needs every group covered). */
  uncovered: string[];
  ok: boolean;
} {
  const pass = results.filter((r) => r.verdict === "pass").length;
  const fail = results.filter((r) => r.verdict === "fail").length;
  const notRun = results.filter((r) => r.verdict === "not-run").length;
  const groups = new Map<string, number>();
  for (const r of results) {
    const key = `${r.language}/${r.finderState}`;
    groups.set(key, (groups.get(key) ?? 0) + (r.verdict === "pass" ? 1 : 0));
  }
  const uncovered = [...groups.entries()].filter(([, passes]) => passes < 2).map(([key]) => key);
  return { pass, fail, notRun, uncovered, ok: fail === 0 && groups.size > 0 && uncovered.length === 0 };
}
