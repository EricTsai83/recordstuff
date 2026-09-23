import type { DisplayFailure, DisplayInfo, DisplayPreference } from "../shared/display";
import type { ErrorCode } from "../shared/state";

export type DisplayResolution = { ok: true; id: string; label: string } | { ok: false; detail: DisplayFailure };
export function resolveDisplayPreference({ displays, primaryDisplayId, preference }: {
  displays: readonly DisplayInfo[]; primaryDisplayId: string; preference: DisplayPreference;
}): DisplayResolution {
  if (preference.kind === "primary") return { ok: true, id: primaryDisplayId, label: displays.find((d) => d.id === primaryDisplayId)?.label ?? "" };
  const matches = displays.filter((d) => d.id === preference.id);
  return matches.length === 1 ? { ok: true, id: preference.id, label: matches[0]!.label } : { ok: false, detail: "target_missing" };
}
type Source = { display_id: string };
export type Selection<S> = { ok: true; source: S; rule: "primary" | "first" | "exact" } | { ok: false; code: ErrorCode; detail: DisplayFailure };
export function selectScreenSource<S extends Source>({ sources, resolution, preference }: {
  sources: readonly S[]; resolution: DisplayResolution; preference: DisplayPreference;
}): Selection<S> {
  if (preference.kind === "primary") {
    const exact = resolution.ok ? sources.find((s) => s.display_id === resolution.id) : undefined;
    const source = exact ?? sources[0];
    return source ? { ok: true, source, rule: exact ? "primary" : "first" } : { ok: false, code: "no_display", detail: "source_missing" };
  }
  if (!resolution.ok) return { ok: false, code: "display_unavailable", detail: resolution.detail };
  const matches = sources.filter((s) => s.display_id === resolution.id);
  return matches.length === 1 ? { ok: true, source: matches[0]!, rule: "exact" } : { ok: false, code: "display_unavailable", detail: "source_missing" };
}

/** One owner per recorder attempt. Cancellation settles callbacks even if enumeration hangs. */
export class DisplayRequest<S extends Source> {
  private cancelled = false;
  private pending = new Set<() => void>();
  private delays = new Map<ReturnType<typeof setTimeout>, () => void>();
  constructor(private readonly deps: {
    preference: DisplayPreference;
    snapshot: () => { displays: DisplayInfo[]; primaryDisplayId: string; generation: number };
    getSources: () => Promise<S[]>;
    platform: NodeJS.Platform;
    selected: (source: S, rule: string, attempt: number, resolution: DisplayResolution) => void;
    denied: (code: ErrorCode, detail: DisplayFailure, attempt: number) => void;
  }) {}
  cancel(): void {
    this.cancelled = true;
    for (const finish of this.pending) finish();
    for (const [timer, resolve] of this.delays) { clearTimeout(timer); resolve(); }
    this.delays.clear();
  }
  async run(callback: (source?: S) => void): Promise<void> {
    let done = false;
    const finish = (source?: S): void => {
      if (done) return;
      done = true;
      this.pending.delete(cancel);
      callback(source);
    };
    const cancel = (): void => finish();
    this.pending.add(cancel);
    const deny = (code: ErrorCode, detail: DisplayFailure, attempt: number): void => {
      if (!this.cancelled) this.deps.denied(code, detail, attempt);
      finish();
    };
    const preference = this.deps.preference;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (this.cancelled) { finish(); return; }
      const before = this.deps.snapshot();
      const resolution = resolveDisplayPreference({ ...before, preference });
      if (!resolution.ok) { deny("display_unavailable", resolution.detail, attempt); return; }
      let sources: S[];
      try { sources = await this.deps.getSources(); }
      catch {
        deny(this.deps.platform === "darwin" ? "permission_denied" : "no_display", "source_missing", attempt);
        return;
      }
      if (this.cancelled) { finish(); return; }
      const after = this.deps.snapshot();
      const current = resolveDisplayPreference({ ...after, preference });
      if (!current.ok) { deny("display_unavailable", current.detail, attempt); return; }
      const result = selectScreenSource({ sources, resolution, preference });
      const changed = preference.kind === "display" && before.generation !== after.generation;
      if (!changed && result.ok) {
        this.deps.selected(result.source, result.rule, attempt, resolution);
        finish(result.source);
        return;
      }
      const detail = changed ? "topology_changed" : "source_missing";
      if (preference.kind === "primary" || attempt === 3) {
        deny(preference.kind === "primary" ? "no_display" : "display_unavailable", detail, attempt);
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.delays.delete(timer); resolve(); }, 150);
        this.delays.set(timer, resolve);
      });
    }
  }
}

/** Both projections use the same availability and historical diagnostic. */
export function displayResolution(displays: DisplayInfo[], preference: DisplayPreference): DisplayResolution {
  return resolveDisplayPreference({ displays, preference, primaryDisplayId: displays.find((d) => d.primary)?.id ?? "" });
}
