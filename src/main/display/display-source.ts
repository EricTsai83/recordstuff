import type { DisplayFailure, DisplayInfo, DisplayPreference } from "../../shared/display";
import type { ScreenAccess } from "../../shared/protocol";
import type { ErrorCode } from "../../shared/state";

export type DisplayResolution = { ok: true; id: string; label: string } | { ok: false; detail: DisplayFailure };
/**
 * The one display under `id`, or undefined when none or several have it: an id two displays share names neither.
 * Recording, the Screen row and the way back to Primary display all choose by this rule, so they always agree.
 */
export function uniqueDisplay(displays: readonly DisplayInfo[], id: string): DisplayInfo | undefined {
  const matches = displays.filter((d) => d.id === id);
  return matches.length === 1 ? matches[0] : undefined;
}
export function resolveDisplayPreference({ displays, primaryDisplayId, preference }: {
  displays: readonly DisplayInfo[]; primaryDisplayId: string; preference: DisplayPreference;
}): DisplayResolution {
  if (preference.kind === "primary") return { ok: true, id: primaryDisplayId, label: displays.find((d) => d.id === primaryDisplayId)?.label ?? "" };
  const display = uniqueDisplay(displays, preference.id);
  return display ? { ok: true, id: preference.id, label: display.label } : { ok: false, detail: "target_missing" };
}
type Source = { display_id: string };
export type Selection<S> = { ok: true; source: S; rule: "primary" | "exact" } | { ok: false; code: ErrorCode; detail: DisplayFailure };
export function selectScreenSource<S extends Source>({ sources, resolution, preference }: {
  sources: readonly S[]; resolution: DisplayResolution; preference: DisplayPreference;
}): Selection<S> {
  if (preference.kind === "primary") {
    const matches = resolution.ok ? sources.filter(s => s.display_id === resolution.id) : [];
    return matches.length === 1 ? { ok: true, source: matches[0]!, rule: "primary" } : { ok: false, code: "no_display", detail: "source_missing" };
  }
  if (!resolution.ok) return { ok: false, code: "display_unavailable", detail: resolution.detail };
  const matches = sources.filter((s) => s.display_id === resolution.id);
  return matches.length === 1 ? { ok: true, source: matches[0]!, rule: "exact" } : { ok: false, code: "display_unavailable", detail: "source_missing" };
}

/**
 * How long one resolution took (plan 089 step 1): each enumeration with what it listed and the displays present
 * after it, and the whole request from its start to its answer. A refusal's wait is read from here, not inferred.
 */
export interface ResolutionTiming {
  enumerations: { ms: number; sources: number | "error"; displays: number }[];
  /** The engine's answer on the screen grant (plan 089, D1) and when it came; "unanswered" when asked but not yet answered. */
  access?: { answer: ScreenAccess; ms: number } | "unanswered";
  totalMs: number;
}
export function describeResolutionTiming({ enumerations, access, totalMs }: ResolutionTiming): string {
  const calls = enumerations.map(({ ms, sources, displays }) =>
    `${Math.round(ms)} ms (${sources === "error" ? "threw" : `${sources} source(s)`}, ${displays} display(s))`);
  const engine = access === undefined ? "" : access === "unanswered" ? "; engine access unanswered" : `; engine access ${access.answer} ${Math.round(access.ms)} ms`;
  return `timing ${calls.length ? calls.join(", ") : "no enumeration"}${engine}; total ${Math.round(totalMs)} ms`;
}

