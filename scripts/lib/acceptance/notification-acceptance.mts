/**
 * Pure helpers for `pnpm acceptance:notification` (scripts/acceptance-notification.mts):
 * the AppleScript that presses the app's banner in Notification Center, the
 * expected localized banner body, and the verdict for one notification click: since
 * 2026-10-04 the saved banner opens Settings on Recordings with that recording, so a click
 * passes when RecordStuff is in front with Settings focused and the app named the file.
 * Kept free of I/O so the judgement is unit-tested (notification-acceptance.test.ts).
 */
import path from "node:path";

export const FINDER_STATES = ["closed", "behind", "minimized"] as const;
export type FinderState = (typeof FINDER_STATES)[number];
export type Language = "en" | "zh-TW";

/** Where the frontmost application ended up after the click, and whether RecordStuff's Settings has focus. */
export interface ClickObservation {
  /** Frontmost app when the sampling window closed (about 3 s after the click). */
  finalFront: string;
  /** Distinct frontmost apps seen during the window, in order. */
  fronts: string[];
  /** RecordStuff's focused window was its Settings window when the sampling window closed. */
  settingsFocused: boolean;
  /**
   * The page's focus is a recording card's play button (its accessible name starts with "Play "), read through
   * Accessibility after rendering: the renderer, not only main's log line, took the Recordings entry.
   */
  recordingFocused: boolean;
  /** What Accessibility reported as focused, `role: name`, kept for the report. */
  focusedName?: string;
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

/**
 * A click passes only when RecordStuff is frontmost at the end of the window with Settings focused
 * *and* the app logged the Recordings entry for the file it saved. The two are recorded separately in
 * `reasons` so a partial result is legible, as plan 014 asked of the earlier Finder reveal.
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
  if (!observation.appLog.some((line) => line.endsWith(`show last recording: Recordings with ${savedPath}`))) {
    reasons.push("no Recordings entry was logged for this saved file");
  }
  const expected = expectedBannerBody(savedPath, language);
  if (observation.bannerBody !== undefined && observation.bannerBody !== expected) {
    reasons.push(`banner body was "${observation.bannerBody}", expected "${expected}"`);
  }
  if (observation.finalFront !== "RecordStuff")
    reasons.push(`frontmost app after the click is ${observation.finalFront}, not RecordStuff`);
  else if (!observation.settingsFocused) reasons.push("RecordStuff is in front but its Settings window does not have focus");
  else if (!observation.recordingFocused) reasons.push("Settings is in front but focus is not on a recording in Recordings");
  return { ...base, verdict: reasons.length === 0 ? "pass" : "fail", reasons };
}

/** The accessible-name prefix of a Recordings card's play button (shared/i18n.ts "Play {title}"). */
export function playPrefix(language: Language): string {
  return language === "zh-TW" ? "播放 " : "Play ";
}

/** Callback evidence is separate from the entry, and tied to this save. */
export function clickDelivered(o: Pick<ClickObservation, "appLog">, body: string): boolean {
  return o.appLog.some((line) => line.endsWith(`notification: clicked: ${body}`));
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

/**
 * RecordStuff's front window title, or "" when it shows none: the Settings window a saved banner opens.
 * One line, read through Accessibility.
 */
export const RECORDSTUFF_WINDOW_SCRIPT = `tell application "System Events"
if not (exists process "RecordStuff") then return ""
tell process "RecordStuff"
if (count of windows) = 0 then return ""
return name of window 1
end tell
end tell`;

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
