import type { RecordingState } from "../../shared/state";

/**
 * Settings that touch a live capture may change only while the recorder is
 * settled. Both interfaces and the action handler use this same rule.
 */
export function preferencesUnlocked(state: RecordingState): boolean {
  return state.type === "idle" || state.type === "needsPermission";
}