/** One owner per recorder attempt. Cancellation settles callbacks even if enumeration hangs. */
export class DisplayRequest<S extends Source> {
  private cancelled = false;
  private pending = new Set<() => void>();
  private delays = new Map<ReturnType<typeof setTimeout>, () => void>();
  private readonly now: () => number;
  constructor(private readonly deps: {
    preference: DisplayPreference;
    snapshot: () => { displays: DisplayInfo[]; primaryDisplayId: string; generation: number };
    getSources: () => Promise<S[]>;
    platform: NodeJS.Platform;
    selected: (source: S, rule: string, attempt: number, resolution: DisplayResolution, timing: ResolutionTiming) => void;
    denied: (code: ErrorCode, detail: DisplayFailure, attempt: number, timing: ResolutionTiming) => void;
    /** Something threw outside the expected refusals; the request is still answered without a source. */
    failed?: (cause: unknown, timing: ResolutionTiming) => void;
    /** Monotonic milliseconds; injectable for tests. */
    now?: () => number;
  }) {
    this.now = deps.now ?? (() => performance.now());
  }
  cancel(): void {
    this.cancelled = true;
    for (const finish of this.pending) finish();
    this.endDelays();
  }
  private endDelays(): void {
    for (const [timer, resolve] of this.delays) { clearTimeout(timer); resolve(); }
    this.delays.clear();
  }
  /**
   * Answers `callback` once. `screenAccess`, on macOS, asks the engine whether the screen grant holds (plan 089, D1):
   * it is asked alongside the first enumeration, and its refusal ends the request at once, whichever comes first.
   */
  async run(callback: (source?: S) => void, screenAccess?: (displayId: string) => Promise<ScreenAccess>): Promise<void> {
    let done = false;
    const finish = (source?: S): void => {
      if (done) return;
      done = true;
      this.pending.delete(cancel);
      callback(source);
    };
    const cancel = (): void => finish();
    this.pending.add(cancel);
    const began = this.now();
    const enumerations: ResolutionTiming["enumerations"] = [];
    let access: ResolutionTiming["access"];
    const timing = (): ResolutionTiming => ({ enumerations: [...enumerations], ...(access ? { access } : {}), totalMs: this.now() - began });
    // Settles only on the engine's refusal: a grant, an unknown answer or a failure leaves the enumeration to decide.
    let engineDenied: Promise<"denied"> | undefined;
    const ask = (displayId: string): void => {
      if (engineDenied || !screenAccess || this.deps.platform !== "darwin") return;
      access = "unanswered";
      const asked = this.now();
      engineDenied = new Promise((resolve) => {
        void screenAccess(displayId).then((answer) => {
          access = { answer, ms: this.now() - asked };
          if (answer === "denied") resolve("denied");
        }, () => { access = { answer: "unknown", ms: this.now() - asked }; });
      });
    };
    const deny = (code: ErrorCode, detail: DisplayFailure, attempt: number): void => {
      if (!this.cancelled) this.deps.denied(code, detail, attempt, timing());
      finish();
    };
    // An unanswered request would only surface as the capture-request timeout
    // two minutes later, so whatever happens the callback is called once.
    try {
      await this.attempts(finish, deny, enumerations, timing, ask, () => engineDenied);
    } catch (cause) {
      try { this.deps.failed?.(cause, timing()); }
      catch { /* The answer below still goes out. */ }
    } finally {
      finish();
    }
  }
  private async attempts(
    finish: (source?: S) => void,
    deny: (code: ErrorCode, detail: DisplayFailure, attempt: number) => void,
    enumerations: ResolutionTiming["enumerations"],
    timing: () => ResolutionTiming,
    ask: (displayId: string) => void,
    engineDenied: () => Promise<"denied"> | undefined,
  ): Promise<void> {
    const preference = this.deps.preference;
    /** Whether the displays changed during any enumeration of this request: its empty answers get every retry. */
    let unsettled = false;
    /** `work`'s result, or "denied" as soon as the engine refuses the grant. */
    const unlessDenied = <T>(work: Promise<T>): Promise<T | "denied"> => {
      const denied = engineDenied();
      return denied ? Promise.race([work, denied]) : work;
    };
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (this.cancelled) return;
      const before = this.deps.snapshot();
      const resolution = resolveDisplayPreference({ ...before, preference });
      if (!resolution.ok) { deny("display_unavailable", resolution.detail, attempt); return; }
      ask(resolution.id);
      let sources: S[] | "denied";
      const called = this.now();
      try { sources = await unlessDenied(this.deps.getSources()); }
      catch (cause) {
        if (this.cancelled) return;
        enumerations.push({ ms: this.now() - called, sources: "error", displays: this.deps.snapshot().displays.length });
        this.deps.failed?.(cause, timing());
        deny("capture_start_failed", "source_missing", attempt);
        return;
      }
      if (this.cancelled) return;
      if (sources === "denied") { deny("permission_denied", "source_missing", attempt); return; }
      const after = this.deps.snapshot();
      enumerations.push({ ms: this.now() - called, sources: sources.length, displays: after.displays.length });
      const current = resolveDisplayPreference({ ...after, preference });
      if (!current.ok) { deny("display_unavailable", current.detail, attempt); return; }
      const result = selectScreenSource({ sources, resolution, preference });
      const changed = before.generation !== after.generation || current.id !== resolution.id;
      unsettled ||= changed;
      if (!changed && result.ok) {
        this.deps.selected(result.source, result.rule, attempt, resolution, timing());
        finish(result.source);
        return;
      }
      const detail = changed ? "topology_changed" : "source_missing";
      // Displays exist but capture lists none: on macOS the screen grant was revoked while getMediaAccessStatus keeps
      // reporting it (System Settings' "Later"), not a missing display. Each such answer takes about 3 s (plan 089
      // step 1), so it is refused at the first one (D1) unless the displays changed during this request, which the
      // retries are for.
      const revoked = sources.length === 0 && this.deps.platform === "darwin" && after.displays.length > 0;
      if (revoked && (!unsettled || attempt === 3)) { deny("permission_denied", detail, attempt); return; }
      if (attempt === 3) { deny(preference.kind === "primary" ? "no_display" : "display_unavailable", detail, attempt); return; }
      const waited = await unlessDenied(new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.delays.delete(timer); resolve(); }, 150);
        this.delays.set(timer, resolve);
      }));
      if (this.cancelled) return;
      if (waited === "denied") { this.endDelays(); deny("permission_denied", "source_missing", attempt); return; }
    }
  }
}

/**
 * Whether "Use Primary display" can be offered as the way back from an unavailable display: one primary
 * display exists, under an id no other display shares. Settings and the tray offer it by the same rule.
 */
export function primaryDisplayChoosable(displays: readonly DisplayInfo[]): boolean {
  return displays.some((d) => d.primary && uniqueDisplay(displays, d.id) !== undefined);
}

/** Whether the saved display is available now, and why not; the tray and Settings both project it, so they always agree. */
export function displayResolution(displays: DisplayInfo[], preference: DisplayPreference): DisplayResolution {
  return resolveDisplayPreference({ displays, preference, primaryDisplayId: displays.find((d) => d.primary)?.id ?? "" });
}
